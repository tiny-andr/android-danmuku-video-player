package com.danmuku.bplayer.android

import android.content.Context
import android.net.Uri
import android.os.Bundle
import android.util.Base64
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
  private val STREAM_MIME = "audio/mp4; codecs=\"mp4a.40.2\""
  private val executor = ThreadPoolExecutor(1, 1, 30, TimeUnit.SECONDS, LinkedBlockingQueue(16),
    { task -> Thread(task, "audio-task").apply { isDaemon = true } })
  private data class Task(val session: String, val cancellation: AudioCancellation)
  private data class Permit(val jobId: String, val session: String, val video: String, val audioIndex: Int,
    val stat: RemoteStat, val identity: String, val offset: Double, val duration: Double?, val exactDuration: Boolean, val created: Long, val copy: Boolean = false)
  private val tasks = ConcurrentHashMap<String, Task>()
  private val permits = ConcurrentHashMap<String, Permit>()
  private val streams = ConcurrentHashMap<String, StreamState>()
  private val readers = ConcurrentHashMap<String, AudioSourceAccess>()
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
      if (argsJson.length > 65536 || command !in setOf("audio_probe", "audio_prepare", "audio_start", "audio_cancel", "audio_cache_files", "network_subtitle", "audio_stream_open", "audio_stream_read", "audio_stream_close", "subtitle_reader", "subtitle_reader_close")) {
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
                  // 外壳刚做过 audio_probe，把时长和 PTS 起点带过来就不用再 ffprobe 一遍：
                  // 网络源上那一步是一两秒的纯等待，而这两个值探测时已经拿到了。
                  val hintDurationUs = args.optDouble("durationUs", 0.0)
                  val hintOffset = args.optDouble("offsetSecs", Double.NaN)
                  val raw = if (hintDurationUs > 0) null else probe(source, video, UUID.randomUUID().toString(), cancellation)
                  val selected = raw?.let {
                    AudioMedia.streams(it).filter { stream -> stream.optString("codec_type") == "audio" }.getOrNull(index)
                      ?: throw NetworkFailure("音轨序号不存在")
                  }
                  val exact = selected?.let { AudioMedia.seconds(it.opt("duration"))?.takeIf { value -> value > 0 } }
                  val duration = exact
                    ?: (if (hintDurationUs > 0) hintDurationUs / 1_000_000.0 else AudioMedia.duration(raw!!))
                  val offset = if (hintOffset.isFinite()) hintOffset else AudioMedia.offset(raw!!, index)
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
                    permits[jobId] = Permit(jobId, session, video, index, stat, identity, offset, duration, exact != null, System.currentTimeMillis(), args.optBoolean("copyAudio", false))
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
              // Embedded subtitles of a network video: the Rust extractor only understands real
              // file paths, so let the ffmpeg worker pull the track through the media proxy and
              // hand back a local srt file.
              "network_subtitle" -> task(session) { jobId, cancellation ->
                val video = args.getString("videoPath")
                val index = args.getInt("trackIndex")
                if (index !in 0..63) throw NetworkFailure("字幕轨序号超出范围")
                fun run(input: String) {
                  val format = if (args.optString("format") == "mkv") "mkv" else "srt"
                  val target = File(File(context.cacheDir, "subtitles").apply { mkdirs() }, "$jobId.$format")
                  val result = client().call(
                    AudioWorkerProtocol.EXTRACT_SUBTITLE, jobId,
                    Bundle().apply {
                      putString("input", input)
                      putInt("subtitleIndex", index)
                      putString("output", target.absolutePath)
                      putString("format", format)
                    },
                    cancellation
                  )
                  reply(id, true, result)
                }
                // Keep the media proxy alive for the whole extraction: it tears down with the source.
                val isHttp = video.startsWith("http://") || video.startsWith("https://")
                if (isHttp) run(video) else AudioSourceAccess(context, video, cancellation).use { run(it.input(video)) }
              }
              // Streaming audio for tracks the WebView cannot decode: ffmpeg writes fragmented
              // MP4 into cacheDir, the page pulls incrementally and feeds a MediaSource, so
              // sound starts in a second instead of after a full two-minute transcode.
              "audio_stream_open" -> {
                val videoPath = args.getString("videoPath")
                val index = args.getInt("audioIndex")
                if (index !in 0..127) throw NetworkFailure("音轨序号超出范围")
                openStream(id, session, videoPath, index, args.optDouble("startSecs", 0.0))
              }
              "audio_stream_read" -> {
                val state = streams[args.optString("streamId")] ?: throw NetworkFailure("音轨流已结束，请重新选择音轨")
                val (data, eof) = readStream(state)
                reply(id, true, JSONObject().put("data", data).put("eof", eof))
              }
              "audio_stream_close" -> {
                streams[args.optString("streamId")]?.let { closeStream(it) }
                reply(id, true, JSONObject.NULL)
              }
              // 网络源的内嵌字幕抽取：Rust 需要能随机读的字节源，这里给它一个本机媒体
              // 代理 URL（按 Range 取字节）。代理必须活到抽取结束，所以由 readerId 持有。
              "subtitle_reader" -> task(session) { readerId, cancellation ->
                val video = args.getString("videoPath")
                if (!video.startsWith("/@network/")) throw NetworkFailure("只有网络视频需要字幕读取器")
                val source = AudioSourceAccess(context, video, cancellation)
                try {
                  // 字幕稀疏抽取是"跳着读小块"：Rust 侧预取窗口只有 2048 字节，预读放大到
                  // 64 KiB 会让每次请求白拉 30 倍无用字节（实测把 65 秒拖成 82 秒）。
                  // 16 KiB 是 PositionedNetworkStream 的下限，正好覆盖窗口 + 块头。
                  // 工作池 8：Rust 侧并发预取实测在 4 路就饱和，多开只会占线程。
                  val url = source.input(video, prefetchBytes = 16 * 1024, workerThreads = 8)
                  val stat = source.stat()
                  if (stat.kind != "file" || stat.size <= 0) throw NetworkFailure("视频不是有效文件")
                  readers[readerId] = source
                  reply(id, true, JSONObject().put("readerId", readerId).put("url", url).put("size", stat.size))
                } catch (error: Exception) {
                  runCatching { source.close() }
                  throw error
                }
              }
              "subtitle_reader_close" -> {
                readers.remove(args.optString("readerId"))?.let { runCatching { it.close() } }
                reply(id, true, JSONObject.NULL)
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
              putBoolean("copy", permit.copy)
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

  // ---------------------------------------------------------------------------------------------
  // 流式音轨：ffmpeg 增量写碎片化 MP4，这里按 ISO-BMFF box 边界切块，页面拉去喂 MediaSource
  // ---------------------------------------------------------------------------------------------

  /**
   * 一路流式音轨。文件是边转边长的，读位置只增不减；`eof` 由 worker 的终态回调置位，
   * 之前读到的都是「当前已有」的字节，之后还要把尾巴读完才算结束。
   */
  private class StreamState(
    val id: String,
    val session: String,
    val file: File,
    val source: AudioSourceAccess,
    val cancellation: AudioCancellation
  ) {
    val splitter = AudioBoxSplitter()
    private var readOffset = 0L
    @Volatile var eof = false
    @Volatile var failure: String? = null
    @Volatile var started = false

    /** 把文件里新增的字节搬进切块器；返回是否搬到了数据。 */
    fun pump(): Boolean {
      val length = runCatching { file.length() }.getOrDefault(0L)
      if (length <= readOffset) return false
      val count = minOf(512L * 1024, length - readOffset).toInt()
      val bytes = ByteArray(count)
      val read = runCatching {
        java.io.RandomAccessFile(file, "r").use { input ->
          input.seek(readOffset)
          input.read(bytes)
        }
      }.getOrDefault(-1)
      if (read <= 0) return false
      readOffset += read
      splitter.feed(if (read == count) bytes else bytes.copyOf(read))
      return true
    }
  }

  /**
   * 增量切 ISO-BMFF box：init（ftyp+moov）必须单独、最先交出去，之后每个 moof+mdat 是一块。
   * 规则与 Windows 端 FragmentSplitter 相同；半个 box 交给 MSE 会直接报错，所以留在缓冲里等下一批。
   */
  private class AudioBoxSplitter {
    private var buffer = ByteArray(0)
    private var initBytes = ByteArray(0)
    private var fragBytes = ByteArray(0)
    private val ready = ArrayDeque<ByteArray>()
    private var overflowed = false

    fun feed(bytes: ByteArray) {
      if (bytes.isEmpty()) return
      buffer = if (buffer.isEmpty()) bytes else buffer + bytes
      // 防御：切成 1 秒一片时任何一块都不该到 MB 级，堆积说明 muxer 参数不对
      if (buffer.size > 32 * 1024 * 1024) { overflowed = true; buffer = ByteArray(0) }
    }

    fun take(): ByteArray? {
      while (true) {
        if (ready.isNotEmpty()) return ready.removeFirst()
        if (overflowed) return null
        val header = header(buffer) ?: return null
        if (buffer.size < header.second) return null
        val box = buffer.copyOfRange(0, header.second)
        buffer = buffer.copyOfRange(header.second, buffer.size)
        when {
          // 第一个 fragment 到来前攒到的都是 init：先交付它，再把 moof 放回队首重来
          header.first == "moof" && initBytes.isNotEmpty() -> {
            ready.addLast(initBytes); initBytes = ByteArray(0)
            buffer = box + buffer
          }
          header.first == "moof" -> fragBytes = if (fragBytes.isEmpty()) box else fragBytes + box
          // moof 之后的 mdat 收完就是一个完整 fragment
          header.first == "mdat" && fragBytes.isNotEmpty() -> {
            fragBytes += box
            ready.addLast(fragBytes); fragBytes = ByteArray(0)
          }
          fragBytes.isNotEmpty() -> fragBytes += box
          else -> initBytes += box
        }
      }
    }

    /** 返回 (type, 总长度)；数据不够判定时返回 null。 */
    private fun header(buf: ByteArray): Pair<String, Int>? {
      if (buf.size < 8) return null
      val size = ((buf[0].toInt() and 0xFF) shl 24) or ((buf[1].toInt() and 0xFF) shl 16) or
        ((buf[2].toInt() and 0xFF) shl 8) or (buf[3].toInt() and 0xFF)
      val type = String(buf, 4, 4, Charsets.US_ASCII)
      if (size == 1) {
        if (buf.size < 16) return null
        var large = 0L
        for (i in 8 until 16) large = (large shl 8) or (buf[i].toLong() and 0xFF)
        return if (large in 16..0x40000000L) type to large.toInt() else null
      }
      return if (size in 8..0x40000000) type to size else null
    }
  }

  private fun openStream(requestId: String, session: String, video: String, audioIndex: Int, startSecs: Double) {
    // 一个 app 同时只播一路声音：开新流一律顶掉旧的。旧流可能是上一次播放、或者页面重载
    // 之后 JS 侧已经忘记的那一路 —— 不在这里清掉，worker 会一直“音轨任务正忙”。
    streams.values.toList().forEach { closeStream(it) }
    val id = UUID.randomUUID().toString()
    val cancellation = AudioCancellation()
    val source = AudioSourceAccess(context, video, cancellation)
    val dir = File(context.cacheDir, "stream")
    if (!dir.isDirectory && !dir.mkdirs()) {
      source.close()
      throw NetworkFailure("无法建立音轨流缓存目录")
    }
    val output = File(dir, "$id.mp4")
    val state = StreamState(id, session, output, source, cancellation)
    streams[id] = state
    try {
      val dispatched = client().startStream(id, Bundle().apply {
        putString("input", source.input())
        putInt("audioIndex", audioIndex)
        putDouble("startSecs", startSecs)
        putString("output", output.absolutePath)
      }, cancellation, onStarted = { state.started = true }) { error ->
        if (error != null) state.failure = error
        state.eof = true
      }
      if (!dispatched) throw NetworkFailure("音轨服务未能启动")
      val deadline = System.currentTimeMillis() + 25000L
      while (!state.started && state.failure == null && !state.eof) {
        if (cancellation.cancelled) throw NetworkFailure("音轨流已取消")
        if (System.currentTimeMillis() > deadline) throw NetworkFailure("音轨流启动超时，请重试")
        Thread.sleep(20L)
      }
      state.failure?.let { throw NetworkFailure(it) }
      if (!state.started) throw NetworkFailure("音轨流未能开始输出")
      reply(requestId, true, JSONObject().put("id", id).put("mime", STREAM_MIME).put("startSecs", startSecs))
    } catch (error: Exception) {
      closeStream(state)
      throw error
    }
  }

  /**
   * 读一块可交给 MSE 的数据。返回值 `(base64, eof)`：base64 为空且 eof=false 表示
   * 「文件暂时没有新内容，过一会儿再来读」——转码刚起或网络源卡住时都会这样，页面重试即可。
   */
  private fun readStream(state: StreamState): Pair<String, Boolean> {
    val deadline = System.currentTimeMillis() + 400L
    while (true) {
      state.pump()
      state.splitter.take()?.let { return Base64.encodeToString(it, Base64.NO_WRAP) to false }
      if (state.eof) {
        // 终态之后再读一遍，把 ffmpeg 已经写好但还没搬走的尾巴交出去
        while (true) {
          val more = state.pump()
          val rest = state.splitter.take()
          if (rest != null) return Base64.encodeToString(rest, Base64.NO_WRAP) to false
          if (!more) break
        }
        state.failure?.let { throw NetworkFailure(it) }
        return "" to true
      }
      state.failure?.let { throw NetworkFailure(it) }
      if (System.currentTimeMillis() >= deadline) return "" to false
      Thread.sleep(20L)
    }
  }

  private fun closeStream(state: StreamState) {
    if (!streams.remove(state.id, state)) return
    state.eof = true
    state.cancellation.cancel()
    runCatching { worker?.stopStream(state.id) }
    runCatching { state.source.close() }
    runCatching { state.file.delete() }
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
    // 会话级取消（换轨 / 退出播放）要连流式音轨一起停：它没有 jobId，只有自己的 stream id。
    if (job.isEmpty()) {
      streams.values.filter { it.session == session }.toList().forEach { closeStream(it); changed = true }
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
      // 后台不转码：回到前台重新选音轨会再开一条，省电也省 CPU
      streams.values.toList().forEach { closeStream(it) }
      readers.values.forEach { runCatching { it.close() } }
      readers.clear()
    }
  }
  override fun close() {
    closed = true
    tasks.values.forEach { it.cancellation.cancel() }
    streams.values.toList().forEach { closeStream(it) }
    readers.values.forEach { runCatching { it.close() } }
    readers.clear()
    permits.clear(); executor.shutdownNow(); worker?.close(); worker = null
  }
}
