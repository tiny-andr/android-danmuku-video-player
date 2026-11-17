package com.danmuku.bplayer.android

import android.app.Service
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import android.os.SystemClock
import android.util.Log
import com.arthenica.ffmpegkit.FFmpegKit
import com.arthenica.ffmpegkit.FFmpegKitConfig
import com.arthenica.ffmpegkit.FFmpegSession
import com.arthenica.ffmpegkit.FFprobeKit
import com.arthenica.ffmpegkit.ReturnCode
import com.arthenica.ffmpegkit.Statistics
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.util.UUID
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException

internal object AudioWorkerProtocol {
  const val PROBE = 1
  const val CONVERT = 2
  const val CANCEL = 3

  /**
   * 网络视频的内嵌字幕抽取：输入是 media proxy 的 http URL，跑一次 `-map 0:s:N -f srt`。
   * 不走 Job/转码流程（没有进度、不写视频同目录），结果是一个 cacheDir 里的 srt 文件路径。
   */
  const val EXTRACT_SUBTITLE = 4

  /**
   * 流式转码：单进程把选中音轨编成碎片化 MP4（fMP4）写到 cacheDir/stream/<jobId>.mp4，
   * 前端边读边喂 MediaSource。与 [CONVERT] 的区别是没有进度百分比、不发布到视频同目录、
   * 输出允许是半截的（取消/seek 就靠“停掉再开一条”）。参数：input / audioIndex / startSecs / output。
   */
  const val STREAM = 5

  /** [STREAM] 已真正拉起 ffmpeg（输出文件路径随之返回），此后主进程可以开始增量读。 */
  const val STARTED = 14
  const val PROGRESS = 10
  const val DONE = 11
  const val ERROR = 12

  /**
   * 拼接阶段（裁 ADTS 段 + concat 重封装）。编码全部结束、进度已停在 99.9% 之后才发：
   * 复用 PROGRESS 会让前端继续按「转换中 N%」刷新（速率/ETA 也开始乱跳），所以单列一个消息类型。
   * payload: `stage`（见 [AudioAssembling]）+ `frames`（该阶段涉及/保留的 AAC 帧数，仅供诊断）。
   */
  const val ASSEMBLING = 13
}

/** [AudioWorkerProtocol.ASSEMBLING] 的 `stage` 取值。 */
internal object AudioAssembling {
  const val TRIM = "trim"       // 帧级裁剪（纯字节，工作线程）
  const val CONCAT = "concat"   // concat: 拼接 + 一次 -c copy 重封装成 mka
}

/**
 * 音轨分片并行编码参数。`SEGMENTS = 1` 即回退到改动前的单段整轨逻辑（设备 A/B 与回滚开关）。
 *
 * 每段编码成裸 ADTS AAC，按 AAC 帧（1024 样本）裁掉首帧 priming 与尾部填充帧，再用 ffmpeg 的
 * concat: 协议做字节级拼接并一次 `-c copy` 重封装成 mka。设计依据见 tmp/research/audio-parallel-design.md。
 */
internal object AudioSegmentation {
  const val FRAME_SAMPLES = 1024L
  const val SEGMENTS = 5
  const val NETWORK_SEGMENTS = 3
  const val MIN_SECONDS = 30.0
  private val rates = setOf(8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000, 64000, 88200, 96000)

  /** 只有输出采样率等于源采样率时，1024 样本边界的推算才成立；不支持就回退到单段。 */
  fun encoderRate(source: Int?): Int? = source?.takeIf { it in rates }

  fun count(input: String): Int =
    if (input.startsWith("http://")) minOf(SEGMENTS, NETWORK_SEGMENTS).coerceAtLeast(1) else SEGMENTS.coerceAtLeast(1)

  fun frames(samples: Long): Long = (samples + FRAME_SAMPLES - 1) / FRAME_SAMPLES

  /** 返回段边界（样本数，末段为估算总样本数，可能不是 1024 整数倍）。 */
  fun boundaries(totalSamples: Long, count: Int): LongArray? {
    if (count <= 1 || totalSamples <= 0) return null
    val totalFrames = Math.round(totalSamples.toDouble() / FRAME_SAMPLES)
    if (totalFrames < 2L * count) return null
    val edges = LongArray(count + 1)
    edges[0] = 0
    for (k in 1 until count) edges[k] = Math.round(totalFrames.toDouble() * k / count) * FRAME_SAMPLES
    edges[count] = totalSamples
    for (k in 1..count) if (edges[k] <= edges[k - 1]) return null
    return edges
  }
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
  private fun audioStreams(probe: JSONObject): List<JSONObject> =
    probe.optJSONArray("streams")?.let { array -> (0 until array.length()).map { array.getJSONObject(it) } }
      ?.filter { it.optString("codec_type") == "audio" } ?: emptyList()
  fun duration(probe: JSONObject, index: Int): Double? {
    val audio = audioStreams(probe)
    require(index in audio.indices) { "Audio track missing" }
    return positive(audio[index].opt("duration"))
  }
  fun sampleRate(probe: JSONObject, index: Int): Int? =
    audioStreams(probe).getOrNull(index)?.optInt("sample_rate", 0)?.takeIf { it > 0 }
  fun signed(value: Any?): Double? = value?.toString()?.toDoubleOrNull()?.takeIf { it.isFinite() }
  fun startTime(probe: JSONObject, index: Int): Double? = signed(audioStreams(probe).getOrNull(index)?.opt("start_time"))
  fun containerStart(probe: JSONObject): Double? = signed(probe.optJSONObject("format")?.opt("start_time"))
  fun positive(value: Any?): Double? = value?.toString()?.toDoubleOrNull()?.takeIf { it.isFinite() && it > 0 }
  fun output(probe: JSONObject, expected: Double?, upper: Double?, copy: Boolean = false): Boolean {
    val streams = probe.optJSONArray("streams") ?: return false
    if (streams.length() != 1) return false
    val audio = streams.getJSONObject(0)
    if (audio.optString("codec_type") != "audio") return false
    // copy 路径保留原编码（AC-3/E-AC-3，可能 5.1）；转码路径必须是 AAC 2ch。
    if (!copy && (audio.optString("codec_name") != "aac" || audio.optInt("channels") != 2)) return false
    val duration = positive(audio.opt("duration")) ?: positive(probe.optJSONObject("format")?.opt("duration")) ?: return false
    if (expected != null && kotlin.math.abs(duration - expected) > maxOf(2.0, expected * 0.005)) return false
    if (upper != null && duration > upper + maxOf(2.0, upper * 0.005)) return false
    return true
  }
}

