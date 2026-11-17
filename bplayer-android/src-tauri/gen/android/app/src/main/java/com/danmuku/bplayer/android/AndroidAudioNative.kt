package com.danmuku.bplayer.android

import android.content.Context
import android.net.Uri
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.io.Closeable
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

internal object AudioRequestArguments {
  fun cancelJob(args: JSONObject): String = if (args.isNull("jobId")) "" else UUID.fromString(args.getString("jobId")).toString()
}

@androidx.annotation.Keep
internal class AndroidAudioNative(context: Context, private val webView: WebView) : Closeable {
  private val context = context.applicationContext
  private val executor = ThreadPoolExecutor(1, 1, 30, TimeUnit.SECONDS, LinkedBlockingQueue(16),
    { task -> Thread(task, "audio-task").apply { isDaemon = true } })
  private data class Task(val session: String, val cancellation: AudioCancellation)
  private data class Permit(val jobId: String, val session: String, val video: String, val audioIndex: Int,
    val stat: RemoteStat, val identity: String, val offset: Double, val duration: Double?, val exactDuration: Boolean, val created: Long)
  private val tasks = ConcurrentHashMap<String, Task>()
  private val permits = ConcurrentHashMap<String, Permit>()
  private val cancelled = ConcurrentHashMap.newKeySet<String>()
  private val cancelledJobs = ConcurrentHashMap.newKeySet<String>()
  @Volatile private var worker: AudioWorkerClient? = null
  @Volatile private var closed = false
  @Volatile private var foreground = true

  @JavascriptInterface
  fun request(id: String, command: String, argsJson: String) {
    if (closed || id.length > 256) return
    webView.post {
      if (closed || !trustedPage()) return@post
      if (argsJson.length > 65536 || command !in setOf("audio_probe", "audio_prepare", "audio_start", "audio_cancel", "audio_cache_files")) {
        reply(id, false, "不支持或过大的音轨请求"); return@post
      }
      val args = runCatching { JSONObject(argsJson) }.getOrElse { reply(id, false, "音轨请求格式不正确"); return@post }
      if (command == "audio_cancel") {
        runCatching { cancel(args) }.fold({ reply(id, true, it) }, { reply(id, false, "音轨取消请求不正确") })
        return@post
      }
      if (!foreground) { reply(id, false, "应用不在前台，音轨任务已暂停，请重新选择音轨"); return@post }
      try {
        executor.execute {
          try {
            val session = session(args)
            if (closed || cancelled.contains(session)) throw NetworkFailure("播放会话已结束")
            when (command) {
              "audio_probe" -> task(session) { jobId, cancellation ->
                AudioSourceAccess(context, args.getString("path"), cancellation).use { source ->
                  val stat = source.stat()
                  if (stat.kind != "file" || stat.size <= 0) throw NetworkFailure("视频不是有效文件")
                  val probe = probe(source, args.getString("path"), jobId, cancellation)
                  reply(id, true, AudioMedia.normalized(probe))
                }
              }
              "audio_prepare" -> task(session) { jobId, cancellation ->
                val video = args.getString("videoPath")
                val index = args.getInt("audioIndex")
                if (index !in 0..127) throw NetworkFailure("音轨序号超出范围")
                AudioSourceAccess(context, video, cancellation).use { source ->
                  val stat = source.stat()
                  val identity = source.identity(stat)
                  val raw = probe(source, video, UUID.randomUUID().toString(), cancellation)
                  val selected = AudioMedia.streams(raw).filter { it.optString("codec_type") == "audio" }.getOrNull(index)
                    ?: throw NetworkFailure("音轨序号不存在")
                  val exact = AudioMedia.seconds(selected.opt("duration"))?.takeIf { it > 0 }
                  val duration = exact ?: AudioMedia.duration(raw)
                  val offset = AudioMedia.offset(raw, index)
                  val target = source.target(index)
                  val cachedStat = source.stat(target)
                  if (cachedStat.kind == "file") {
                    if (cachedStat.size <= 0 || cachedStat.size > AudioMedia.MAX_AUDIO_BYTES) throw NetworkFailure("同名音轨缓存无效，原缓存已保留")
                    val cached = probe(source, target, UUID.randomUUID().toString(), cancellation)
                    val validity = AudioMedia.validCache(cached, identity, index, duration, stat.modifiedMs, cachedStat.modifiedMs, exact != null)
                      ?: throw NetworkFailure("同名音轨缓存与当前影片不匹配，原缓存已保留，请检查缓存冲突")
                    source.unchanged(stat, identity)
                    reply(id, true, JSONObject().put("jobId", jobId).put("target", target).put("cached", true)
                      .put("offset", validity.second).put("legacy", validity.first))
                  } else {
                    if (video.startsWith("/@network/") && stat.modifiedMs == null) throw NetworkFailure("服务器未提供文件修改时间，无法安全写入同目录音轨缓存")
                    source.unchanged(stat, identity)
                    permits.entries.removeIf { System.currentTimeMillis() - it.value.created > 120000 }
                    if (permits.size >= 16) throw NetworkFailure("待处理音轨任务过多，请重新打开影片")
                    permits[jobId] = Permit(jobId, session, video, index, stat, identity, offset, duration, exact != null, System.currentTimeMillis())
                    reply(id, true, JSONObject().put("jobId", jobId).put("target", target).put("cached", false).put("offset", offset))
                  }
                }
              }
              "audio_start" -> {
                val permit = permits.remove(args.getString("jobId")) ?: throw NetworkFailure("音轨准备已过期，请重新选择音轨")
                if (permit.session != session || System.currentTimeMillis() - permit.created > 120000) throw NetworkFailure("音轨任务不属于当前播放会话")
                start(id, permit)
              }
              "audio_cache_files" -> task(session) { _, cancellation ->
                AudioSourceAccess(context, args.getString("videoPath"), cancellation).use { source ->
                  reply(id, true, JSONArray(source.cacheFiles()))
                }
              }
            }
          } catch (error: Exception) { reply(id, false, safeNetworkError(error)) }
        }
      } catch (_: java.util.concurrent.RejectedExecutionException) { reply(id, false, "音轨请求过多，请稍后重试") }
    }
  }

