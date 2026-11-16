package com.danmuku.bplayer.android

import android.app.Service
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import com.arthenica.ffmpegkit.FFmpegKit
import com.arthenica.ffmpegkit.FFmpegKitConfig
import com.arthenica.ffmpegkit.FFprobeKit
import com.arthenica.ffmpegkit.ReturnCode
import org.json.JSONObject
import java.io.File
import java.util.UUID

internal object AudioWorkerProtocol {
  const val PROBE = 1
  const val CONVERT = 2
  const val CANCEL = 3
  const val PROGRESS = 10
  const val DONE = 11
  const val ERROR = 12
}

internal class AudioWorkerLifecycle {
  private var state = 0
  val running: Boolean get() = state == 0
  val retiring: Boolean get() = state == 1
  val released: Boolean get() = state == 2
  fun finish(nativeActive: Boolean): Boolean {
    if (!running) return false
    state = if (nativeActive) 1 else 3
    return true
  }
  fun release(): Boolean {
    if (released || running) return false
    state = 2
    return true
  }
}

internal object AudioWorkerValidation {
  const val MAX_AUDIO_BYTES = 512L * 1024 * 1024
  const val OUTPUT_SENTINEL_BYTES = MAX_AUDIO_BYTES + 65536L
  fun outputSize(bytes: Long): Boolean = bytes in 1..MAX_AUDIO_BYTES
  fun jobId(value: String): String {
    require(UUID.fromString(value).toString() == value) { "Invalid job identifier" }
    return value
  }
  fun input(value: String): String {
    require(value.length in 1..16384 && value.none { it.code < 32 || it.code == 127 })
    if (value.startsWith("http://")) {
      val uri = java.net.URI(value)
      require(uri.scheme == "http" && uri.host == "127.0.0.1" && uri.port in 1..65535 && uri.rawQuery == null && uri.rawFragment == null && uri.rawUserInfo == null)
      require(Regex("/[A-Za-z0-9_-]{16,128}/[A-Za-z0-9_=-]{1,12000}").matches(uri.rawPath))
    } else {
      require(value.startsWith("/sdcard/") || value.startsWith("/storage/") || value.startsWith("/data/user/") || value.startsWith("/data/data/"))
      require(value.split('/').none { it == "." || it == ".." } && !value.contains('\\'))
      require(File(value).isFile)
    }
    return value
  }
  fun metadata(value: String): List<String> {
    require(value.length <= 16384)
    val json = JSONObject(value)
    require(json.length() <= 20)
    val args = mutableListOf<String>()
    json.keys().forEach { key ->
      require(Regex("bplayer_[a-z0-9_]{1,48}").matches(key))
      val item = json.getString(key)
      require(item.length <= 1024 && item.none { it.code < 32 || it.code == 127 })
      args.add("-metadata"); args.add("$key=$item")
    }
    return args
  }
  fun duration(probe: JSONObject, index: Int): Double? {
    val streams = probe.optJSONArray("streams") ?: return null
    val audio = (0 until streams.length()).map { streams.getJSONObject(it) }.filter { it.optString("codec_type") == "audio" }
    require(index in audio.indices) { "Audio track missing" }
    return positive(audio[index].opt("duration"))
  }
  fun positive(value: Any?): Double? = value?.toString()?.toDoubleOrNull()?.takeIf { it.isFinite() && it > 0 }
  fun output(probe: JSONObject, expected: Double?, upper: Double?): Boolean {
    val streams = probe.optJSONArray("streams") ?: return false
    if (streams.length() != 1) return false
    val audio = streams.getJSONObject(0)
    if (audio.optString("codec_type") != "audio" || audio.optString("codec_name") != "aac" || audio.optInt("channels") != 2) return false
    val duration = positive(audio.opt("duration")) ?: positive(probe.optJSONObject("format")?.opt("duration")) ?: return false
    if (expected != null && kotlin.math.abs(duration - expected) > maxOf(2.0, expected * 0.005)) return false
    if (upper != null && duration > upper + maxOf(2.0, upper * 0.005)) return false
    return true
  }
}

