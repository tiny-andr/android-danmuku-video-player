package com.danmuku.bplayer.android

import android.content.Context
import android.os.StatFs
import org.json.JSONArray
import org.json.JSONObject
import java.io.Closeable
import java.io.File
import java.io.RandomAccessFile
import java.nio.file.Files
import java.security.MessageDigest
import java.util.UUID

internal object AudioMedia {
  const val CACHE_VERSION = "1"
  const val MAX_AUDIO_BYTES = 512L * 1024 * 1024
  private val codecIds = mapOf("aac" to "A_AAC", "mp3" to "A_MPEG/L3", "flac" to "A_FLAC",
    "opus" to "A_OPUS", "vorbis" to "A_VORBIS", "dts" to "A_DTS", "truehd" to "A_TRUEHD",
    "ac3" to "A_AC3", "eac3" to "A_EAC3", "ac4" to "A_AC4", "dra" to "A_DRA",
    "pcm_bluray" to "A_PCM/BLURAY", "ass" to "S_TEXT/ASS", "ssa" to "S_TEXT/SSA",
    "subrip" to "S_TEXT/UTF8", "webvtt" to "S_TEXT/WEBVTT", "hdmv_pgs_subtitle" to "S_HDMV/PGS")

  fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
  fun codec(value: String): String = codecIds[value] ?: if (value.startsWith("pcm_")) "A_PCM/${value.uppercase()}" else value.uppercase()
  fun streams(probe: JSONObject): List<JSONObject> = probe.optJSONArray("streams")?.let { array ->
    (0 until array.length()).mapNotNull { array.optJSONObject(it) }
  } ?: emptyList()
  fun seconds(value: Any?): Double? = value?.toString()?.toDoubleOrNull()?.takeIf { it.isFinite() && it >= 0 }
  fun duration(probe: JSONObject): Double? = seconds(probe.optJSONObject("format")?.opt("duration"))
  fun normalized(probe: JSONObject): JSONObject = JSONObject().put("tracks", JSONArray().apply {
    streams(probe).forEach { stream ->
      val tags = stream.optJSONObject("tags")
      put(JSONObject().put("kind", stream.optString("codec_type"))
        .put("codec", codec(stream.optString("codec_name")))
        .put("number", stream.optInt("index") + 1).put("lang", tags?.optString("language") ?: "")
        .put("name", tags?.optString("title") ?: "")
        .put("default", stream.optJSONObject("disposition")?.optInt("default") == 1)
        .put("channels", stream.optInt("channels"))
        // PTS 起点也带出去：外壳要拿它算 offset，才能在后续 prepare 里免掉一次完整 ffprobe
        .put("start_time", stream.opt("start_time")?.toString() ?: JSONObject.NULL))
    }
  }).put("duration_us", duration(probe)?.let { (it * 1_000_000).toLong() } ?: JSONObject.NULL)
    .put("origin", probe.optJSONObject("format")?.opt("start_time")?.toString() ?: "0")

  fun offset(probe: JSONObject, audioIndex: Int): Double {
    val audio = streams(probe).filter { it.optString("codec_type") == "audio" }.getOrNull(audioIndex)
      ?: throw NetworkFailure("音轨序号不存在")
    fun signed(value: Any?): Double? = value?.toString()?.toDoubleOrNull()?.takeIf { it.isFinite() }
    val origin = signed(probe.optJSONObject("format")?.opt("start_time")) ?: 0.0
    return ((signed(audio.opt("start_time")) ?: origin) - origin).coerceIn(-3600.0, 3600.0)
  }

  fun tags(identity: String, audioIndex: Int, offset: Double): JSONObject = JSONObject()
    .put("bplayer_version", CACHE_VERSION).put("bplayer_source", identity)
    .put("bplayer_track", audioIndex.toString()).put("bplayer_offset", offset.toString())

  fun validCache(probe: JSONObject, identity: String, audioIndex: Int, sourceDuration: Double?,
    sourceModified: Long?, cacheModified: Long?, exactDuration: Boolean = true): Pair<Boolean, Double>? {
    val streams = streams(probe)
    // 不再限定 aac/2ch：copy 抽出的缓存保留原编码（AC-3 5.1 等），
    // 只要求「单条音频流」，时长与 tags 的校验在后面兜底。
    if (streams.size != 1 || streams[0].optString("codec_type") != "audio") return null
    val length = duration(probe) ?: return null
    if (length <= 0) return null
    if (sourceDuration != null) {
      val tolerance = maxOf(2.0, sourceDuration * 0.005)
      if (length > sourceDuration + tolerance || exactDuration && kotlin.math.abs(length - sourceDuration) > tolerance) return null
    }
    val sourceTags = probe.optJSONObject("format")?.optJSONObject("tags") ?: JSONObject()
    val tags = JSONObject().apply { sourceTags.keys().forEach { key -> put(key.lowercase(), sourceTags.get(key)) } }
    if (tags.has("bplayer_version")) {
      if (tags.optString("bplayer_version") != CACHE_VERSION || tags.optString("bplayer_source") != identity ||
        tags.optString("bplayer_track") != audioIndex.toString()) return null
      val offset = tags.optString("bplayer_offset").toDoubleOrNull()?.takeIf { it.isFinite() && kotlin.math.abs(it) <= 3600 } ?: return null
      return false to offset
    }
    if (sourceModified == null || cacheModified == null || cacheModified < sourceModified ||
      sourceDuration == null || kotlin.math.abs(length - sourceDuration) > 2) return null
    return true to 0.0
  }

