package com.danmuku.bplayer.android

import android.util.Xml
import okhttp3.ConnectionSpec
import okhttp3.Credentials
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Response
import okhttp3.TlsVersion
import org.xmlpull.v1.XmlPullParser
import java.io.ByteArrayOutputStream
import java.io.FilterInputStream
import java.io.InputStream
import java.io.StringReader
import java.util.concurrent.TimeUnit

internal class WebDavNetworkRemote(private val source: NetworkSource) : NetworkRemote {
  private val base: HttpUrl
  private val root: HttpUrl
  private val client = OkHttpClient.Builder()
    .connectTimeout(10, TimeUnit.SECONDS).readTimeout(20, TimeUnit.SECONDS)
    .writeTimeout(20, TimeUnit.SECONDS).callTimeout(30, TimeUnit.SECONDS)
    .followRedirects(false).followSslRedirects(false)
    .protocols(listOf(Protocol.HTTP_2, Protocol.HTTP_1_1))
    .connectionSpecs(listOf(ConnectionSpec.Builder(ConnectionSpec.MODERN_TLS)
      .tlsVersions(TlsVersion.TLS_1_3, TlsVersion.TLS_1_2).build()))
    .build()
  private val streamingClient = client.newBuilder().callTimeout(0, TimeUnit.MILLISECONDS).build()
  @Volatile private var closed = false
  override fun isConnected(): Boolean = !closed
  override fun abort() { closed = true; client.dispatcher.cancelAll() }

  init {
    val parsed = source.url.toHttpUrlOrNull() ?: throw NetworkFailure("请输入完整的 HTTPS WebDAV 地址")
    if (parsed.scheme != "https" || parsed.username.isNotEmpty() || parsed.password.isNotEmpty() || parsed.query != null || parsed.fragment != null) {
      throw NetworkFailure("WebDAV 只允许不含凭据、查询或片段的 HTTPS 地址")
    }
    validateSegments(parsed.pathSegments)
    base = parsed.newBuilder().apply { if (parsed.pathSegments.lastOrNull() != "") addPathSegment("") }.build()
    root = base.newBuilder().apply {
      NetworkPaths.segments(source.root).forEach { addPathSegment(it) }
      if (NetworkPaths.segments(source.root).isNotEmpty()) addPathSegment("")
    }.build()
  }

  private fun validateSegments(parts: List<String>) {
    parts.filter { it.isNotEmpty() }.forEach { NetworkPaths.child("/@network/${source.id}", it) }
  }

  private fun url(relative: String, directory: Boolean = false): HttpUrl = root.newBuilder().apply {
    val segments = NetworkPaths.segments(relative)
    segments.forEach { addPathSegment(it) }
    if (directory && segments.isNotEmpty()) addPathSegment("")
  }.build()

  private fun builder(url: HttpUrl): Request.Builder {
    if (!sameOrigin(url, base)) throw NetworkFailure("WebDAV 不允许跨服务器发送认证信息")
    return Request.Builder().url(url).header("Accept-Encoding", "identity").apply {
      if (source.username.isNotEmpty() || source.password.isNotEmpty()) {
        header("Authorization", Credentials.basic(source.username, source.password, Charsets.UTF_8))
      }
    }
  }

  private fun check(response: Response) {
    when (response.code) {
      401, 403 -> throw NetworkFailure("WebDAV 认证失败或没有读取权限")
      in 300..399 -> throw NetworkFailure("WebDAV 返回了重定向，请直接填写最终 HTTPS 地址")
    }
    if (!response.isSuccessful) throw NetworkFailure("WebDAV 服务器读取失败，请检查路径与服务状态")
  }

  private data class DavEntry(val url: HttpUrl, val directory: Boolean, val size: Long)