/** 一段 ADTS 分段的裁剪结果：总帧数、实际保留帧数、保留字节数。 */
private class AdtsFrames(val totalFrames: Long, val keptFrames: Long, val length: Long)

class AudioDecodeService : Service() {
  private val main = Handler(Looper.getMainLooper())
  @Volatile private var active: Job? = null
  @Volatile private var stream: StreamJob? = null
  @Volatile private var destroyed = false

  /**
   * 一路流式转码。刻意不复用 [Job]：它没有进度、没有分片、没有发布流程，
   * 生命周期就是「ffmpeg 在跑 → 结束/取消/超时」，混进 Job 只会把两套状态机搅在一起。
   */
  private inner class StreamJob(
    val id: String,
    val input: String,
    val index: Int,
    val startSecs: Double,
    val output: File,
    val client: Messenger
  ) {
    var sessionId: Long? = null
    @Volatile var aborted = false
    @Volatile var finished = false
    val death = IBinder.DeathRecipient { main.post { abortStream(this) } }
    val timeout = Runnable { finishStream(this, "音轨流超时，已停止", true) }
  }

  private class Segment(val index: Int, val file: File, val startSample: Long, val endSample: Long,
    val rate: Int, val needFrames: Long) {
    var sessionId: Long? = null
    var done = false
    var timeMs = 0L
    var written = 0L
    var keptFrames = 0L
    val durationMs: Long = Math.round((endSample - startSample) * 1000.0 / rate)
  }

  private inner class Job(val id: String, val input: String, val index: Int, val durationUs: Long, val tags: List<String>, val client: Messenger, val convert: Boolean, val copy: Boolean = false) {
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
    var sampleRate = 0
    var audioStart = 0.0
    var containerStart = 0.0
    var lastProgress = 0L
    var written = 0L
    var assembling = false
    var executor: ExecutorService? = null
    @Volatile var aborted = false
    val output = File(cacheDir, "audio-transcode/$id.mka")
    val work = File(cacheDir, "audio-transcode/$id")
    val segments = mutableListOf<Segment>()
    val death = IBinder.DeathRecipient { main.post { cancel(this) } }
    val timeout = Runnable { fail(this, "音轨任务超时，已取消") }
    val probeTimeout = Runnable { fail(this, "音轨信息读取超时，已取消") }
    val outputLimit = object : Runnable {
      override fun run() {
        if (!current(this@Job) || !ownsOutput) return
        if (overLimit(this@Job)) { fail(this@Job, "音轨缓存超过 512 MiB 限制，已取消"); return }
        main.postDelayed(this, 500L)
      }
    }
    val retireTimeout = Runnable { if (active === this && retiring) { assembling = false; cleanup(this); terminateIsolated() } }

    fun sessions(): List<Long> = buildList {
      sessionId?.let { add(it) }
      segments.forEach { segment -> segment.sessionId?.let { add(it) } }
    }
  }

  private val messenger = Messenger(Handler(Looper.getMainLooper()) { message ->
    when (message.what) {
      AudioWorkerProtocol.PROBE, AudioWorkerProtocol.CONVERT -> start(message)
      AudioWorkerProtocol.STREAM -> startStream(message)
      AudioWorkerProtocol.EXTRACT_SUBTITLE -> extractSubtitle(message)
      AudioWorkerProtocol.CANCEL -> {
        val id = message.data.getString("jobId")
        active?.takeIf { it.id == id }?.let { cancel(it) }
        stream?.takeIf { it.id == id }?.let { abortStream(it) }
      }
    }
    true
  })