  private fun session(args: JSONObject): String = UUID.fromString(args.getString("session")).toString()
  private fun trustedPage(): Boolean {
    val uri = Uri.parse(webView.url ?: return false)
    return uri.scheme == "http" && uri.host == "tauri.localhost" && (uri.port == -1 || uri.port == 80)
  }
  private fun client(): AudioWorkerClient {
    val existing = worker
    if (existing != null && !existing.isClosed) return existing
    existing?.close()
    return AudioWorkerClient(context).also { worker = it }
  }
  private fun probe(source: AudioSourceAccess, path: String, jobId: String, cancellation: AudioCancellation): JSONObject =
    client().call(AudioWorkerProtocol.PROBE, jobId, Bundle().apply { putString("input", source.input(path, true)) }, cancellation)

  private fun task(session: String, id: String = UUID.randomUUID().toString(), action: (String, AudioCancellation) -> Unit) {
    val cancellation = AudioCancellation()
    val task = Task(session, cancellation)
    if (tasks.putIfAbsent(id, task) != null) throw NetworkFailure("重复音轨任务")
    try {
      if (closed || !foreground || cancelled.contains(session) || cancelledJobs.contains(id)) cancellation.cancel()
      cancellation.check(); action(id, cancellation)
    } finally { tasks.remove(id, task) }
  }