  private fun propfind(target: HttpUrl, depth: String): List<DavEntry> {
    val xml = "<?xml version=\"1.0\" encoding=\"utf-8\"?><d:propfind xmlns:d=\"DAV:\"><d:prop><d:resourcetype/><d:getcontentlength/></d:prop></d:propfind>"
    val request = builder(target).header("Depth", depth)
      .method("PROPFIND", xml.toRequestBody("application/xml; charset=utf-8".toMediaType())).build()
    return client.newCall(request).execute().use { response ->
      if (response.code == 404) return@use emptyList()
      check(response)
      if (response.code != 207) throw NetworkFailure("服务器没有返回有效的 WebDAV 目录信息")
      val body = response.body ?: throw NetworkFailure("WebDAV 目录响应为空")
      val bytes = body.byteStream().use { input ->
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(8192)
        while (true) {
          val count = input.read(buffer)
          if (count < 0) break
          if (output.size() + count > 8 * 1024 * 1024) throw NetworkFailure("WebDAV 目录响应过大，请选择更小的目录")
          output.write(buffer, 0, count)
        }
        output.toByteArray()
      }
      parse(String(bytes, Charsets.UTF_8), target)
    }
  }

  private fun parse(xml: String, target: HttpUrl): List<DavEntry> {
    if (Regex("<!\\s*(DOCTYPE|ENTITY)", RegexOption.IGNORE_CASE).containsMatchIn(xml)) {
      throw NetworkFailure("WebDAV 响应包含不安全的 XML 声明")
    }
    val parser = Xml.newPullParser().apply {
      setFeature(XmlPullParser.FEATURE_PROCESS_NAMESPACES, true)
      setFeature(XmlPullParser.FEATURE_PROCESS_DOCDECL, false)
      setInput(StringReader(xml))
    }
    val result = mutableListOf<DavEntry>()
    var href = ""
    var status = ""
    var directory = false
    var size = -1L
    var valid = false
    var propDirectory = false
    var propSize = -1L
    var field: String? = null
    val text = StringBuilder()
    while (true) {
      when (parser.nextToken()) {
        XmlPullParser.END_DOCUMENT -> break
        XmlPullParser.DOCDECL -> throw NetworkFailure("WebDAV 响应包含不安全的 XML 声明")
        XmlPullParser.START_TAG -> {
          if (parser.depth > 32) throw NetworkFailure("WebDAV XML 嵌套层级过深")
          if (parser.namespace == "DAV:") {
            when (parser.name) {
              "response" -> { href = ""; valid = false; directory = false; size = -1 }
              "propstat" -> { status = ""; propDirectory = false; propSize = -1 }
              "collection" -> propDirectory = true
              "href", "status", "getcontentlength" -> { field = parser.name; text.setLength(0) }
            }
          }
        }
        XmlPullParser.TEXT, XmlPullParser.CDSECT, XmlPullParser.ENTITY_REF -> {
          if (parser.eventType == XmlPullParser.ENTITY_REF && parser.text == null) throw NetworkFailure("WebDAV XML 包含未知实体")
          if (field != null) {
            text.append(parser.text.orEmpty())
            if (text.length > 16384) throw NetworkFailure("WebDAV XML 字段过长")
          }
        }
        XmlPullParser.END_TAG -> {
          if (parser.namespace == "DAV:") {
            when (parser.name) {
              "href" -> href = text.toString().trim()
              "status" -> status = text.toString().trim()
              "getcontentlength" -> propSize = text.toString().trim().toLongOrNull() ?: -1
              "propstat" -> if (Regex("HTTP/\\S+ 200(?: .*|$)").matches(status)) {
                valid = true; directory = directory || propDirectory
                if (propSize >= 0) size = propSize
              }
              "response" -> if (valid && href.isNotEmpty()) {
                val resolved = resolveHref(target, href)
                if (resolved != null) {
                  if (!directory && size < 0) throw NetworkFailure("WebDAV 未提供有效文件大小")
                  result.add(DavEntry(resolved, directory, if (directory) 0 else size))
                  if (result.size > 50000) throw NetworkFailure("WebDAV 目录文件过多")
                }
              }
            }
            if (parser.name == field) field = null
          }
        }
      }
    }
    return result
  }

