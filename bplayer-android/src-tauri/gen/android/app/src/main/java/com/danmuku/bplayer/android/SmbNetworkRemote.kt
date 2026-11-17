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
import com.hierynomus.smbj.share.PipeShare
import com.rapid7.client.dcerpc.Interface
import com.rapid7.client.dcerpc.mssrvs.ServerService
import com.rapid7.client.dcerpc.transport.SMBTransport
import com.rapid7.helper.smbj.share.NamedPipe
import java.io.InputStream
import java.net.InetAddress
import java.net.Socket
import java.net.SocketAddress
import java.util.EnumSet
import java.util.concurrent.TimeUnit
import javax.net.SocketFactory

internal fun smbModifiedMs(time: com.hierynomus.msdtyp.FileTime?): Long? =
  time?.takeIf { it.windowsTimeStamp != 0L && it.windowsTimeStamp != -1L }?.toEpochMillis()

internal class SmbNetworkRemote(private val source: NetworkSource, cancellation: ThumbnailCancellation? = null) : NetworkRemote {
  private val client: SMBClient
  private val connection: Connection
  private val session: Session
  private val diskShare: DiskShare?
  private val share: DiskShare get() = diskShare ?: throw NetworkFailure("请先选择 SMB 共享")
  private val sockets = TimeoutSocketFactory(cancellation)
  @Volatile private var closed = false
  private var exactFile: com.hierynomus.smbj.share.File? = null
  private var exactPath = ""
  private var exactSize = -1L
  private val sharing = EnumSet.allOf(SMB2ShareAccess::class.java)
  private val noFollow = setOf(SMB2CreateOptions.FILE_OPEN_REPARSE_POINT)
  private val reparse = FileAttributes.FILE_ATTRIBUTE_REPARSE_POINT.value