  private fun start(requestId: String, permit: Permit) {
    var acknowledged = false
    try {
      task(permit.session, permit.jobId) { _, cancellation ->
        AudioMedia.checkSpace(context, permit.duration, !permit.video.startsWith("/@network/"))
        AudioSourceAccess(context, permit.video, cancellation).use { source ->
          source.unchanged(permit.stat, permit.identity)
          if (source.stat(source.target(permit.audioIndex)).kind == "file") throw NetworkFailure("同名音轨缓存已存在，请重新选择音轨以验证缓存")
          reply(requestId, true, JSONObject().put("jobId", permit.jobId).put("target", source.target(permit.audioIndex)))
          acknowledged = true
          val output = File(context.cacheDir, "audio-transcode/${permit.jobId}.mka").canonicalFile
          try {
            val result = client().call(AudioWorkerProtocol.CONVERT, permit.jobId, Bundle().apply {
              putString("input", source.input())
              putInt("audioIndex", permit.audioIndex)
              putLong("durationUs", permit.duration?.let { (it * 1_000_000).toLong() } ?: 0L)
              putString("tags", AudioMedia.tags(permit.identity, permit.audioIndex, permit.offset).toString())
            }, cancellation, progress = { progress ->
              event("progress", permit, JSONObject().put("percent", progress.getDouble("percent", -1.0))
                .put("written", progress.getLong("written", 0)))
            }, assembling = { stage ->
              // 拼接阶段（裁段 / concat 重封装）没有百分比，单列事件让前端把胶囊换成「正在拼接音频…」。
              event("assembling", permit, JSONObject().put("stage", stage.getString("stage") ?: "")
                .put("frames", stage.getLong("frames", 0L)))
            })
            if (File(result.getString("path")).canonicalFile != output || !output.isFile) throw NetworkFailure("音轨服务返回了无效缓存路径")
            val validation = AudioMedia.validCache(result.getJSONObject("probe"), permit.identity, permit.audioIndex,
              permit.duration, permit.stat.modifiedMs, output.lastModified(), permit.exactDuration)
            if (validation == null || validation.first) throw NetworkFailure("转换后的音轨未通过完整性或归属验证")
            val path = source.publish(output, permit.audioIndex, permit.jobId, permit.stat, permit.identity)
            event("done", permit, JSONObject().put("path", path).put("offset", permit.offset))
          } finally { if (output.isFile) output.delete() }
        }
      }
    } catch (error: Exception) {
      if (!acknowledged) reply(requestId, false, safeNetworkError(error))
      else event(if (cancelled.contains(permit.session)) "cancelled" else "error", permit,
        JSONObject().put("message", safeNetworkError(error)))
    }
  }

  private fun cancel(args: JSONObject): Boolean {
    val session = session(args)
    val job = AudioRequestArguments.cancelJob(args)
    if (job.isEmpty()) cancelled.add(session) else cancelledJobs.add(UUID.fromString(job).toString())
    var changed = false
    tasks.entries.filter { it.value.session == session && (job.isEmpty() || it.key == job) }.forEach { (_, task) ->
      task.cancellation.cancel(); changed = true
    }
    permits.entries.filter { it.value.session == session && (job.isEmpty() || it.key == job) }.forEach { (id, permit) ->
      if (permits.remove(id, permit)) changed = true
    }
    return changed
  }
  private fun reply(id: String, ok: Boolean, value: Any?) {
    val envelope = JSONObject().put("ok", ok).put(if (ok) "result" else "error", value ?: JSONObject.NULL)
    javascript("window.__aAudioReply && window.__aAudioReply(${JSONObject.quote(id)},${envelope})")
  }
  private fun event(name: String, permit: Permit, data: JSONObject) {
    if (closed || cancelled.contains(permit.session) || cancelledJobs.contains(permit.jobId)) return
    data.put("jobId", permit.jobId).put("session", permit.session).put("video", permit.video).put("audioIndex", permit.audioIndex)
    javascript("window.__aAudioEvent && window.__aAudioEvent(${JSONObject.quote(name)},${data})")
  }
  private fun javascript(script: String) {
    webView.post { if (!closed && trustedPage()) webView.evaluateJavascript(script.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029"), null) }
  }
  fun setForeground(value: Boolean) {
    foreground = value
    if (!value) {
      tasks.values.forEach { it.cancellation.cancel() }
      permits.clear()
    }
  }
  override fun close() {
    closed = true
    tasks.values.forEach { it.cancellation.cancel() }
    permits.clear(); executor.shutdownNow(); worker?.close(); worker = null
  }
}