class AudioDecodeService : Service() {
  private val main = Handler(Looper.getMainLooper())
  private var active: Job? = null
  private var destroyed = false
  private inner class Job(val id: String, val input: String, val index: Int, val durationUs: Long, val tags: List<String>, val client: Messenger, val convert: Boolean) {
    var sessionId: Long? = null
    val lifecycle = AudioWorkerLifecycle()
    val finished: Boolean get() = !lifecycle.running
    val retiring: Boolean get() = lifecycle.retiring
    var removeAfterExit = false
    var ownsOutput = false
    var terminalMessage: String? = null
    var terminalResult: String? = null
    var expected: Double? = null
    var upper: Double? = null
    var lastProgress = 0L
    val output = File(cacheDir, "audio-transcode/$id.mka")
    val death = IBinder.DeathRecipient { main.post { cancel(this) } }
    val timeout = Runnable { fail(this, "音轨任务超时，已取消") }
    val probeTimeout = Runnable { fail(this, "音轨信息读取超时，已取消") }
    val outputLimit = object : Runnable {
      override fun run() {
        if (!current(this@Job) || !ownsOutput) return
        if (output.length() > AudioWorkerValidation.MAX_AUDIO_BYTES) fail(this@Job, "音轨缓存超过 512 MiB 限制，已取消")
        else main.postDelayed(this, 500L)
      }
    }
    val retireTimeout = Runnable { if (active === this && retiring) { if (ownsOutput) runCatching { output.delete() }; terminateIsolated() } }
  }
  private val messenger = Messenger(Handler(Looper.getMainLooper()) { message ->
    when (message.what) {
      AudioWorkerProtocol.PROBE, AudioWorkerProtocol.CONVERT -> start(message)
      AudioWorkerProtocol.CANCEL -> active?.takeIf { it.id == message.data.getString("jobId") }?.let { cancel(it) }
    }
    true
  })
  override fun onCreate() {
    super.onCreate()
    val staging = File(cacheDir, "audio-transcode").canonicalFile
    if (staging.parentFile == cacheDir.canonicalFile) {
      staging.listFiles()?.filter { file ->
        Regex("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\\.mka").matches(file.name) &&
          java.nio.file.Files.isRegularFile(file.toPath(), java.nio.file.LinkOption.NOFOLLOW_LINKS) && file.canonicalFile.parentFile == staging
      }?.forEach { file -> runCatching { file.delete() } }
    }
    FFmpegKitConfig.setSessionHistorySize(1)
    FFmpegKitConfig.enableLogCallback { _ -> }
  }
  override fun onBind(intent: Intent?): IBinder = messenger.binder

  private fun start(message: Message) {
    val client = message.replyTo ?: return
    val data = message.data
    val id = data.getString("jobId") ?: return
    if (active != null || destroyed) { send(client, AudioWorkerProtocol.ERROR, id, "音轨任务正忙，请稍后重试"); return }
    val job = try {
      AudioWorkerValidation.jobId(id)
      val input = AudioWorkerValidation.input(data.getString("input") ?: "")
      val index = data.getInt("audioIndex", 0)
      require(index in 0..127)
      val duration = data.getLong("durationUs", 0)
      require(duration >= 0)
      val tags = AudioWorkerValidation.metadata(data.getString("tags") ?: "{}")
      Job(id, input, index, duration, tags, client, message.what == AudioWorkerProtocol.CONVERT)
    } catch (_: Exception) { send(client, AudioWorkerProtocol.ERROR, id, "音轨任务参数无效"); return }
    active = job
    try { client.binder.linkToDeath(job.death, 0) } catch (_: Exception) { cancel(job); return }
    main.postDelayed(job.timeout, if (job.convert) 30 * 60 * 1000L else 30000L)
    probe(job, job.input) { json ->
      if (!job.convert) { complete(job, json.toString()); return@probe }
      try {
        job.expected = AudioWorkerValidation.duration(json, job.index)
        job.upper = AudioWorkerValidation.positive(json.optJSONObject("format")?.opt("duration"))
        if (job.expected == null && job.durationUs > 0 && job.upper == null) job.upper = job.durationUs / 1_000_000.0
        convert(job)
      } catch (_: Exception) { fail(job, "未找到选中的音轨") }
    }
  }
  private fun current(job: Job): Boolean = !destroyed && active === job && !job.finished