  init {
    cancellation?.onCancel { abort() }
    cancellation?.check()
    client = SMBClient(SmbConfig.builder()
      .withDialects(SMB2Dialect.SMB_3_1_1, SMB2Dialect.SMB_3_0_2, SMB2Dialect.SMB_3_0, SMB2Dialect.SMB_2_1)
      .withAuthenticators(NtlmAuthenticator.Factory())
      .withMultiProtocolNegotiate(false).withDfsEnabled(false).withSigningRequired(true).withEncryptData(false)
      .withTimeout(8, TimeUnit.SECONDS).withSoTimeout(8000).withReadBufferSize(1024 * 1024)
      .withSocketFactory(sockets).build())
    try {
      cancellation?.check()
      connection = client.connect(source.host, source.port)
      cancellation?.check()
      session = connection.authenticate(AuthenticationContext(source.username, source.password.toCharArray(), source.domain))
      cancellation?.check()
      diskShare = if (source.scope == "server") null
        else session.connectShare(source.share) as? DiskShare ?: throw NetworkFailure("SMB 共享不是文件共享")
      cancellation?.check()
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
  fun shares(): List<SmbShareInfo> {
    try {
      val pipeShare = session.connectShare("IPC$") as? PipeShare
        ?: throw NetworkFailure("服务器未提供共享枚举管道；可填写已知共享名称直连")
      return NamedPipe(session, pipeShare, "srvsvc").use { pipe ->
        val transport = SMBTransport(pipe)
        transport.bind(Interface.SRVSVC_V3_0, Interface.NDR_32BIT_V2)
        SmbShares.clean(ServerService(transport).shares1.map { Triple(it.netName ?: "", it.type, it.remark ?: "") })
      }
    } catch (error: Exception) {
      if (closed || Thread.currentThread().isInterrupted) throw NetworkFailure("网络请求已取消")
      throw NetworkFailure("服务器未允许或不支持列出共享；可填写已知共享名称直连（${error.javaClass.simpleName}）")
    }
  }

  @Synchronized
  override fun list(relative: String): List<RemoteEntry> {
    if (diskShare == null) {
      if (NetworkPaths.segments(relative).isNotEmpty()) throw NetworkFailure("请先选择 SMB 共享")
      return shares().map { RemoteEntry(it.name, 0, true) }
    }
    val path = checked(relative)
    return share.openDirectory(path, setOf(AccessMask.FILE_LIST_DIRECTORY, AccessMask.FILE_READ_ATTRIBUTES),
      EnumSet.noneOf(FileAttributes::class.java), sharing, SMB2CreateDisposition.FILE_OPEN,
      setOf(SMB2CreateOptions.FILE_DIRECTORY_FILE, SMB2CreateOptions.FILE_OPEN_REPARSE_POINT)).use { directory ->
      directory.list().filter { it.fileName != "." && it.fileName != ".." && it.fileAttributes and reparse == 0L }
        .map { RemoteEntry(it.fileName, it.endOfFile.coerceAtLeast(0),
          it.fileAttributes and FileAttributes.FILE_ATTRIBUTE_DIRECTORY.value != 0L, smbModifiedMs(it.lastWriteTime)) }
    }
  }

  @Synchronized
  override fun stat(relative: String): RemoteStat {
    return try {
      val info = share.getFileInformation(checked(relative))
      val standard = info.standardInformation
      RemoteStat(if (standard.isDirectory) "dir" else "file", if (standard.isDirectory) 0 else standard.endOfFile.coerceAtLeast(0),
        smbModifiedMs(info.basicInformation.lastWriteTime))
    } catch (error: SMBApiException) {
      if (error.statusCode == 0xC0000034L || error.statusCode == 0xC000003AL || error.statusCode == 0xC000000FL) {
        RemoteStat("missing", 0)
      } else throw error
    }
  }

  // 播放期间同一部片子会被反复 Range 请求，每个请求都 openFile 一次 CREATE 往返，
  // 在局域网里就是几十毫秒的固定成本。这里复用同一个句柄（PositionedNetworkStream
  // 按 position 读，不依赖文件指针），换文件/换大小才重新打开。
  private var mediaFile: com.hierynomus.smbj.share.File? = null
  private var mediaPath = ""
  private var mediaSize = -1L

  private fun mediaHandle(relative: String, total: Long): com.hierynomus.smbj.share.File {
    val current = mediaFile
    if (current != null && mediaPath == relative && mediaSize == total) return current
    current?.let { runCatching { it.closeNoWait() } }
    mediaFile = null
    val opened = share.openFile(checked(relative), setOf(AccessMask.FILE_READ_DATA, AccessMask.FILE_READ_ATTRIBUTES),
      EnumSet.noneOf(FileAttributes::class.java), sharing, SMB2CreateDisposition.FILE_OPEN,
      setOf(SMB2CreateOptions.FILE_NON_DIRECTORY_FILE, SMB2CreateOptions.FILE_OPEN_REPARSE_POINT))
    if (opened.fileInformation.basicInformation.fileAttributes and reparse != 0L) {
      opened.closeNoWait()
      throw NetworkFailure("不允许读取 SMB 符号链接")
    }
    if (opened.length != total) {
      opened.closeNoWait()
      throw NetworkFailure("远端文件大小已改变，请重新打开视频")
    }
    mediaFile = opened
    mediaPath = relative
    mediaSize = total
    return opened
  }

  @Synchronized
  override fun open(relative: String, start: Long, length: Long, total: Long): InputStream {
    val file = mediaHandle(relative, total)
    return java.io.BufferedInputStream(PositionedNetworkStream(start, length,
      { position, buffer, offset, count -> file.read(buffer, position, offset, count) }, { /* 句柄由 mediaHandle 复用，不在每个流结束时关闭 */ }), 256 * 1024)
  }

  @Synchronized
  override fun readAtExact(relative: String, position: Long, buffer: ByteArray, offset: Int, length: Int, total: Long): Int {
    if (position < 0 || total < 0 || position > total || length < 0 || length > 65536 ||
      offset < 0 || offset > buffer.size || length > buffer.size - offset || length.toLong() > total - position) {
      throw NetworkFailure("网络随机读取范围无效")
    }
    if (length == 0) return 0
    if (exactFile == null || exactPath != relative || exactSize != total) {
      exactFile?.closeNoWait()
      exactFile = null
      val opened = share.openFile(checked(relative), setOf(AccessMask.FILE_READ_DATA, AccessMask.FILE_READ_ATTRIBUTES),
        EnumSet.noneOf(FileAttributes::class.java), sharing, SMB2CreateDisposition.FILE_OPEN,
        setOf(SMB2CreateOptions.FILE_NON_DIRECTORY_FILE, SMB2CreateOptions.FILE_OPEN_REPARSE_POINT))
      try {
        val info = opened.fileInformation
        if (info.basicInformation.fileAttributes and reparse != 0L) throw NetworkFailure("不允许读取 SMB 符号链接")
        if (info.standardInformation.endOfFile != total) throw NetworkFailure("远端文件大小已改变，请重新打开视频")
        exactFile = opened; exactPath = relative; exactSize = total
      } catch (error: Exception) { opened.closeNoWait(); throw error }
    }
    return exactFile!!.read(buffer, position, offset, length)
  }

  @Synchronized
  override fun publishAudioCache(videoRelative: String, audioIndex: Int, jobId: String, input: java.io.File,
    expected: RemoteStat, cancellation: AudioCancellation): String {
    val names = AudioCacheNames.derive(videoRelative, audioIndex, jobId)
    val size = AudioCacheTransfer.inputSize(input)
    cancellation.check()
    AudioCacheTransfer.verifyVideo(expected, stat(names.video))
    if (stat(names.final).kind != "missing") throw NetworkFailure("同名音轨缓存已存在，未覆盖任何文件")
    checked(names.parent)
    val temporary = share.openFile(path(names.temporary), setOf(AccessMask.FILE_WRITE_DATA, AccessMask.FILE_READ_ATTRIBUTES, AccessMask.DELETE),
      EnumSet.noneOf(FileAttributes::class.java), emptySet(), SMB2CreateDisposition.FILE_CREATE,
      setOf(SMB2CreateOptions.FILE_NON_DIRECTORY_FILE, SMB2CreateOptions.FILE_OPEN_REPARSE_POINT))
    cancellation.onCancel {
      if (!cancellation.commitAttempted) runCatching { temporary.deleteOnClose() }
      abort()
    }
    try {
      AudioCacheTransfer.copy(input, size, cancellation) { position, bytes, offset, count ->
        val written = temporary.write(bytes, position, offset, count)
        if (written !in 1..count.toLong()) throw NetworkFailure("SMB 音轨缓存写入长度无效")
        written.toInt()
      }
      temporary.flush()
      val information = temporary.fileInformation
      if (information.basicInformation.fileAttributes and reparse != 0L || information.standardInformation.endOfFile != size) {
        throw NetworkFailure("SMB 临时音轨缓存校验失败")
      }
      AudioCacheTransfer.verifyVideo(expected, stat(names.video))
      checked(names.parent)
      cancellation.commit { temporary.rename(path(names.final), false) }
      return names.final
    } catch (error: Exception) {
      if (cancellation.commitAttempted && !cancellation.published) throw NetworkFailure("SMB 发布结果未确认，未重试或删除正式缓存；请重新浏览检查")
      throw error
    } finally {
      if (!cancellation.commitAttempted) runCatching { temporary.deleteOnClose() }
      runCatching { temporary.close() }
    }
  }

  override fun isConnected(): Boolean = !closed && connection.isConnected && (diskShare?.isConnected ?: true)

  override fun abort() { closed = true; sockets.closeAll() }

  override fun close() {
    mediaFile?.let { runCatching { it.closeNoWait() } }
    mediaFile = null
    abort()
    runCatching { connection.close(true) }
    client.close()
  }

  private class TimeoutSocketFactory(private val cancellation: ThumbnailCancellation?) : SocketFactory() {
    private val opened = java.util.concurrent.ConcurrentHashMap.newKeySet<Socket>()
    private var closed = false
    @Synchronized
    fun closeAll() { closed = true; opened.forEach { runCatching { it.close() } }; opened.clear() }
    @Synchronized
    override fun createSocket(): Socket {
      cancellation?.check()
      if (closed) throw java.net.SocketException("SMB connection cancelled")
      return object : Socket() {
        override fun connect(endpoint: SocketAddress?) {
          cancellation?.check()
          super.connect(endpoint, 10000)
          // 不开 TCP_NODELAY 时 Nagle + 延迟 ACK 会把每个 SMB 请求再拖上几十毫秒，
          // 局域网里 1 MiB 读要 170 ms 就是这么来的。
          runCatching { tcpNoDelay = true }
        }
        override fun connect(endpoint: SocketAddress?, timeout: Int) {
          cancellation?.check()
          super.connect(endpoint, if (timeout == 0) 8000 else minOf(timeout, 8000))
          runCatching { tcpNoDelay = true }
        }
      }.also { opened.add(it) }
    }
    override fun createSocket(host: String, port: Int): Socket = createSocket().apply { connect(java.net.InetSocketAddress(host, port)) }
    override fun createSocket(host: String, port: Int, localHost: InetAddress, localPort: Int): Socket =
      createSocket().apply { bind(java.net.InetSocketAddress(localHost, localPort)); connect(java.net.InetSocketAddress(host, port)) }
    override fun createSocket(host: InetAddress, port: Int): Socket = createSocket().apply { connect(java.net.InetSocketAddress(host, port)) }
    override fun createSocket(host: InetAddress, port: Int, localHost: InetAddress, localPort: Int): Socket =
      createSocket().apply { bind(java.net.InetSocketAddress(localHost, localPort)); connect(java.net.InetSocketAddress(host, port)) }
  }
}
