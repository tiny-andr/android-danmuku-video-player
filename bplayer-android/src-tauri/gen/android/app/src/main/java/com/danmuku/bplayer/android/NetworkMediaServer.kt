package com.danmuku.bplayer.android

import android.util.Base64
import fi.iki.elonen.NanoHTTPD
import java.io.ByteArrayInputStream
import java.io.FilterInputStream
import java.io.InputStream
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

internal data class NetworkByteRange(val start: Long, val end: Long) {
  val length: Long get() = end - start + 1
  companion object {
    fun parse(header: String?, size: Long): NetworkByteRange? {
      if (size <= 0) return null
      if (header == null) return NetworkByteRange(0, size - 1)
      if (!header.startsWith("bytes=")) return null
      val match = Regex("bytes=(\\d*)-(\\d*)").matchEntire(header) ?: return null
      val first = match.groupValues[1]
      val last = match.groupValues[2]
      if (first.isEmpty()) {
        val suffix = last.toLongOrNull() ?: return null
        if (suffix <= 0) return null
        return NetworkByteRange((size - minOf(size, suffix)).coerceAtLeast(0), size - 1)
      }
      val start = first.toLongOrNull() ?: return null
      val end = if (last.isEmpty()) size - 1 else minOf(last.toLongOrNull() ?: return null, size - 1)
      if (start >= size || end < start) return null
      return NetworkByteRange(start, end)
    }
  }
}