  // 分片并行后峰值暂存 = Σ段（≈产物）+ 最终 staging（≈产物）≈ 2× 产物，本地与远程目标都按 2× 预留。
  fun checkSpace(context: Context, duration: Double?, @Suppress("UNUSED_PARAMETER") localTarget: Boolean) {
    val estimate = if (duration == null) MAX_AUDIO_BYTES else (duration * 26000 + 16 * 1024 * 1024).toLong()
    if (estimate > MAX_AUDIO_BYTES) throw NetworkFailure("音轨预计超过 512 MiB 单任务上限")
    val required = estimate * 2 + 32 * 1024 * 1024
    if (StatFs(context.cacheDir.absolutePath).availableBytes < required) {
      throw NetworkFailure("手机可用空间不足，音轨转换与缓存发布需要约 ${required / 1024 / 1024} MiB 临时空间")
    }
  }
}

internal class AudioSourceAccess(context: Context, val path: String, private val cancellation: AudioCancellation) : Closeable {
  private val context = context.applicationContext
  private val network = path.startsWith("/@network/")
  private val parsed = if (network) NetworkPaths.parse(path) else null
  private val store = if (network) NetworkSourceStore(this.context) else null
  private var remote: NetworkRemote? = null
  private var configuredSource: NetworkSource? = null
  private var relative = ""
  private val local = if (!network) File(path).canonicalFile.also {
    if (!path.startsWith("/storage/") && !path.startsWith("/sdcard/")) throw NetworkFailure("只允许转换手机存储中的视频文件")
    if (!it.isFile) throw NetworkFailure("视频不存在或不是普通文件")
  } else null
  private val proxies = mutableListOf<Pair<NetworkMediaServer, NetworkConnections>>()

  init {
    cancellation.check()
    if (parsed != null) {
      if (android.os.Build.VERSION.SDK_INT >= 37 && context.checkSelfPermission("android.permission.ACCESS_LOCAL_NETWORK") != android.content.pm.PackageManager.PERMISSION_GRANTED) {
        throw NetworkFailure("未获得局域网访问权限")
      }
      val configured = store!!.get(parsed.id)
      configuredSource = configured
      val resolved = if (configured.protocol == "smb") SmbShares.resolve(configured, parsed.relative) else configured to parsed.relative
      relative = resolved.second
      val early = ThumbnailCancellation()
      cancellation.onCancel { early.cancel() }
      remote = when (resolved.first.protocol) {
        "smb" -> SmbNetworkRemote(resolved.first, early)
        "sftp" -> SftpNetworkRemote(resolved.first)
        "webdav" -> WebDavNetworkRemote(resolved.first)
        else -> throw NetworkFailure("不支持的网络存储协议")
      }
      cancellation.onCancel { remote?.abort() }
    }
  }

  private fun checkConfiguration() {
    if (parsed != null && store!!.get(parsed.id) != configuredSource) throw NetworkFailure("连接配置已变化，音轨处理已停止，请重新打开影片")
  }

  fun stat(candidate: String = path): RemoteStat {
    cancellation.check(); checkConfiguration()
    return if (remote != null) {
      val target = NetworkPaths.parse(candidate)
      if (target.id != parsed!!.id) throw NetworkFailure("音轨缓存必须与视频位于同一来源")
      val configured = store!!.get(target.id)
      val resolved = if (configured.protocol == "smb") SmbShares.resolve(configured, target.relative) else configured to target.relative
      remote!!.stat(resolved.second)
    } else {
      val file = File(candidate).canonicalFile
      when { file.isFile -> RemoteStat("file", file.length(), file.lastModified())
        file.isDirectory -> RemoteStat("dir", 0, file.lastModified())
        else -> RemoteStat("missing", 0) }
    }
  }

