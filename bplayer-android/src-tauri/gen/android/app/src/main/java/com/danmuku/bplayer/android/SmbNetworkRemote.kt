package com.danmuku.bplayer.android

import com.hierynomus.msdtyp.AccessMask
import com.hierynomus.msfscc.FileAttributes
import com.hierynomus.mssmb2.SMB2CreateDisposition
import com.hierynomus.mssmb2.SMB2CreateOptions
import com.hierynomus.mssmb2.SMB2Dialect
import com.hierynomus.mssmb2.SMB2ShareAccess
import com.hierynomus.mssmb2.SMBApiException
import com.hierynomus.smbj.SMBClient
import com.hierynomus.smbj.SmbConfig
import com.hierynomus.smbj.auth.AuthenticationContext
import com.hierynomus.smbj.auth.NtlmAuthenticator
import com.hierynomus.smbj.connection.Connection
import com.hierynomus.smbj.session.Session
import com.hierynomus.smbj.share.DiskShare
import java.io.InputStream
import java.net.InetAddress
import java.net.Socket
import java.net.SocketAddress
import java.util.EnumSet
import java.util.concurrent.TimeUnit
import javax.net.SocketFactory

internal class SmbNetworkRemote(private val source: NetworkSource) : NetworkRemote {
  private val client: SMBClient
  private val connection: Connection
  private val session: Session
  private val share: DiskShare
  private val sockets = TimeoutSocketFactory()
  @Volatile private var closed = false
  private val sharing = EnumSet.allOf(SMB2ShareAccess::class.java)
  private val noFollow = setOf(SMB2CreateOptions.FILE_OPEN_REPARSE_POINT)
  private val reparse = FileAttributes.FILE_ATTRIBUTE_REPARSE_POINT.value

  init {
    client = SMBClient(SmbConfig.builder()
      .withDialects(SMB2Dialect.SMB_3_1_1, SMB2Dialect.SMB_3_0_2, SMB2Dialect.SMB_3_0, SMB2Dialect.SMB_2_1)
      .withAuthenticators(NtlmAuthenticator.Factory())
      .withMultiProtocolNegotiate(false).withDfsEnabled(false).withSigningRequired(true).withEncryptData(false)
      .withTimeout(8, TimeUnit.SECONDS).withSoTimeout(8000).withReadBufferSize(1024 * 1024)
      .withSocketFactory(sockets).build())
    try {
      connection = client.connect(source.host, source.port)
      session = connection.authenticate(AuthenticationContext(source.username, source.password.toCharArray(), source.domain))
      share = session.connectShare(source.share) as? DiskShare ?: throw NetworkFailure("SMB 共享不是文件共享")
    } catch (error: Exception) { client.close(); throw error }
  }

  private fun path(relative: String): String {
    val segments = NetworkPaths.segments(source.root) + NetworkPaths.segments(relative)
    if (segments.any { it.endsWith('.') || it.endsWith(' ') || it.contains(':') }) {
      throw NetworkFailure("SMB 路径不允许尾随点、尾随空格或备用数据流")
    }
    return segments.joinToString("\\")
  }

  private fun checked(relative: String): String {
    val path = path(relative)
    var prefix = ""
    path.split('\\').filter { it.isNotEmpty() }.forEach { segment ->
      prefix = if (prefix.isEmpty()) segment else "$prefix\\$segment"
      share.open(prefix, setOf(AccessMask.FILE_READ_ATTRIBUTES), EnumSet.noneOf(FileAttributes::class.java), sharing,
        SMB2CreateDisposition.FILE_OPEN, noFollow).use { entry ->
        if (entry.fileInformation.basicInformation.fileAttributes and reparse != 0L) {
          throw NetworkFailure("为保护存储根目录，不允许访问 SMB 重解析点或符号链接")
        }
      }
    }
    return path
  }

