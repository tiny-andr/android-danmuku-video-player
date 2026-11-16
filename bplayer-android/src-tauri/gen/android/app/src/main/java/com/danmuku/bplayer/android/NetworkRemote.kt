package com.danmuku.bplayer.android

import java.io.Closeable
import java.io.InputStream
import java.util.concurrent.ConcurrentHashMap
import org.json.JSONObject

internal data class RemoteEntry(val name: String, val size: Long, val directory: Boolean, val modifiedMs: Long? = null) {
  fun json(parent: String): JSONObject = JSONObject().put("name", name)
    .put("path", NetworkPaths.child(parent, name)).put("size", size).put("is_dir", directory)
    .put("modified_ms", modifiedMs ?: JSONObject.NULL)
}

internal data class RemoteStat(val kind: String, val size: Long, val modifiedMs: Long? = null) {
  fun json(): JSONObject = JSONObject().put("kind", kind).put("size", size)
    .put("modified_ms", modifiedMs ?: JSONObject.NULL)
}

internal interface NetworkRemote : Closeable {
  fun isConnected(): Boolean = true
  fun abort() = Unit
  fun list(relative: String): List<RemoteEntry>
  fun stat(relative: String): RemoteStat
  fun open(relative: String, start: Long, length: Long, total: Long): InputStream
  fun readAtExact(relative: String, position: Long, buffer: ByteArray, offset: Int, length: Int, total: Long): Int =
    throw NetworkFailure("此网络存储不支持受限随机读取")
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

internal enum class NetworkRole { METADATA, MEDIA, THUMBNAIL }

internal class NetworkConnections(
  private val factory: ((NetworkSource) -> NetworkRemote)? = null,
  private val cleanup: java.util.concurrent.ExecutorService = java.util.concurrent.ThreadPoolExecutor(
    2, 2, 30, java.util.concurrent.TimeUnit.SECONDS, java.util.concurrent.LinkedBlockingQueue(256),
    { task -> Thread(task, "network-retire").apply { isDaemon = true } })
) : Closeable {
  private data class Key(val id: String, val role: NetworkRole, val share: String)
  private fun key(source: NetworkSource, role: NetworkRole) = Key(source.id, role,
    if (source.protocol == "smb") source.scope + ":" + source.share.lowercase(java.util.Locale.ROOT) else "")
  private data class Entry(val source: NetworkSource, val remote: NetworkRemote)
  private class Slot {
    val lock = java.util.concurrent.locks.ReentrantLock()
    val current = java.util.concurrent.atomic.AtomicReference<Entry?>()
    val revision = java.util.concurrent.atomic.AtomicLong()
  }
  private val slots = ConcurrentHashMap<Key, Slot>()
  @Volatile private var closed = false

  fun <Result> run(source: NetworkSource, role: NetworkRole = NetworkRole.METADATA,
    action: (NetworkRemote) -> Result): Result {
    if (closed) throw NetworkFailure("网络存储服务已经关闭")
    return if (source.protocol == "smb" && source.scope == "server") {
      action(SmbServerNetworkRemote(source, this, role))
    } else runBound(source, role, action)
  }

  internal fun <Result> runBound(source: NetworkSource, role: NetworkRole, action: (NetworkRemote) -> Result): Result {
    if (closed) throw NetworkFailure("网络存储服务已经关闭")
    val slot = slots.computeIfAbsent(key(source, role)) { Slot() }
    val requestRevision = slot.revision.get()
    if (!slot.lock.tryLock(3, java.util.concurrent.TimeUnit.SECONDS)) {
      throw NetworkFailure("此网络连接仍在处理请求，请稍后重试")
    }
    try {
      repeat(2) { attempt ->
        if (closed || Thread.currentThread().isInterrupted) throw NetworkFailure("网络请求已取消")
        if (slot.revision.get() != requestRevision) throw NetworkFailure("网络存储配置已变化，请重试")
        var entry: Entry? = null
        try {
          val existing = slot.current.get()
          if (existing != null && existing.source == source && existing.remote.isConnected()) {
            entry = existing
          } else {
            if (existing != null && slot.current.compareAndSet(existing, null)) retire(existing.remote)
            val revision = slot.revision.get()
            val created = Entry(source, createBound(source))
            if (closed || revision != slot.revision.get() || !slot.current.compareAndSet(null, created)) {
              retire(created.remote)
              throw NetworkFailure("网络存储配置已变化，请重试")
            }
            entry = created
          }
          return action(entry.remote)
        } catch (error: Exception) {
          if (!isTransientNetworkFailure(error)) throw error
          if (entry != null) invalidate(source.id, role, entry.remote)
          if (attempt == 1 || role == NetworkRole.THUMBNAIL || closed || Thread.currentThread().isInterrupted) throw error
        }
      }
      throw NetworkFailure("网络存储连接恢复失败")
    } finally { slot.lock.unlock() }
  }

  fun create(source: NetworkSource): NetworkRemote = if (source.protocol == "smb" && source.scope == "server") {
    SmbServerNetworkRemote(source, NetworkConnections(factory), NetworkRole.THUMBNAIL, true)
  } else createBound(source)

  private fun createBound(source: NetworkSource): NetworkRemote = factory?.invoke(source) ?: when (source.protocol) {
    "smb" -> SmbNetworkRemote(source)
    "sftp" -> SftpNetworkRemote(source)
    "webdav" -> WebDavNetworkRemote(source)
    else -> throw NetworkFailure("不支持的网络存储协议")
  }

  fun invalidate(id: String, role: NetworkRole, expected: NetworkRemote) {
    slots.entries.filter { it.key.id == id && it.key.role == role }.forEach { (_, slot) ->
      val current = slot.current.get()
      if (current?.remote === expected && slot.current.compareAndSet(current, null)) retire(expected)
    }
  }

  fun invalidate(id: String) {
    slots.entries.filter { it.key.id == id }.forEach { (_, slot) ->
      slot.revision.incrementAndGet()
      slot.current.getAndSet(null)?.let { retire(it.remote) }
    }
  }

  fun watch(source: NetworkSource, role: NetworkRole, remote: NetworkRemote, input: InputStream): InputStream =
    object : java.io.FilterInputStream(input) {
      private val streamClosed = java.util.concurrent.atomic.AtomicBoolean(false)
      override fun read(): Int = readSafely { input.read() }
      override fun read(buffer: ByteArray, offset: Int, length: Int): Int = readSafely { input.read(buffer, offset, length) }
      private fun readSafely(read: () -> Int): Int {
        if (streamClosed.get()) throw NetworkFailure("网络读取已取消")
        try { return read() }
        catch (error: Exception) {
          if (!streamClosed.get() && isTransientNetworkFailure(error)) invalidate(source.id, role, remote)
          throw error
        }
      }
      override fun close() {
        if (streamClosed.compareAndSet(false, true)) input.close()
      }
    }

  private fun retire(remote: NetworkRemote) {
    runCatching { remote.abort() }
    try { cleanup.execute { runCatching { remote.close() } } }
    catch (_: java.util.concurrent.RejectedExecutionException) { runCatching { remote.abort() } }
  }

  override fun close() {
    closed = true
    slots.values.forEach { slot ->
      slot.revision.incrementAndGet()
      slot.current.getAndSet(null)?.let { retire(it.remote) }
    }
    cleanup.shutdown()
  }
}

internal fun isTransientNetworkFailure(error: Throwable): Boolean {
  val causes = mutableListOf<Throwable>()
  var current: Throwable? = error
  repeat(12) {
    val cause = current ?: return@repeat
    if (causes.any { it === cause }) return@repeat
    causes.add(cause)
    current = cause.cause
  }
  if (causes.any { it is NetworkFailure || it is HostFingerprintRequired ||
      it is javax.net.ssl.SSLException || it is java.security.GeneralSecurityException ||
      it is net.schmizz.sshj.userauth.UserAuthException || it is InterruptedException }) return false
  val smb = causes.filterIsInstance<com.hierynomus.mssmb2.SMBApiException>().firstOrNull()
  if (smb != null) return smb.statusCode in setOf(0xC0000008L, 0xC00000B5L, 0xC00000C9L,
    0xC0000203L, 0xC000020CL, 0xC000020DL, 0xC000035CL)
  val sftp = causes.filterIsInstance<net.schmizz.sshj.sftp.SFTPException>().firstOrNull()
  if (sftp != null) return sftp.statusCode.code == 6 || sftp.statusCode.code == 7
  return causes.any { it is java.net.SocketException || it is java.net.SocketTimeoutException ||
    it is java.io.EOFException || it is java.nio.channels.ClosedChannelException ||
    it is java.util.concurrent.TimeoutException || it is com.hierynomus.protocol.transport.TransportException }
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
