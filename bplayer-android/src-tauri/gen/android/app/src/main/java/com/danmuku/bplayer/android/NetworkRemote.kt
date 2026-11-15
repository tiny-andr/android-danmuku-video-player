package com.danmuku.bplayer.android

import java.io.Closeable
import java.io.InputStream
import java.util.concurrent.ConcurrentHashMap
import org.json.JSONObject

internal data class RemoteEntry(val name: String, val size: Long, val directory: Boolean) {
  fun json(parent: String): JSONObject = JSONObject().put("name", name)
    .put("path", NetworkPaths.child(parent, name)).put("size", size).put("is_dir", directory)
}

internal data class RemoteStat(val kind: String, val size: Long) {
  fun json(): JSONObject = JSONObject().put("kind", kind).put("size", size)
}

internal interface NetworkRemote : Closeable {
  fun list(relative: String): List<RemoteEntry>
  fun stat(relative: String): RemoteStat
  fun open(relative: String, start: Long, length: Long, total: Long): InputStream
}

internal class PositionedNetworkStream(
  private var position: Long,
  private var remaining: Long,
  private val reader: (Long, ByteArray, Int, Int) -> Int,
  private val closer: () -> Unit
) : InputStream() {
  @Volatile private var closed = false
  override fun read(): Int {
    val single = ByteArray(1)
    return if (read(single, 0, 1) < 0) -1 else single[0].toInt() and 255
  }
  override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
    if (closed) throw NetworkFailure("网络读取已取消")
    if (length == 0) return 0
    if (remaining == 0L) return -1
    val count = reader(position, buffer, offset, minOf(length.toLong(), remaining, 256 * 1024L).toInt())
    if (count <= 0) throw NetworkFailure("远端文件提前结束，请重新打开视频")
    position += count
    remaining -= count
    return count
  }
  override fun close() {
    if (!closed) { closed = true; closer() }
  }
}

internal class LimitedNetworkStream(
  private val input: InputStream,
  private var remaining: Long,
  private val closer: () -> Unit
) : InputStream() {
  @Volatile private var closed = false
  override fun read(): Int {
    val single = ByteArray(1)
    return if (read(single, 0, 1) < 0) -1 else single[0].toInt() and 255
  }
  override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
    if (closed) throw NetworkFailure("网络读取已取消")
    if (length == 0) return 0
    if (remaining == 0L) return -1
    val count = input.read(buffer, offset, minOf(length.toLong(), remaining).toInt())
    if (count <= 0) throw NetworkFailure("远端文件提前结束，请重新打开视频")
    remaining -= count
    return count
  }
  override fun close() {
    if (!closed) {
      closed = true
      try { input.close() } finally { closer() }
    }
  }
}

internal class NetworkConnections : Closeable {
  private val remotes = ConcurrentHashMap<String, NetworkRemote>()
  @Volatile private var closed = false

  @Synchronized
  fun get(source: NetworkSource): NetworkRemote {
    if (closed) throw NetworkFailure("网络存储服务已经关闭")
    return remotes[source.id] ?: create(source).also { remotes[source.id] = it }
  }

  fun create(source: NetworkSource): NetworkRemote = when (source.protocol) {
    "smb" -> SmbNetworkRemote(source)
    "sftp" -> SftpNetworkRemote(source)
    "webdav" -> WebDavNetworkRemote(source)
    else -> throw NetworkFailure("不支持的网络存储协议")
  }

  @Synchronized
  fun invalidate(id: String) { remotes.remove(id)?.let { runCatching { it.close() } } }

  @Synchronized
  override fun close() {
    closed = true
    remotes.values.forEach { runCatching { it.close() } }
    remotes.clear()
  }
}

internal fun safeNetworkError(error: Throwable): String {
  var current: Throwable? = error
  repeat(8) {
    if (current is NetworkFailure) return current!!.message ?: "网络存储操作失败"
    if (current is javax.net.ssl.SSLException) return "HTTPS 证书或安全连接校验失败，请检查服务器证书"
    val smbError = current as? com.hierynomus.mssmb2.SMBApiException
    if (smbError != null) {
      val status = smbError.statusCode
      val reason = when (status) {
        0xC000006DL, 0xC000006AL, 0xC0000064L -> "SMB 登录被拒绝，请检查用户名、密码及域；需使用服务器本地账号"
        0xC0000072L -> "SMB 账号已被禁用"
        0xC0000234L -> "SMB 账号已被锁定，请停止重试并检查服务器"
        0xC0000071L -> "SMB 密码已过期"
        0xC0000022L -> "SMB 拒绝读取，请检查共享权限、文件夹权限及签名设置"
        0xC00000CCL -> "SMB 共享名称不存在；请填写共享名，不是磁盘路径或完整地址"
        0xC00000BBL -> "服务器不支持所需 SMB 能力；需要 SMB 2.1/3.x、NTLMv2 和签名"
        0xC000A000L -> "SMB 签名校验失败，已拒绝不安全连接"
        else -> "SMB 服务器拒绝请求"
      }
      return "$reason（状态 0x${java.lang.Long.toHexString(status).uppercase()}）"
    }
    if (current is net.schmizz.sshj.userauth.UserAuthException) return "SFTP 登录被拒绝，请确认密码登录已启用、账号未锁定且具有 SFTP 权限"
    if (current is java.net.ConnectException) return "无法连接服务器端口，请检查地址、端口、防火墙及服务是否启动"
    if (current is java.net.NoRouteToHostException) return "无法到达服务器，请检查手机与服务器网络、VPN 及局域网权限"
    if (current is java.net.SocketTimeoutException) return "连接或读取超时，请检查网络与服务器"
    if (current is java.net.UnknownHostException) return "无法解析服务器地址，请检查地址与网络"
    current = current?.cause
  }
  return "网络存储操作失败（${error.javaClass.simpleName}），请检查协议配置、读取权限及服务器状态"
}