  private fun resolveHref(target: HttpUrl, href: String): HttpUrl? {
    if (href.any { it == '\\' || it.code < 32 }) return null
    val decoded = try { java.net.URLDecoder.decode(href.replace("+", "%2B"), "UTF-8") } catch (_: Exception) { return null }
    if (decoded.split('/').any { it == "." || it == ".." } || decoded.contains('\\')) return null
    val resolved = target.resolve(href) ?: return null
    if (!sameOrigin(resolved, root) || resolved.query != null || resolved.fragment != null || resolved.username.isNotEmpty() || resolved.password.isNotEmpty()) return null
    if (runCatching { validateSegments(resolved.pathSegments) }.isFailure) return null
    val rootParts = root.pathSegments.filter { it.isNotEmpty() }
    val parts = resolved.pathSegments.filter { it.isNotEmpty() }
    if (parts.take(rootParts.size) != rootParts) return null
    return resolved
  }

  override fun list(relative: String): List<RemoteEntry> {
    val target = url(relative, true)
    val parent = target.pathSegments.filter { it.isNotEmpty() }
    val listing = propfind(target, "1")
    if (listing.none { it.directory && it.url.pathSegments.filter { part -> part.isNotEmpty() } == parent }) {
      throw NetworkFailure("WebDAV 根路径不存在、不是目录或没有读取权限")
    }
    return listing.mapNotNull { entry ->
      val segments = entry.url.pathSegments.filter { it.isNotEmpty() }
      if (segments.size != parent.size + 1 || segments.take(parent.size) != parent) null
      else RemoteEntry(segments.last(), entry.size, entry.directory)
    }.distinctBy { it.name }
  }

  override fun stat(relative: String): RemoteStat {
    val target = url(relative)
    val parts = target.pathSegments.filter { it.isNotEmpty() }
    val item = propfind(target, "0").find { it.url.pathSegments.filter { part -> part.isNotEmpty() } == parts }
      ?: return RemoteStat("missing", 0)
    return RemoteStat(if (item.directory) "dir" else "file", item.size)
  }

  override fun open(relative: String, start: Long, length: Long, total: Long): InputStream {
    val end = start + length - 1
    val request = builder(url(relative)).header("Range", "bytes=$start-$end").get().build()
    val response = streamingClient.newCall(request).execute()
    try {
      check(response)
      val encoding = response.header("Content-Encoding")
      if (encoding != null && !encoding.equals("identity", true)) throw NetworkFailure("WebDAV 返回了压缩媒体，无法保证字节定位")
      if (response.code != 206) throw NetworkFailure("WebDAV 服务器不支持可靠的 Range 分段读取，无法流式播放")
      val match = Regex("bytes (\\d+)-(\\d+)/(\\d+)", RegexOption.IGNORE_CASE).matchEntire(response.header("Content-Range").orEmpty())
        ?: throw NetworkFailure("WebDAV 分段响应缺少有效 Content-Range")
      if (match.groupValues[1].toLongOrNull() != start || match.groupValues[2].toLongOrNull() != end || match.groupValues[3].toLongOrNull() != total) {
        throw NetworkFailure("WebDAV 分段位置或文件大小不匹配，已停止读取以避免播放错位")
      }
      val body = response.body ?: throw NetworkFailure("WebDAV 媒体响应为空")
      val declaredLength = response.header("Content-Length")?.toLongOrNull()
      if (declaredLength != null && declaredLength != length) throw NetworkFailure("WebDAV 分段长度不匹配")
      return object : FilterInputStream(body.byteStream()) {
        private var remaining = length
        override fun read(): Int {
          val single = ByteArray(1)
          return if (read(single, 0, 1) == -1) -1 else single[0].toInt() and 255
        }
        override fun read(buffer: ByteArray, offset: Int, count: Int): Int {
          if (count == 0) return 0
          if (remaining == 0L) return -1
          val read = super.read(buffer, offset, minOf(count.toLong(), remaining).toInt())
          if (read < 0) throw NetworkFailure("WebDAV 媒体响应提前结束")
          remaining -= read
          return read
        }
        override fun close() { response.close() }
      }
    } catch (error: Exception) { response.close(); throw error }
  }

  override fun close() {
    abort()
    client.connectionPool.evictAll()
    client.dispatcher.executorService.shutdown()
  }

  private fun sameOrigin(first: HttpUrl, second: HttpUrl): Boolean =
    first.scheme == second.scheme && first.host == second.host && first.port == second.port
}