  override fun onCreate() {
    super.onCreate()
    // Extracted subtitles are throwaway; drop stale ones so the cache cannot grow forever.
    runCatching {
      File(cacheDir, "subtitles").listFiles()?.forEach { file ->
        if (file.isFile && file.name.endsWith(".srt") &&
          System.currentTimeMillis() - file.lastModified() > 24L * 60 * 60 * 1000) {
          runCatching { file.delete() }
        }
      }
    }
    val staging = File(cacheDir, "audio-transcode").canonicalFile
    val parent = cacheDir.canonicalFile
    val identifier = Regex("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")
    if (staging.parentFile == parent) {
      staging.listFiles()?.forEach { file ->
        if (file.canonicalFile.parentFile != staging) return@forEach
        val path = file.toPath()
        val name = file.name
        if (java.nio.file.Files.isRegularFile(path, java.nio.file.LinkOption.NOFOLLOW_LINKS) && name.endsWith(".mka") && identifier.matches(name.removeSuffix(".mka"))) {
          runCatching { file.delete() }
        } else if (java.nio.file.Files.isDirectory(path, java.nio.file.LinkOption.NOFOLLOW_LINKS) && identifier.matches(name)) {
          runCatching { file.deleteRecursively() }
        }
      }
    }
    // Stream fragments are throwaway too: only the session that created them can read them,
    // and a session never outlives the app process that owns it.
    runCatching {
      val streamDir = File(cacheDir, "stream").canonicalFile
      if (streamDir.parentFile == parent) {
        streamDir.listFiles()?.forEach { file ->
          if (file.canonicalFile.parentFile == streamDir && file.isFile && identifier.matches(file.name.removeSuffix(".mp4"))) {
            runCatching { file.delete() }
          }
        }
      }
    }
    FFmpegKitConfig.setSessionHistorySize(AudioSegmentation.SEGMENTS + 3)
    FFmpegKitConfig.enableLogCallback { _ -> }
  }

  override fun onBind(intent: Intent?): IBinder = messenger.binder