  @Synchronized
  override fun list(relative: String): List<RemoteEntry> {
    val path = checked(relative)
    return share.openDirectory(path, setOf(AccessMask.FILE_LIST_DIRECTORY, AccessMask.FILE_READ_ATTRIBUTES),
      EnumSet.noneOf(FileAttributes::class.java), sharing, SMB2CreateDisposition.FILE_OPEN,
      setOf(SMB2CreateOptions.FILE_DIRECTORY_FILE, SMB2CreateOptions.FILE_OPEN_REPARSE_POINT)).use { directory ->
      directory.list().filter { it.fileName != "." && it.fileName != ".." && it.fileAttributes and reparse == 0L }
        .map { RemoteEntry(it.fileName, it.endOfFile.coerceAtLeast(0),
          it.fileAttributes and FileAttributes.FILE_ATTRIBUTE_DIRECTORY.value != 0L) }
    }
  }

  @Synchronized
  override fun stat(relative: String): RemoteStat {
    return try {
      val info = share.getFileInformation(checked(relative)).standardInformation
      RemoteStat(if (info.isDirectory) "dir" else "file", if (info.isDirectory) 0 else info.endOfFile.coerceAtLeast(0))
    } catch (error: SMBApiException) {
      if (error.statusCode == 0xC0000034L || error.statusCode == 0xC000003AL || error.statusCode == 0xC000000FL) {
        RemoteStat("missing", 0)
      } else throw error
    }
  }

  @Synchronized
  override fun open(relative: String, start: Long, length: Long, total: Long): InputStream {
    val file = share.openFile(checked(relative), setOf(AccessMask.FILE_READ_DATA, AccessMask.FILE_READ_ATTRIBUTES),
      EnumSet.noneOf(FileAttributes::class.java), sharing, SMB2CreateDisposition.FILE_OPEN,
      setOf(SMB2CreateOptions.FILE_NON_DIRECTORY_FILE, SMB2CreateOptions.FILE_OPEN_REPARSE_POINT))
    try {
      if (file.fileInformation.basicInformation.fileAttributes and reparse != 0L) {
        throw NetworkFailure("不允许读取 SMB 符号链接")
      }
      if (file.length != total) throw NetworkFailure("远端文件大小已改变，请重新打开视频")
      return java.io.BufferedInputStream(PositionedNetworkStream(start, length,
        { position, buffer, offset, count -> file.read(buffer, position, offset, count) }, { file.closeNoWait() }), 256 * 1024)
    } catch (error: Exception) { file.close(); throw error }
  }

  override fun isConnected(): Boolean = !closed && connection.isConnected && share.isConnected

  override fun abort() { closed = true; sockets.closeAll() }

  override fun close() {
    abort()
    runCatching { connection.close(true) }
    client.close()
  }

  private class TimeoutSocketFactory : SocketFactory() {
    private val opened = java.util.concurrent.ConcurrentHashMap.newKeySet<Socket>()
    fun closeAll() { opened.forEach { runCatching { it.close() } }; opened.clear() }
    override fun createSocket(): Socket = object : Socket() {
      override fun connect(endpoint: SocketAddress?) { super.connect(endpoint, 10000) }
      override fun connect(endpoint: SocketAddress?, timeout: Int) { super.connect(endpoint, if (timeout == 0) 8000 else minOf(timeout, 8000)) }
    }.also { opened.add(it) }
    override fun createSocket(host: String, port: Int): Socket = createSocket().apply { connect(java.net.InetSocketAddress(host, port)) }
    override fun createSocket(host: String, port: Int, localHost: InetAddress, localPort: Int): Socket =
      createSocket().apply { bind(java.net.InetSocketAddress(localHost, localPort)); connect(java.net.InetSocketAddress(host, port)) }
    override fun createSocket(host: InetAddress, port: Int): Socket = createSocket().apply { connect(java.net.InetSocketAddress(host, port)) }
    override fun createSocket(host: InetAddress, port: Int, localHost: InetAddress, localPort: Int): Socket =
      createSocket().apply { bind(java.net.InetSocketAddress(localHost, localPort)); connect(java.net.InetSocketAddress(host, port)) }
  }
}
