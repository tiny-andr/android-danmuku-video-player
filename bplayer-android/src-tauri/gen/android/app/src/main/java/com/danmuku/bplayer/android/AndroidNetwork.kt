package com.danmuku.bplayer.android

import android.content.Context
import android.net.Uri
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

@androidx.annotation.Keep
internal class AndroidNetwork(
  context: Context,
  private val webView: WebView,
  private val ensurePermission: ((Boolean) -> Unit) -> Unit
) : Closeable {
  private val store = NetworkSourceStore(context.applicationContext)
  private val connections = NetworkConnections()
  private val discovery = NetworkDiscovery(context.applicationContext)
  private val server = NetworkMediaServer(store, connections)
  private val executor = ThreadPoolExecutor(4, 4, 30, TimeUnit.SECONDS, LinkedBlockingQueue(64),
    { task -> Thread(task, "network-command").apply { isDaemon = true } })
  @Volatile private var closed = false

  @JavascriptInterface
  fun request(id: String, command: String, argsJson: String) {
    if (closed || id.length > 256) return
    webView.post {
      if (closed || !trustedPage()) return@post
      if (command.length > 64 || argsJson.length > 65536) {
        reply(id, JSONObject().put("ok", false).put("error", "网络存储请求过大"))
        return@post
      }
      if (command in setOf("network_permission", "network_discover_smb", "network_smb_shares", "network_test", "network_save", "list_dir", "fs_stat", "read_bytes", "read_text", "scan_folder", "pair_danmaku", "scan_subtitles")) {
        ensurePermission { granted ->
          if (!closed && trustedPage()) {
            if (granted) dispatch(id, command, argsJson)
            else reply(id, JSONObject().put("ok", false).put("error", "未获得局域网访问权限，请在系统设置的应用权限中允许本地网络后重试"))
          }
        }
      } else dispatch(id, command, argsJson)
    }
  }

  private fun dispatch(id: String, command: String, argsJson: String) {
    if (closed) return
    try {
      executor.execute {
        val envelope = try {
          val result = execute(command, JSONObject(argsJson))
          JSONObject().put("ok", true).put("result", result ?: JSONObject.NULL)
        } catch (error: Exception) {
          JSONObject().put("ok", false).put("error", safeNetworkError(error))
        }
        reply(id, envelope)
      }
    } catch (_: java.util.concurrent.RejectedExecutionException) {
      reply(id, JSONObject().put("ok", false).put("error", "网络存储请求过多，请稍后重试"))
    }
  }

  @JavascriptInterface
  fun mediaUrl(path: String): String = if (closed) "" else runCatching { server.mediaUrl(path) }.getOrDefault("")

  private fun trustedPage(): Boolean {
    val uri = Uri.parse(webView.url ?: return false)
    return uri.scheme == "http" && uri.host == "tauri.localhost" && (uri.port == -1 || uri.port == 80)
  }

  private fun reply(id: String, envelope: JSONObject) {
    if (closed) return
    webView.post {
      if (!closed && trustedPage()) {
        val payload = JSONObject.quote(envelope.toString()).replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
        val requestId = JSONObject.quote(id).replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
        webView.evaluateJavascript("window.__aNetworkReply && window.__aNetworkReply($requestId, JSON.parse($payload))", null)
      }
    }
  }

  private fun source(args: JSONObject): NetworkSource {
    val json = args.optJSONObject("source") ?: throw NetworkFailure("缺少网络存储配置")
    val id = json.optString("id")
    val previous = if (id.isNotBlank() && id != "null") store.all().find { it.id == NetworkPaths.uuid(id) } else null
    return NetworkSource.from(json, previous)
  }

  private fun test(source: NetworkSource): JSONObject {
    if (source.protocol == "sftp" && source.hostKey.isEmpty()) {
      try { connections.create(source).use { it.list("") } }
      catch (required: HostFingerprintRequired) {
        return JSONObject().put("hostKey", required.fingerprint).put("fingerprintRequired", true)
      }
      throw NetworkFailure("请先核对并填写 SFTP 服务器 SHA256 主机指纹")
    }
    val entries = connections.create(source).use { it.list("") }
    val path = "/@network/${source.id}"
    return listing(path, entries).put("source", source.json()).put("fingerprintRequired", false)
      .put("accessVerified", source.scope != "server")
  }

  private fun execute(command: String, args: JSONObject): Any? = when (command) {
    "network_permission" -> true
    "network_discover_smb" -> discovery.discoverSmb()
    "network_sources" -> JSONArray().apply { store.all().forEach { put(it.json()) } }
    "network_smb_shares" -> {
      val configured = source(args)
      if (configured.protocol != "smb") throw NetworkFailure("只有 SMB 支持共享枚举")
      val serverSource = configured.copy(scope = "server", share = "", root = "")
      val shares = SmbNetworkRemote(serverSource).use { it.shares() }
      JSONObject().put("accessVerified", false).put("shares", JSONArray().apply {
        shares.forEach { put(JSONObject().put("name", it.name).put("comment", it.comment)) }
      })
    }
    "network_test" -> test(source(args))
    "network_save" -> {
      val source = source(args)
      val tested = test(source)
      if (tested.optBoolean("fingerprintRequired")) {
        tested
      } else {
        store.save(source)
        server.invalidate(source.id)
        connections.invalidate(source.id)
        source.json()
      }
    }
    "network_remove" -> {
      val id = NetworkPaths.uuid(args.getString("id"))
      store.remove(id); server.invalidate(id); connections.invalidate(id); true
    }
    "list_dir" -> withRemote(args.getString("dir")) { path, remote -> listing(path.virtual, remote.list(path.relative)) }
    "fs_stat" -> withRemote(args.getString("path")) { path, remote -> remote.stat(path.relative).json() }
    "read_bytes" -> Base64.encodeToString(read(args.getString("path")), Base64.NO_WRAP)
    "read_text" -> String(read(args.getString("path")), Charsets.UTF_8)
    "scan_folder" -> scan(args.getString("dir"))
    "pair_danmaku" -> pair(args.getString("videoPath"))
    "scan_subtitles" -> subtitles(args.getString("videoPath"))
    else -> throw NetworkFailure("不支持的网络存储命令")
  }

  private fun <Result> withRemote(path: String, action: (NetworkPath, NetworkRemote) -> Result): Result {
    val parsed = NetworkPaths.parse(path)
    val source = store.get(parsed.id)
    return connections.run(source) { remote -> action(parsed, remote) }
  }

  private fun listing(path: String, entries: List<RemoteEntry>): JSONObject = JSONObject().put("dir", path)
    .put("entries", JSONArray().apply {
      entries.filter { !it.name.startsWith('.') && validName(it.name) }
        .sortedWith(compareByDescending<RemoteEntry> { it.directory }.thenBy { it.name.lowercase() })
        .forEach { put(it.json(path)) }
    })

  private fun validName(name: String): Boolean = runCatching { NetworkPaths.child("", name) }.isSuccess

  private fun read(path: String): ByteArray = withRemote(path) { parsed, remote ->
    val stat = remote.stat(parsed.relative)
    if (stat.kind != "file") throw NetworkFailure("网络文件不存在或不是普通文件")
    if (stat.size > 32 * 1024 * 1024L) throw NetworkFailure("网络文本或字幕文件超过 32 MiB 限制")
    if (stat.size == 0L) return@withRemote ByteArray(0)
    remote.open(parsed.relative, 0, stat.size, stat.size).use { input ->
      val output = ByteArrayOutputStream(minOf(stat.size, 1024 * 1024L).toInt())
      val buffer = ByteArray(65536)
      while (true) {
        val count = input.read(buffer)
        if (count < 0) break
        if (output.size() + count > 32 * 1024 * 1024) throw NetworkFailure("网络文件超过 32 MiB 读取限制")
        output.write(buffer, 0, count)
      }
      if (output.size().toLong() != stat.size) throw NetworkFailure("网络文件读取长度不匹配")
      output.toByteArray()
    }
  }

  private fun base(name: String): String = name.substringBeforeLast('.', name).lowercase()
  private fun extension(name: String): String = name.substringAfterLast('.', "").lowercase()
  private fun candidates(entries: List<RemoteEntry>): List<RemoteEntry> = entries.filter { !it.directory && validName(it.name) }
  private fun danmaku(entries: List<RemoteEntry>, name: String): RemoteEntry? = candidates(entries)
    .filter { base(it.name) == base(name) && extension(it.name) in setOf("xml", "json") }
    .sortedWith(compareBy<RemoteEntry> { if (extension(it.name) == "xml") 0 else 1 }.thenBy { it.name.lowercase() }).firstOrNull()

  private fun scan(dir: String): JSONObject = withRemote(dir) { parsed, remote ->
    val entries = remote.list(parsed.relative)
    val episodes = JSONArray()
    candidates(entries).filter {
      extension(it.name) in setOf("mp4", "m4v", "webm", "mov", "mkv", "avi", "ts", "flv", "wmv", "mpg", "mpeg") &&
        !base(it.name).endsWith(" (aac)") && !base(it.name).endsWith(" (aac).tmp")
    }.sortedBy { it.name.lowercase() }.forEach { entry ->
      episodes.put(JSONObject().put("name", entry.name).put("path", NetworkPaths.child(parsed.virtual, entry.name))
        .put("size", entry.size).put("danmaku", danmaku(entries, entry.name)?.name ?: JSONObject.NULL))
    }
    JSONObject().put("label", parsed.relative.substringAfterLast('/').ifEmpty { store.get(parsed.id).name }).put("episodes", episodes)
  }

  private fun pair(videoPath: String): JSONObject? = withRemote(videoPath) { parsed, remote ->
    if (parsed.relative.isEmpty()) return@withRemote null
    val parentRelative = parsed.relative.substringBeforeLast('/', "")
    val parent = NetworkPath(parsed.id, parentRelative).virtual
    val entry = danmaku(remote.list(parentRelative), parsed.relative.substringAfterLast('/')) ?: return@withRemote null
    JSONObject().put("name", entry.name).put("text", String(read(NetworkPaths.child(parent, entry.name)), Charsets.UTF_8))
  }

  private fun subtitles(videoPath: String): JSONArray = withRemote(videoPath) { parsed, remote ->
    if (parsed.relative.isEmpty()) return@withRemote JSONArray()
    val parentRelative = parsed.relative.substringBeforeLast('/', "")
    val parent = NetworkPath(parsed.id, parentRelative).virtual
    val videoBase = base(parsed.relative.substringAfterLast('/'))
    val files = candidates(remote.list(parentRelative)).filter { entry ->
      val name = entry.name
      extension(name) in setOf("srt", "ass", "ssa", "vtt") &&
        (base(name) == videoBase || base(name).startsWith("$videoBase.")) &&
        !name.contains(".tmp") && !name.contains(" (字幕") && !name.contains(" (音轨") && !name.contains(" (AAC)")
    }.sortedWith(compareByDescending<RemoteEntry> { base(it.name) == videoBase }.thenBy { it.name.lowercase() })
    JSONArray().apply { files.forEach { put(JSONObject().put("name", it.name).put("path", NetworkPaths.child(parent, it.name))) } }
  }

  override fun close() {
    closed = true
    discovery.close()
    executor.shutdownNow()
    Thread({ server.shutdown(); connections.close() }, "network-cleanup").apply { isDaemon = true; start() }
  }
}