  private fun start(message: Message) {
    val client = message.replyTo ?: return
    val data = message.data
    val id = data.getString("jobId") ?: return
    // 探测（PROBE）必须能和流式共存：换轨要先 probe 再开新流，把 probe 拒掉用户就换不了轨。
    // 真正互斥的只有「整段转码」——两个重活会互相抢 CPU。
    if (active != null || destroyed || (message.what == AudioWorkerProtocol.CONVERT && stream != null)) { send(client, AudioWorkerProtocol.ERROR, id, "音轨任务正忙，请稍后重试"); return }
    val job = try {
      AudioWorkerValidation.jobId(id)
      val input = AudioWorkerValidation.input(data.getString("input") ?: "")
      val index = data.getInt("audioIndex", 0)
      require(index in 0..127)
      val duration = data.getLong("durationUs", 0)
      require(duration >= 0)
      val tags = AudioWorkerValidation.metadata(data.getString("tags") ?: "{}")
      Job(id, input, index, duration, tags, client, message.what == AudioWorkerProtocol.CONVERT, data.getBoolean("copy", false))
    } catch (_: Exception) { send(client, AudioWorkerProtocol.ERROR, id, "音轨任务参数无效"); return }
    active = job
    try { client.binder.linkToDeath(job.death, 0) } catch (_: Exception) { cancel(job); return }
    main.postDelayed(job.timeout, if (job.convert) 30 * 60 * 1000L else 30000L)
    probe(job, job.input) { json ->
      if (!job.convert) { complete(job, json.toString()); return@probe }
      try {
        job.expected = AudioWorkerValidation.duration(json, job.index)
        job.upper = AudioWorkerValidation.positive(json.optJSONObject("format")?.opt("duration"))
        job.sampleRate = AudioWorkerValidation.sampleRate(json, job.index) ?: 0
        job.containerStart = AudioWorkerValidation.containerStart(json) ?: 0.0
        job.audioStart = AudioWorkerValidation.startTime(json, job.index) ?: job.containerStart
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
      val session = FFprobeKit.executeWithArgumentsAsync(arrayOf("-v", "error", "-probesize", "524288", "-analyzeduration", "500000", "-show_streams", "-show_format", "-of", "json", input)) { result ->
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

  /**
   * 编码入口：段数/采样率满足条件走分片并行，否则走改动前的单段整轨逻辑（回退开关）。
   */
  private fun convert(job: Job) {
    if (!current(job)) return
    try {
      job.output.parentFile?.mkdirs()
      require(!job.output.exists())
      job.ownsOutput = true
      main.postDelayed(job.outputLimit, 500L)
      // copy 抽轨不解码，几百 MB 的轨也是秒级，不需要分片并行。
      val plan = if (job.copy) null else plan(job)
      if (plan == null) {
        Log.i(TAG, "audio single-pass fallback input=${job.input}")
        convertSingle(job)
      } else {
        convertSegments(job, plan)
      }
    } catch (_: Exception) { fail(job, "音轨转换未能启动") }
  }

  /**
   * 段数=1（或不满足分片前提）时返回 null，调用方退回单段整轨编码。
   *
   * 边界按「音轨 PTS 原点 + 整数个 AAC 帧」换算：`atrim` 看到的是容器绝对时间戳（配合 `-copyts`），
   * 而 `-ss` 是相对容器起点的偏移，两者差一个 `audioStart - containerStart`。PTS 原点为负时
   * 无法保证首段样本对齐，直接回退单段逻辑。
   */
  private fun plan(job: Job): List<Segment>? {
    val count = AudioSegmentation.count(job.input)
    if (count <= 1) return null
    val rate = AudioSegmentation.encoderRate(job.sampleRate) ?: return null
    if (!job.audioStart.isFinite() || job.audioStart < 0.0) return null
    val offset = (job.audioStart - job.containerStart).coerceIn(-3600.0, 3600.0)
    val raw = job.expected ?: job.upper ?: (job.durationUs / 1_000_000.0).takeIf { it > 0 } ?: return null
    // 音轨流时长包含 PTS 起点偏移，减掉它才接近真实内容长度。
    val seconds = (raw - offset).takeIf { it > 0.0 } ?: raw
    if (seconds < AudioSegmentation.MIN_SECONDS) return null
    val totalSamples = Math.round(seconds * rate)
    val edges = AudioSegmentation.boundaries(totalSamples, count) ?: return null
    return (0 until count).map { k ->
      val start = edges[k]
      val end = edges[k + 1]
      Segment(k, File(job.work, "seg$k.aac"), start, end, rate, AudioSegmentation.frames(end - start))
    }
  }

  // ---------------------------------------------------------------------------------------------
  // 旧逻辑：单段整轨编码（回退路径，参数与改动前完全一致）
  // ---------------------------------------------------------------------------------------------
  private fun convertSingle(job: Job) {
    if (!current(job)) return
    try {
      val args = mutableListOf("-hide_banner", "-nostdin", "-v", "error", "-n", "-probesize", "2097152", "-analyzeduration", "3000000", "-i", job.input,
        "-map", "0:a:${job.index}", "-vn", "-sn", "-dn", "-map_metadata", "-1")
      if (job.copy) {
        // 内核解不了但能整轨搬走的编码（AC-3/E-AC-3）：copy 保留 5.1 声道，
        // 走 AAC 转码会被 -ac 2 压成立体声。copy 不能再挂 -af（滤镜需要解码）。
        args.addAll(listOf("-c:a", "copy"))
      } else {
        args.addAll(listOf("-c:a", "aac", "-profile:a", "aac_low", "-ac", "2", "-b:a", "192k", "-af", "asetpts=PTS-STARTPTS"))
      }
      args.add("-fs"); args.add(AudioWorkerValidation.OUTPUT_SENTINEL_BYTES.toString())
      args.addAll(job.tags); args.addAll(listOf("-f", "matroska", job.output.absolutePath))
      val session = FFmpegKit.executeWithArgumentsAsync(args.toTypedArray(), { result ->
        main.post { singleDone(job, result) }
      }, { _ -> }, { statistics ->
        main.post { singleProgress(job, statistics) }
      })
      job.sessionId = session.sessionId
    } catch (_: Exception) { fail(job, "音轨转换未能启动") }
  }

  private fun singleDone(job: Job, result: FFmpegSession) {
    if (active === job && job.retiring) { job.sessionId = null; release(job); return }
    if (!current(job) || job.sessionId != result.sessionId) return
    job.sessionId = null
    if (!ReturnCode.isSuccess(result.returnCode) || !job.output.isFile || !AudioWorkerValidation.outputSize(job.output.length())) { fail(job, "音轨转换失败，未保留不完整缓存"); return }
    validate(job)
  }

  private fun singleProgress(job: Job, statistics: Statistics) {
    if (!current(job)) return
    if (statistics.size > AudioWorkerValidation.MAX_AUDIO_BYTES) { fail(job, "音轨缓存超过 512 MiB 限制，已取消"); return }
    job.written = maxOf(job.written, statistics.size.coerceAtLeast(0))
    val now = SystemClock.elapsedRealtime()
    if (now - job.lastProgress < 500) return
    job.lastProgress = now
    val duration = job.expected ?: job.upper
    val percent = if (duration == null) -1.0 else (statistics.time / (duration * 10)).coerceIn(0.0, 99.9)
    event(job, AudioWorkerProtocol.PROGRESS, Bundle().apply { putDouble("percent", percent); putLong("written", job.written) })
  }

  // ---------------------------------------------------------------------------------------------
  // 分片并行：N 路 ADTS 段编码
  // ---------------------------------------------------------------------------------------------
  private fun convertSegments(job: Job, plan: List<Segment>) {
    if (!current(job)) return
    cleanupWork(job)
    job.work.mkdirs()
    if (!job.work.isDirectory) { fail(job, "音轨转换未能启动"); return }
    job.segments.addAll(plan)
    val executor = Executors.newFixedThreadPool(plan.size)
    job.executor = executor
    Log.i(TAG, "audio segments=${plan.size} rate=${plan.first().rate} samples=${plan.last().endSample} offset=${job.audioStart - job.containerStart} input=${job.input}")
    event(job, AudioWorkerProtocol.PROGRESS, Bundle().apply { putDouble("percent", 0.0); putLong("written", 0L) })
    for (segment in plan) startSegment(job, segment, plan.size, executor)
  }

  private fun startSegment(job: Job, segment: Segment, count: Int, executor: ExecutorService) {
    if (!current(job)) return
    try {
      val session = FFmpegKit.executeWithArgumentsAsync(segmentArgs(job, segment, count), { result ->
        main.post { segmentDone(job, segment, result) }
      }, { _ -> }, { statistics ->
        main.post { segmentProgress(job, segment, statistics) }
      }, executor)
      segment.sessionId = session.sessionId
    } catch (_: RejectedExecutionException) { fail(job, "音轨转换未能启动")
    } catch (_: Exception) { fail(job, "音轨转换未能启动") }
  }

  private fun segmentArgs(job: Job, segment: Segment, count: Int): Array<String> {
    val offset = segment.startSample.toDouble() / segment.rate
    val start = job.audioStart + offset
    val end = job.audioStart + segment.endSample.toDouble() / segment.rate
    val seek = maxOf(0.0, (job.audioStart - job.containerStart) + offset - 1.0)
    val filter = "atrim=start=$start:end=$end,asetpts=PTS-STARTPTS"
    val limit = (AudioWorkerValidation.OUTPUT_SENTINEL_BYTES / count).coerceAtLeast(1L)
    return arrayOf("-hide_banner", "-nostdin", "-v", "error", "-n",
      "-probesize", "2097152", "-analyzeduration", "3000000",
      "-copyts", "-ss", seek.toString(), "-i", job.input,
      "-map", "0:a:${job.index}", "-vn", "-sn", "-dn", "-map_metadata", "-1",
      "-c:a", "aac", "-profile:a", "aac_low", "-ac", "2", "-b:a", "192k", "-ar", segment.rate.toString(),
      "-af", filter, "-fs", limit.toString(), "-f", "adts", segment.file.absolutePath)
  }

  private fun segmentDone(job: Job, segment: Segment, result: FFmpegSession) {
    if (active === job && job.retiring) {
      segment.sessionId = null
      if (job.sessions().isEmpty() && !job.assembling) release(job)
      return
    }
    if (!current(job) || segment.sessionId != result.sessionId) return
    segment.sessionId = null
    if (!ReturnCode.isSuccess(result.returnCode) || !segment.file.isFile || segment.file.length() <= 0) {
      fail(job, "音轨分段编码失败，未保留不完整缓存")
      return
    }
    segment.written = maxOf(segment.written, segment.file.length() / 1024)
    segment.done = true
    if (job.segments.all { it.done }) assemble(job)
  }

  private fun segmentProgress(job: Job, segment: Segment, statistics: Statistics) {
    if (!current(job)) return
    if (statistics.size > AudioWorkerValidation.MAX_AUDIO_BYTES) { fail(job, "音轨缓存超过 512 MiB 限制，已取消"); return }
    segment.timeMs = maxOf(segment.timeMs, minOf(statistics.time, segment.durationMs.toDouble()).toLong())
    segment.written = maxOf(segment.written, statistics.size.coerceAtLeast(0))
    val now = SystemClock.elapsedRealtime()
    if (now - job.lastProgress < 500) return
    job.lastProgress = now
    val total = job.segments.sumOf { it.durationMs }.coerceAtLeast(1L)
    val done = job.segments.sumOf { minOf(it.timeMs, it.durationMs) }
    job.written = maxOf(job.written, job.segments.sumOf { it.written })
    event(job, AudioWorkerProtocol.PROGRESS, Bundle().apply {
      putDouble("percent", (done.toDouble() * 100.0 / total).coerceIn(0.0, 99.9))
      putLong("written", job.written)
    })
  }

  // ---------------------------------------------------------------------------------------------
  // 拼接：帧级裁剪（纯字节，工作线程）→ concat: 协议一次 -c copy 重封装
  // ---------------------------------------------------------------------------------------------
  private fun assemble(job: Job) {
    if (!current(job)) return
    val executor = job.executor
    if (executor == null) { fail(job, "音轨转换未能启动"); return }
    job.assembling = true
    // 所有段都已编码完成，进度停在 99.9%；从这里到重封装结束还要裁剪 + 拼接 + 封装，
    // 先告诉宿主已进入拼接阶段，前端把胶囊换成「正在拼接音频…」而不是一直挂着 100%。
    announceAssembling(job, AudioAssembling.TRIM, job.segments.sumOf { it.needFrames })
    try {
      executor.execute {
        val error = trimSegments(job)
        main.post {
          if (!current(job)) { if (active === job && job.retiring) { job.assembling = false; release(job) }; return@post }
          job.assembling = false
          if (error != null) { fail(job, error); return@post }
          announceAssembling(job, AudioAssembling.CONCAT, job.segments.sumOf { it.keptFrames })
          event(job, AudioWorkerProtocol.PROGRESS, Bundle().apply { putDouble("percent", 99.9); putLong("written", job.written) })
          repackage(job)
        }
      }
    } catch (_: RejectedExecutionException) { job.assembling = false; fail(job, "音轨转换未能启动")
    } catch (_: Exception) { job.assembling = false; fail(job, "音轨转换未能启动") }
  }

  /**
   * 帧级裁剪：去掉每段首帧 priming，裁到 needFrames。超出 EOF 的空段（容器时长比音轨实际内容长时会出现）
   * 直接跳过不参与拼接；中间段偏短只告警（接缝会有 ≤1 帧的缺口，但不能让整单失败）。
   */
  private fun trimSegments(job: Job): String? {
    for (segment in job.segments) {
      if (job.aborted) return "音轨任务已取消"
      val trimmed = try { trimAdts(segment.file, segment.needFrames) } catch (_: Exception) { null }
        ?: return "音轨分段结构异常，未保留不完整缓存"
      segment.keptFrames = trimmed.keptFrames
      if (trimmed.keptFrames <= 0) {
        Log.w(TAG, "audio segment ${segment.index} empty: frames=${trimmed.totalFrames}")
      } else if (trimmed.keptFrames < segment.needFrames) {
        Log.w(TAG, "audio segment ${segment.index} short: kept=${trimmed.keptFrames} need=${segment.needFrames} total=${trimmed.totalFrames}")
      }
    }
    return if (job.segments.any { it.keptFrames > 0 }) null else "音轨分段为空，未保留不完整缓存"
  }

  /**
   * 按 ADTS 帧头里的 frame_length 逐帧切分，去掉首帧（AAC 编码器 priming）与超出 needFrames 的
   * 尾部填充帧；保留区间是连续的字节范围，因此原地前移并截断，不额外占用磁盘。
   */
  private fun trimAdts(file: File, needFrames: Long): AdtsFrames? {
    if (!file.isFile) return null
    RandomAccessFile(file, "rw").use { handle ->
      val size = handle.length()
      val header = ByteArray(7)
      var position = 0L
      var first = -1L
      var endAtNeed = -1L
      var count = 0L
      while (position + 7 <= size) {
        handle.seek(position)
        handle.readFully(header)
        if ((header[0].toInt() and 0xFF) != 0xFF || (header[1].toInt() and 0xF0) != 0xF0) return null
        val headerSize = if ((header[1].toInt() and 0x01) != 0) 7 else 9
        val frameSize = (((header[3].toInt() and 0x03) shl 11) or ((header[4].toInt() and 0xFF) shl 3) or ((header[5].toInt() shr 5) and 0x07)).toLong()
        if (frameSize < headerSize || position + frameSize > size) return null
        if (count == 1L) first = position
        if (count == needFrames) endAtNeed = position + frameSize
        count++
        position += frameSize
      }
      if (position != size) return null
      if (first < 0 || count < 2L) return AdtsFrames(count, 0, 0)
      val kept = minOf(needFrames, count - 1)
      val end = if (count - 1 <= needFrames) size else endAtNeed
      if (kept <= 0 || end <= first) return AdtsFrames(count, 0, 0)
      val length = end - first
      var read = first
      var write = 0L
      val buffer = ByteArray(262144)
      while (read < end) {
        val chunk = minOf(buffer.size.toLong(), end - read).toInt()
        handle.seek(read); handle.readFully(buffer, 0, chunk)
        handle.seek(write); handle.write(buffer, 0, chunk)
        read += chunk; write += chunk
      }
      handle.setLength(length)
      return AdtsFrames(count, kept, length)
    }
  }

  private fun repackage(job: Job) {
    if (!current(job)) return
    val parts = job.segments.filter { it.keptFrames > 0 }
    if (parts.isEmpty()) { fail(job, "音轨分段为空，未保留不完整缓存"); return }
    try {
      val joined = "concat:" + parts.joinToString("|") { it.file.absolutePath }
      val args = mutableListOf("-hide_banner", "-nostdin", "-v", "error", "-n", "-f", "aac", "-i", joined,
        "-c", "copy", "-map_metadata", "-1", "-disposition:a:0", "default")
      args.addAll(job.tags)
      args.addAll(listOf("-fs", AudioWorkerValidation.OUTPUT_SENTINEL_BYTES.toString(), "-f", "matroska", job.output.absolutePath))
      val session = FFmpegKit.executeWithArgumentsAsync(args.toTypedArray(), { result ->
        main.post { repackageDone(job, result) }
      }, { _ -> }, { statistics ->
        main.post {
          if (!current(job)) return@post
          job.written = maxOf(job.written, statistics.size.coerceAtLeast(0))
          val now = SystemClock.elapsedRealtime()
          if (now - job.lastProgress < 500) return@post
          job.lastProgress = now
          event(job, AudioWorkerProtocol.PROGRESS, Bundle().apply { putDouble("percent", 99.9); putLong("written", job.written) })
        }
      })
      job.sessionId = session.sessionId
    } catch (_: Exception) { fail(job, "音轨拼接未能启动") }
  }

  private fun repackageDone(job: Job, result: FFmpegSession) {
    if (active === job && job.retiring) { job.sessionId = null; release(job); return }
    if (!current(job) || job.sessionId != result.sessionId) return
    job.sessionId = null
    cleanupWork(job)
    if (!ReturnCode.isSuccess(result.returnCode) || !job.output.isFile || !AudioWorkerValidation.outputSize(job.output.length())) {
      fail(job, "音轨转换失败，未保留不完整缓存")
      return
    }
    validate(job)
  }

  private fun validate(job: Job) {
    probe(job, job.output.absolutePath) { json ->
      if (!AudioWorkerValidation.output(json, job.expected, job.upper, job.copy)) { fail(job, "转换后的音轨验证失败"); return@probe }
      complete(job, JSONObject().put("path", job.output.absolutePath).put("size", job.output.length()).put("probe", json).put("durationVerified", job.expected != null).toString())
    }
  }

  private fun overLimit(job: Job): Boolean {
    if (job.output.isFile && job.output.length() > AudioWorkerValidation.MAX_AUDIO_BYTES) return true
    val files = job.work.listFiles() ?: return false
    var total = 0L
    for (file in files) {
      total += file.length()
      if (total > AudioWorkerValidation.MAX_AUDIO_BYTES) return true
    }
    return false
  }

  private fun cleanup(job: Job) {
    if (job.ownsOutput) runCatching { job.output.delete() }
    cleanupWork(job)
  }

  private fun cleanupWork(job: Job) {
    runCatching {
      val work = job.work.canonicalFile
      if (work.parentFile == File(cacheDir, "audio-transcode").canonicalFile && work.isDirectory) work.deleteRecursively()
    }
  }

  private fun event(job: Job, type: Int, data: Bundle) {
    if (!current(job)) return
    data.putString("jobId", job.id)
    try { job.client.send(Message.obtain(null, type).apply { this.data = data }) } catch (_: Exception) { cancel(job) }
  }

  /** 拼接阶段的分阶段通知：只在任务仍有效时发，客户端已死时沿用 [event] 的取消语义。 */
  private fun announceAssembling(job: Job, stage: String, frames: Long) {
    event(job, AudioWorkerProtocol.ASSEMBLING, Bundle().apply { putString("stage", stage); putLong("frames", frames) })
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

  /** 所有段/拼接会话共用同一个终态收敛点：任一终态立即取消全部会话，绝不发布。 */
  private fun finish(job: Job, remove: Boolean) {
    val ids = job.sessions()
    if (!job.lifecycle.finish(ids.isNotEmpty() || job.assembling)) return
    job.aborted = true
    job.removeAfterExit = remove
    main.removeCallbacks(job.timeout); main.removeCallbacks(job.probeTimeout); main.removeCallbacks(job.outputLimit)
    if (ids.isNotEmpty() || job.assembling) {
      ids.forEach { id -> runCatching { FFmpegKit.cancel(id) } }
      main.postDelayed(job.retireTimeout, 3000L)
    } else release(job)
  }

  private fun release(job: Job) {
    if (active !== job || !job.lifecycle.release()) return
    active = null; job.sessionId = null; job.assembling = false
    main.removeCallbacks(job.retireTimeout)
    job.executor?.shutdownNow(); job.executor = null
    runCatching { job.client.binder.unlinkToDeath(job.death, 0) }
    if (job.removeAfterExit) cleanup(job)
    if (destroyed) return
    val result = job.terminalResult
    if (result != null) {
      runCatching { job.client.send(Message.obtain(null, AudioWorkerProtocol.DONE).apply {
        data = Bundle().apply { putString("jobId", job.id); putString("result", result) }
      }) }
    } else job.terminalMessage?.let { send(job.client, AudioWorkerProtocol.ERROR, job.id, it) }
  }

  // ---------------------------------------------------------------------------------------------
  // 流式转码（STREAM）：单进程把一条音轨编成碎片化 MP4，供前端 MediaSource 边收边播
  // ---------------------------------------------------------------------------------------------
  private fun startStream(message: Message) {
    val client = message.replyTo ?: return
    val data = message.data
    val id = data.getString("jobId") ?: return
    // 新流顶掉旧流：页面重载、或者上一路还没收到 CANCEL 就来了新的，都不该被「正忙」挡住。
    // 被顶掉的那条会自己收尾（取消 ffmpeg + 删文件），与新流并行几百毫秒是能接受的。
    stream?.let { abortStream(it) }
    if (destroyed || active?.convert == true) {
      send(client, AudioWorkerProtocol.ERROR, id, "音轨任务正忙，请稍后重试"); return
    }
    val job = try {
      val input = AudioWorkerValidation.input(data.getString("input") ?: "")
      val index = data.getInt("audioIndex", 0)
      require(index in 0..127)
      val start = data.getDouble("startSecs", 0.0)
      require(start.isFinite() && start >= 0.0)
      val output = File(data.getString("output") ?: "")
      val root = File(cacheDir, "stream").canonicalFile
      require(output.canonicalFile.parentFile == root && !output.exists())
      StreamJob(AudioWorkerValidation.jobId(id), input, index, start, output.canonicalFile, client)
    } catch (_: Exception) { send(client, AudioWorkerProtocol.ERROR, id, "音轨流参数无效"); return }
    stream = job
    try { client.binder.linkToDeath(job.death, 0) } catch (_: Exception) { abortStream(job); return }
    main.postDelayed(job.timeout, 60 * 60 * 1000L)
    job.output.parentFile?.mkdirs()
    Log.i(TAG, "audio stream start index=${job.index} from=${job.startSecs} input=${job.input}")
    try {
      val session = FFmpegKit.executeWithArgumentsAsync(streamArgs(job)) { result -> main.post { streamDone(job, result) } }
      job.sessionId = session.sessionId
      // ffmpeg 已经在跑：主进程收到 STARTED 就可以开始读增长文件了（文件可能还是 0 字节）。
      runCatching {
        client.send(Message.obtain(null, AudioWorkerProtocol.STARTED).apply {
          this.data = Bundle().apply { putString("jobId", job.id); putString("path", job.output.absolutePath) }
        })
      }
    } catch (_: Exception) { finishStream(job, "音轨流未能启动", true) }
  }

  /**
   * 流式转码参数。与整段转码的区别只有三处：
   * `-ss` 放在输入侧（能听清“从当前位置开始”就不用等片头）、`-ac 2` 必须（MSE 只喂立体声）、
   * 输出换成 fragmented MP4（`+frag_keyframe+empty_moov+default_base_moof` + 1 秒一片 + flush），
   * 否则 muxer 会攒到结束才落盘，前端永远读不到数据。
   */
  private fun streamArgs(job: StreamJob): Array<String> {
    val args = mutableListOf("-hide_banner", "-nostdin", "-v", "error", "-y",
      "-probesize", "1048576", "-analyzeduration", "1000000")
    if (job.startSecs > 0.05) { args.add("-ss"); args.add(String.format(java.util.Locale.US, "%.3f", job.startSecs)) }
    args.addAll(listOf(
      "-i", job.input,
      "-map", "0:a:${job.index}", "-vn", "-sn", "-dn", "-map_metadata", "-1",
      "-c:a", "aac", "-profile:a", "aac_low", "-ac", "2", "-ar", "48000", "-b:a", "192k",
      "-af", "asetpts=PTS-STARTPTS",
      "-f", "mp4", "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
      "-frag_duration", "1000000", "-flush_packets", "1",
      job.output.absolutePath
    ))
    return args.toTypedArray()
  }

  private fun streamDone(job: StreamJob, result: FFmpegSession) {
    if (stream !== job || job.finished) return
    job.sessionId = null
    if (job.aborted) return
    if (!ReturnCode.isSuccess(result.returnCode)) {
      val reason = result.output?.trim()?.take(200)?.ifEmpty { null } ?: "转码失败"
      finishStream(job, "音轨流转换失败：$reason", true)
      return
    }
    finishStream(job, null, false)
  }

  /** 流的唯一收尾点：成功发 DONE（带最终文件大小）、失败发 ERROR；取消/超时走同一个出口。 */
  private fun finishStream(job: StreamJob, message: String?, removeFile: Boolean) {
    if (stream !== job || job.finished) return
    job.finished = true
    stream = null
    main.removeCallbacks(job.timeout)
    runCatching { job.client.binder.unlinkToDeath(job.death, 0) }
    if (removeFile) {
      job.sessionId?.let { runCatching { FFmpegKit.cancel(it) } }
      job.sessionId = null
      // ffmpeg 停下之前还可能往文件里补几个字节：稍等再删，删不掉就留给下次启动的清理
      main.postDelayed({ runCatching { job.output.delete() } }, 1500L)
    } else {
      job.sessionId = null
    }
    if (destroyed) return
    if (message != null) { send(job.client, AudioWorkerProtocol.ERROR, job.id, message); return }
    runCatching {
      job.client.send(Message.obtain(null, AudioWorkerProtocol.DONE).apply {
        data = Bundle().apply {
          putString("jobId", job.id)
          putString("result", JSONObject().put("path", job.output.absolutePath).put("size", job.output.length()).toString())
        }
      })
    }
  }

  private fun abortStream(job: StreamJob) {
    if (stream !== job) return
    job.aborted = true
    finishStream(job, "音轨任务已取消", true)
  }

  private fun extractSubtitle(message: Message) {    val client = message.replyTo ?: return
    val data = message.data
    val id = data.getString("jobId") ?: return
    val input = data.getString("input") ?: ""
    val index = data.getInt("subtitleIndex", -1)
    val output = File(data.getString("output") ?: "")
    if (input.isEmpty() || index !in 0..63) {
      send(client, AudioWorkerProtocol.ERROR, id, "字幕抽取参数无效"); return
    }
    val root = File(cacheDir, "subtitles")
    runCatching { root.mkdirs() }
    if (output.canonicalFile.parentFile != root.canonicalFile) {
      send(client, AudioWorkerProtocol.ERROR, id, "字幕输出位置无效"); return
    }
    runCatching { output.delete() }
    // Converting the subtitle stream to subrip keeps ASS/SSA tracks readable by the
    // web layer, which only understands plain timed text. Bitmap (PGS) tracks cannot be
    // converted to text at all, so they are remuxed into a tiny local MKV that the Rust
    // PGS renderer already knows how to read.
    val format = if (data.getString("format") == "mkv") "mkv" else "srt"
    val args = if (format == "mkv") {
      arrayOf("-v", "error", "-y", "-i", input, "-map", "0:s:$index", "-c", "copy", "-f", "matroska", output.absolutePath)
    } else {
      arrayOf("-v", "error", "-y", "-i", input, "-map", "0:s:$index", "-c:s", "srt", "-f", "srt", output.absolutePath)
    }
    FFmpegKit.executeWithArgumentsAsync(args) { session ->
      if (ReturnCode.isSuccess(session.returnCode) && output.isFile && output.length() > 0) {
        sendResult(client, id, JSONObject().put("path", output.absolutePath).put("size", output.length()).toString())
      } else {
        val reason = session.output?.trim()?.take(200)?.ifEmpty { null } ?: "输出为空"
        runCatching { output.delete() }
        send(client, AudioWorkerProtocol.ERROR, id, "字幕抽取失败：$reason")
      }
    }
  }

  private fun send(client: Messenger, type: Int, id: String, message: String) {
    runCatching { client.send(Message.obtain(null, type).apply { data = Bundle().apply { putString("jobId", id); putString("message", message) } }) }
  }

  private fun sendResult(client: Messenger, id: String, result: String) {
    runCatching {
      client.send(Message.obtain(null, AudioWorkerProtocol.DONE).apply {
        data = Bundle().apply { putString("jobId", id); putString("result", result) }
      })
    }
  }

  override fun onDestroy() {
    destroyed = true
    stream?.let { job ->
      job.aborted = true
      job.sessionId?.let { id -> runCatching { FFmpegKit.cancel(id) } }
      runCatching { job.output.delete() }
    }
    stream = null
    active?.let { job ->
      job.aborted = true
      job.sessions().forEach { id -> runCatching { FFmpegKit.cancel(id) } }
      job.executor?.shutdownNow(); job.executor = null
      cleanup(job)
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

  private companion object {
    const val TAG = "AudioDecodeService"
  }
}