internal class NetworkMediaServer(
  private val store: NetworkSourceStore,
  private val connections: NetworkConnections,
  private val role: NetworkRole = NetworkRole.MEDIA,
  private val allowedPath: String? = null,
  private val maxReadBytes: Long? = null,
  private val sourceSnapshot: NetworkSource? = null
) : NanoHTTPD("127.0.0.1", 0) {
  private val bytesRead = java.util.concurrent.atomic.AtomicLong()
  private val token = ByteArray(32).also { SecureRandom().nextBytes(it) }
    .let { Base64.encodeToString(it, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING) }
  private val active = ConcurrentHashMap<InputStream, String>()
  private val runner = BoundedRunner()

  init { setAsyncRunner(runner); start(15000, true) }

  fun mediaUrl(path: String): String {
    val normalized = NetworkPaths.parse(path).virtual
    val encoded = Base64.encodeToString(normalized.toByteArray(Charsets.UTF_8), Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    if (!isAlive) throw NetworkFailure("本机媒体代理尚未启动或已经关闭")
    return "http://127.0.0.1:$listeningPort/$token/$encoded"
  }

  override fun useGzipWhenAccepted(response: Response): Boolean = false

  override fun serve(session: IHTTPSession): Response {
    val origin = session.headers["origin"]
    if (origin != null && origin != "http://tauri.localhost") return text(Response.Status.FORBIDDEN, "不允许的媒体请求来源", false)
    if (session.headers["host"] != "127.0.0.1:$listeningPort") return text(Response.Status.FORBIDDEN, "不允许的媒体代理主机", false)
    val pieces = session.uri.split('/')
    if (pieces.size != 3 || pieces[1] != token || pieces[2].length > 16384 || !Regex("[A-Za-z0-9_-]+").matches(pieces[2])) {
      return text(Response.Status.NOT_FOUND, "媒体地址无效")
    }
    if (session.method !in setOf(Method.HEAD, Method.GET, Method.OPTIONS)) {
      return text(Response.Status.METHOD_NOT_ALLOWED, "媒体代理只允许读取").apply { addHeader("Allow", "HEAD, GET, OPTIONS") }
    }
    if (session.method == Method.OPTIONS) return cors(newFixedLengthResponse(Response.Status.NO_CONTENT, MIME_PLAINTEXT, ""))
    try {
      val path = NetworkPaths.parse(String(Base64.decode(pieces[2], Base64.URL_SAFE or Base64.NO_WRAP), Charsets.UTF_8))
      if (allowedPath != null && path.virtual != allowedPath) return text(Response.Status.FORBIDDEN, "此代理不允许读取其他文件")
      val currentSource = store.get(path.id)
      if (sourceSnapshot != null && currentSource != sourceSnapshot) throw NetworkFailure("连接配置已变化，音轨处理已停止，请重新打开影片")
      val source = sourceSnapshot ?: currentSource
      return connections.run(source, role) { remote ->
        val stat = remote.stat(path.relative)
        if (stat.kind != "file") return@run text(Response.Status.NOT_FOUND, "网络媒体文件不存在")
        if (stat.size <= 0L) return@run text(Response.Status.RANGE_NOT_SATISFIABLE, "空文件不能作为媒体播放").apply {
          addHeader("Content-Range", "bytes */0"); addHeader("Accept-Ranges", "bytes")
        }
        val header = session.headers["range"]
        val range = NetworkByteRange.parse(header, stat.size)
        if (range == null) return@run text(Response.Status.RANGE_NOT_SATISFIABLE, "请求的媒体字节范围无效").apply {
          addHeader("Content-Range", "bytes */${stat.size}"); addHeader("Accept-Ranges", "bytes")
        }
        val input = if (session.method == Method.HEAD || range.length == 0L) ByteArrayInputStream(ByteArray(0))
          else track(path.id, bounded(connections.watch(source, role, remote,
            remote.open(path.relative, range.start, range.length, stat.size))))
        val response = newFixedLengthResponse(if (header == null) Response.Status.OK else Response.Status.PARTIAL_CONTENT,
          mime(path.relative), input, range.length)
        response.setRequestMethod(session.method)
        response.addHeader("Accept-Ranges", "bytes")
        response.addHeader("Cache-Control", "no-store")
        if (header != null) response.addHeader("Content-Range", "bytes ${range.start}-${range.end}/${stat.size}")
        cors(response)
      }
    } catch (error: Exception) {
      return text(Response.Status.SERVICE_UNAVAILABLE, safeNetworkError(error))
    }
  }

  private fun bounded(input: InputStream): InputStream {
    val limit = maxReadBytes ?: return input
    return object : FilterInputStream(input) {
      override fun read(): Int {
        val buffer = ByteArray(1)
        return if (read(buffer, 0, 1) < 0) -1 else buffer[0].toInt() and 255
      }
      override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        val remaining = limit - bytesRead.get()
        if (remaining <= 0) throw NetworkFailure("音轨探测读取已达到 32 MiB 上限")
        val count = input.read(buffer, offset, minOf(length.toLong(), remaining, 65536L).toInt())
        if (count > 0 && bytesRead.addAndGet(count.toLong()) > limit) throw NetworkFailure("音轨探测读取超出限制")
        return count
      }
    }
  }

  private fun track(id: String, input: InputStream): InputStream {
    val tracked = object : FilterInputStream(input) {
      @Volatile private var closed = false
      override fun close() {
        if (!closed) {
          closed = true
          active.remove(this)
          super.close()
        }
      }
    }
    active[tracked] = id
    return tracked
  }

  fun invalidate(id: String) {
    active.entries.filter { it.value == id }.forEach { runCatching { it.key.close() } }
  }

  fun shutdown() {
    active.keys.forEach { runCatching { it.close() } }
    stop()
  }

  private fun text(status: Response.Status, message: String, allowCors: Boolean = true): Response {
    val response = newFixedLengthResponse(status, "text/plain; charset=utf-8", message)
    return if (allowCors) cors(response) else response
  }

  private fun cors(response: Response): Response = response.apply {
    addHeader("Access-Control-Allow-Origin", "http://tauri.localhost")
    addHeader("Vary", "Origin")
    addHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
    addHeader("Access-Control-Allow-Headers", "Range, Content-Type")
    addHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges")
    addHeader("Access-Control-Allow-Private-Network", "true")
    addHeader("Cross-Origin-Resource-Policy", "cross-origin")
    addHeader("X-Content-Type-Options", "nosniff")
  }

  private fun mime(path: String): String = when (path.substringAfterLast('.').lowercase()) {
    "mp4", "m4v" -> "video/mp4"
    "webm" -> "video/webm"
    "mkv" -> "video/x-matroska"
    "mka" -> "audio/x-matroska"
    "m4a" -> "audio/mp4"
    "ts" -> "video/mp2t"
    "mov" -> "video/quicktime"
    else -> "application/octet-stream"
  }

  private class BoundedRunner : AsyncRunner {
    private val clients = ConcurrentHashMap.newKeySet<ClientHandler>()
    private val executor = ThreadPoolExecutor(0, 8, 30, TimeUnit.SECONDS,
      java.util.concurrent.SynchronousQueue(), { task -> Thread(task, "network-media").apply { isDaemon = true } })
    override fun exec(handler: ClientHandler) {
      clients.add(handler)
      try { executor.execute(handler) }
      catch (_: java.util.concurrent.RejectedExecutionException) { clients.remove(handler); handler.close() }
    }
    override fun closed(handler: ClientHandler) { clients.remove(handler) }
    override fun closeAll() {
      clients.forEach { it.close() }; clients.clear(); executor.shutdownNow()
    }
  }
}