  private fun probe(job: Job, input: String, ready: (JSONObject) -> Unit) {
    if (!current(job)) return
    main.postDelayed(job.probeTimeout, 30000L)
    try {
      val session = FFprobeKit.executeWithArgumentsAsync(arrayOf("-v", "error", "-probesize", "2097152", "-analyzeduration", "3000000", "-show_streams", "-show_format", "-of", "json", input)) { result ->
        main.post {
          if (active === job && job.retiring && job.sessionId == result.sessionId) { release(job); return@post }
          if (!current(job) || job.sessionId != result.sessionId) return@post
          job.sessionId = null
          main.removeCallbacks(job.probeTimeout)
          if (!ReturnCode.isSuccess(result.returnCode)) { fail(job, "无法读取音轨信息，请检查文件与网络"); return@post }
          try {
            val output = result.output ?: ""
            if (output.length > 128 * 1024) { fail(job, "音轨元数据过大，无法安全传输"); return@post }
            ready(JSONObject(output))
          } catch (_: Exception) { fail(job, "音轨信息无效或超出限制") }
        }
      }
      job.sessionId = session.sessionId
    } catch (_: Exception) { fail(job, "音轨信息读取未能启动") }
  }
  private fun convert(job: Job) {
    if (!current(job)) return
    try {
      job.output.parentFile?.mkdirs()
      require(!job.output.exists())
      job.ownsOutput = true
      main.postDelayed(job.outputLimit, 500L)
      val args = mutableListOf("-hide_banner", "-nostdin", "-v", "error", "-n", "-probesize", "2097152", "-analyzeduration", "3000000", "-i", job.input,
        "-map", "0:a:${job.index}", "-vn", "-sn", "-dn", "-map_metadata", "-1", "-c:a", "aac", "-profile:a", "aac_low", "-ac", "2", "-b:a", "192k", "-af", "asetpts=PTS-STARTPTS", "-fs", AudioWorkerValidation.OUTPUT_SENTINEL_BYTES.toString())
      args.addAll(job.tags); args.addAll(listOf("-f", "matroska", job.output.absolutePath))
      val session = FFmpegKit.executeWithArgumentsAsync(args.toTypedArray(), { result ->
        main.post {
          if (active === job && job.retiring && job.sessionId == result.sessionId) { release(job); return@post }
          if (!current(job) || job.sessionId != result.sessionId) return@post
          job.sessionId = null
          if (!ReturnCode.isSuccess(result.returnCode) || !job.output.isFile || !AudioWorkerValidation.outputSize(job.output.length())) { fail(job, "音轨转换失败，未保留不完整缓存"); return@post }
          probe(job, job.output.absolutePath) { json ->
            if (!AudioWorkerValidation.output(json, job.expected, job.upper)) { fail(job, "转换后的音轨验证失败"); return@probe }
            complete(job, JSONObject().put("path", job.output.absolutePath).put("size", job.output.length()).put("probe", json).put("durationVerified", job.expected != null).toString())
          }
        }
      }, { _ -> }, { statistics ->
        main.post {
          if (!current(job)) return@post
          if (statistics.size > AudioWorkerValidation.MAX_AUDIO_BYTES) { fail(job, "音轨缓存超过 512 MiB 限制，已取消"); return@post }
          val now = android.os.SystemClock.elapsedRealtime()
          if (now - job.lastProgress < 500) return@post
          job.lastProgress = now
          val duration = job.expected ?: job.upper
          val percent = if (duration == null) -1.0 else (statistics.time / (duration * 10)).coerceIn(0.0, 99.9)
          event(job, AudioWorkerProtocol.PROGRESS, Bundle().apply { putDouble("percent", percent); putLong("written", statistics.size.coerceAtLeast(0)) })
        }
      })
      job.sessionId = session.sessionId
    } catch (_: Exception) { fail(job, "音轨转换未能启动") }
  }
  private fun event(job: Job, type: Int, data: Bundle) {
    if (!current(job)) return
    data.putString("jobId", job.id)
    try { job.client.send(Message.obtain(null, type).apply { this.data = data }) } catch (_: Exception) { cancel(job) }
  }
  private fun complete(job: Job, result: String) {
    if (!current(job)) return
    job.terminalResult = result
    finish(job, false)
  }
  private fun fail(job: Job, message: String) {
    if (!current(job)) return
    job.terminalMessage = message
    finish(job, true)
  }
  private fun cancel(job: Job) {
    if (!current(job)) return
    job.terminalMessage = "音轨任务已取消"
    finish(job, true)
  }
  private fun finish(job: Job, remove: Boolean) {
    if (!job.lifecycle.finish(job.sessionId != null)) return
    job.removeAfterExit = remove
    main.removeCallbacks(job.timeout); main.removeCallbacks(job.probeTimeout); main.removeCallbacks(job.outputLimit)
    if (job.sessionId != null) {
      runCatching { FFmpegKit.cancel(job.sessionId!!) }
      main.postDelayed(job.retireTimeout, 3000L)
    } else release(job)
  }
  private fun release(job: Job) {
    if (active !== job || !job.lifecycle.release()) return
    active = null; job.sessionId = null
    main.removeCallbacks(job.retireTimeout)
    runCatching { job.client.binder.unlinkToDeath(job.death, 0) }
    if (job.removeAfterExit && job.ownsOutput) runCatching { job.output.delete() }
    if (destroyed) return
    val result = job.terminalResult
    if (result != null) {
      runCatching { job.client.send(Message.obtain(null, AudioWorkerProtocol.DONE).apply {
        data = Bundle().apply { putString("jobId", job.id); putString("result", result) }
      }) }
    } else job.terminalMessage?.let { send(job.client, AudioWorkerProtocol.ERROR, job.id, it) }
  }
  private fun send(client: Messenger, type: Int, id: String, message: String) {
    runCatching { client.send(Message.obtain(null, type).apply { data = Bundle().apply { putString("jobId", id); putString("message", message) } }) }
  }
  override fun onDestroy() {
    destroyed = true
    active?.let { job ->
      job.sessionId?.let { runCatching { FFmpegKit.cancel(it) } }
      if (job.ownsOutput) runCatching { job.output.delete() }
    }
    main.removeCallbacksAndMessages(null)
    super.onDestroy()
    terminateIsolated()
  }
  private fun terminateIsolated() {
    val name = if (android.os.Build.VERSION.SDK_INT >= 28) android.app.Application.getProcessName() else {
      val manager = getSystemService(ACTIVITY_SERVICE) as android.app.ActivityManager
      manager.runningAppProcesses?.firstOrNull { it.pid == android.os.Process.myPid() }?.processName
    }
    if (name == "$packageName:audio_transcode") android.os.Process.killProcess(android.os.Process.myPid())
  }
}