  fun identity(expected: RemoteStat): String {
    checkConfiguration()
    if (expected.kind != "file" || expected.size <= 0) throw NetworkFailure("视频不是有效文件")
    val digest = MessageDigest.getInstance("SHA-256")
    digest.update("${AudioMedia.CACHE_VERSION}\n$path\n${expected.size}\n${expected.modifiedMs}\n".toByteArray(Charsets.UTF_8))
    val buffer = ByteArray(minOf(65536L, expected.size).toInt())
    fun block(position: Long) {
      cancellation.check()
      if (remote != null) {
        val count = remote!!.readAtExact(relative, position, buffer, 0, buffer.size, expected.size)
        if (count != buffer.size) throw NetworkFailure("视频指纹读取不完整")
      } else RandomAccessFile(local!!, "r").use { input -> input.seek(position); input.readFully(buffer) }
      digest.update(buffer)
    }
    block(0)
    if (expected.size > buffer.size) block(expected.size - buffer.size)
    return digest.digest().joinToString("") { "%02x".format(it) }
  }

  fun input(candidate: String = path, probing: Boolean = false, prefetchBytes: Int = DEFAULT_PREFETCH_BYTES,
    workerThreads: Int = 8): String {
    cancellation.check(); checkConfiguration()
    if (!network) return File(candidate).canonicalPath
    val connections = NetworkConnections()
    val server = NetworkMediaServer(store!!, connections, NetworkRole.TRANSCODE, candidate,
      if (probing) 32 * 1024 * 1024L else null, configuredSource, prefetchBytes, workerThreads)
    synchronized(proxies) { proxies.add(server to connections) }
    cancellation.onCancel { connections.close(); server.shutdown() }
    return server.mediaUrl(candidate)
  }

  fun target(audioIndex: Int): String {
    val name = path.substringAfterLast('/').substringBeforeLast('.', path.substringAfterLast('/')) + " (音轨${audioIndex + 1}).mka"
    return path.substringBeforeLast('/') + "/" + name
  }

  fun cacheFiles(): List<String> {
    val prefix = path.substringAfterLast('/').substringBeforeLast('.', path.substringAfterLast('/')) + " (音轨"
    return if (remote != null) {
      val parent = relative.substringBeforeLast('/', "")
      remote!!.list(parent).filter { !it.directory && it.name.startsWith(prefix) && it.name.endsWith(").mka") && !it.name.contains(".tmp.") }
        .map { path.substringBeforeLast('/') + "/" + it.name }
    } else local!!.parentFile?.listFiles()?.filter { it.isFile && it.name.startsWith(prefix) && it.name.endsWith(").mka") && !it.name.contains(".tmp.") }
      ?.map { it.absolutePath } ?: emptyList()
  }

  fun unchanged(expected: RemoteStat, fingerprint: String) {
    val actual = stat()
    if (actual.kind != expected.kind || actual.size != expected.size || actual.modifiedMs != expected.modifiedMs || identity(actual) != fingerprint) {
      throw NetworkFailure("视频在转换期间已变化，已取消缓存发布")
    }
  }

  fun publish(input: File, audioIndex: Int, jobId: String, expected: RemoteStat, fingerprint: String): String {
    cancellation.check(); unchanged(expected, fingerprint)
    if (!input.isFile || input.length() <= 0 || input.length() > AudioMedia.MAX_AUDIO_BYTES) throw NetworkFailure("转换音轨不是有效缓存")
    if (remote != null) {
      remote!!.publishAudioCache(relative, audioIndex, jobId, input, expected, cancellation)
      return target(audioIndex)
    }
    val target = File(target(audioIndex))
    val temporary = File(target.parentFile, target.nameWithoutExtension + ".bplayer-${UUID.fromString(jobId)}.tmp.mka")
    if (target.exists()) throw NetworkFailure("同名音轨缓存已存在，保留原缓存，请先检查缓存冲突")
    try {
      Files.newByteChannel(temporary.toPath(), setOf(java.nio.file.StandardOpenOption.CREATE_NEW, java.nio.file.StandardOpenOption.WRITE)).use { output ->
        input.inputStream().use { source ->
          val buffer = ByteArray(65536)
          while (true) {
            cancellation.check()
            val count = source.read(buffer)
            if (count < 0) break
            val bytes = java.nio.ByteBuffer.wrap(buffer, 0, count)
            while (bytes.hasRemaining()) output.write(bytes)
          }
        }
        if (output is java.nio.channels.FileChannel) output.force(true)
      }
      if (temporary.length() != input.length()) throw NetworkFailure("缓存写入长度不匹配")
      unchanged(expected, fingerprint); cancellation.check()
      cancellation.commit { Files.move(temporary.toPath(), target.toPath()) }
      return target.absolutePath
    } finally { if (temporary.isFile) temporary.delete() }
  }

  override fun close() {
    synchronized(proxies) { proxies.forEach { (server, connections) -> server.shutdown(); connections.close() }; proxies.clear() }
    runCatching { remote?.close() }
  }
}
