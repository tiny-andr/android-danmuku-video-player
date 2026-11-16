package com.danmuku.bplayer.android

import android.util.Base64
import net.schmizz.sshj.DefaultConfig
import net.schmizz.sshj.SSHClient
import net.schmizz.sshj.common.Buffer
import net.schmizz.sshj.sftp.FileMode
import net.schmizz.sshj.sftp.OpenMode
import net.schmizz.sshj.sftp.Response
import net.schmizz.sshj.sftp.SFTPClient
import net.schmizz.sshj.sftp.SFTPException
import net.schmizz.sshj.transport.verification.HostKeyVerifier
import org.bouncycastle.jce.provider.BouncyCastleProvider
import java.io.InputStream
import java.security.MessageDigest
import java.security.PublicKey
import java.security.Security

internal class HostFingerprintRequired(val fingerprint: String) : java.io.IOException()

internal class SftpNetworkRemote(private val source: NetworkSource) : NetworkRemote {
  private val ssh: SSHClient
  private val sftp: SFTPClient
  private val canonicalRoot: String
  @Volatile private var closed = false

  override fun isConnected(): Boolean = !closed && ssh.isConnected && ssh.isAuthenticated && ssh.transport.isRunning
  override fun abort() { closed = true; runCatching { ssh.socket.close() } }

  init {
    prepareCrypto()
    val config = DefaultConfig().apply {
      keyExchangeFactories = keyExchangeFactories.filter {
        it.name.startsWith("curve25519-") || it.name.startsWith("ecdh-sha2-") ||
          it.name == "diffie-hellman-group14-sha256" || it.name == "diffie-hellman-group16-sha512" ||
          it.name == "diffie-hellman-group18-sha512"
      }
      cipherFactories = cipherFactories.filter { it.name.contains("-gcm@") || it.name.endsWith("-ctr") || it.name.startsWith("chacha20-poly1305@") }
      keyAlgorithms = keyAlgorithms.filter {
        it.name == "ssh-ed25519" || it.name.startsWith("ecdsa-sha2-") || it.name == "rsa-sha2-256" || it.name == "rsa-sha2-512"
      }
      macFactories = macFactories.filter { it.name.startsWith("hmac-sha2-") }
      timeoutMs = 8000
      channelReadTimeoutMs = 8000
    }
    ssh = SSHClient(config).apply { connectTimeout = 8000; timeout = 8000 }
    var observed: String? = null
    var mismatch = false
    ssh.addHostKeyVerifier(object : HostKeyVerifier {
      override fun verify(hostname: String, port: Int, key: PublicKey): Boolean {
        val bytes = Buffer.PlainBuffer().putPublicKey(key).compactData
        val fingerprint = "SHA256:" + Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(bytes), Base64.NO_WRAP or Base64.NO_PADDING)
        observed = fingerprint
        if (source.hostKey.isEmpty()) return false
        val matches = MessageDigest.isEqual(fingerprint.toByteArray(Charsets.US_ASCII), source.hostKey.toByteArray(Charsets.US_ASCII))
        mismatch = !matches
        return matches
      }
      override fun findExistingAlgorithms(hostname: String, port: Int): List<String> = emptyList()
    })
    try {
      ssh.connect(source.host, source.port)
      ssh.authPassword(source.username, source.password)
      sftp = ssh.newSFTPClient()
      canonicalRoot = sftp.canonicalize("/" + source.root).trimEnd('/').ifEmpty { "/" }
      if (sftp.stat(canonicalRoot).type != FileMode.Type.DIRECTORY) throw NetworkFailure("SFTP 根路径不是目录")
    } catch (error: Exception) {
      runCatching { ssh.close() }
      if (source.hostKey.isEmpty() && observed != null) throw HostFingerprintRequired(observed!!)
      if (mismatch) throw NetworkFailure("SFTP 主机指纹不匹配，已拒绝连接，请核对服务器身份")
      throw error
    }
  }

  private fun checked(relative: String): String {
    val segments = NetworkPaths.segments(relative)
    var path = canonicalRoot
    segments.forEach { segment ->
      path = path.trimEnd('/') + "/" + segment
      val attributes = sftp.lstat(path)
      if (attributes.type == FileMode.Type.SYMLINK) throw NetworkFailure("为保护存储根目录，不允许访问 SFTP 符号链接")
    }
    val canonical = sftp.canonicalize(path).trimEnd('/').ifEmpty { "/" }
    if (canonicalRoot != "/" && canonical != canonicalRoot && !canonical.startsWith("$canonicalRoot/")) {
      throw NetworkFailure("SFTP 路径超出存储根目录")
    }
    return canonical
  }

  @Synchronized
  override fun list(relative: String): List<RemoteEntry> = sftp.ls(checked(relative))
    .filter { it.name != "." && it.name != ".." && (it.isDirectory || it.isRegularFile) }
    .map { RemoteEntry(it.name, it.attributes.size.coerceAtLeast(0), it.isDirectory, modified(it.attributes)) }

  private fun modified(attributes: net.schmizz.sshj.sftp.FileAttributes): Long? =
    attributes.mtime.takeIf { it > 0 && it <= Long.MAX_VALUE / 1000 }?.times(1000)

  @Synchronized
  override fun stat(relative: String): RemoteStat = try {
    val attributes = sftp.stat(checked(relative))
    when (attributes.type) {
      FileMode.Type.DIRECTORY -> RemoteStat("dir", 0, modified(attributes))
      FileMode.Type.REGULAR -> RemoteStat("file", attributes.size.coerceAtLeast(0), modified(attributes))
      else -> throw NetworkFailure("不允许访问此 SFTP 文件类型")
    }
  } catch (error: SFTPException) {
    if (error.statusCode == Response.StatusCode.NO_SUCH_FILE || error.statusCode == Response.StatusCode.NO_SUCH_PATH) {
      RemoteStat("missing", 0)
    } else throw error
  }

  @Synchronized
  override fun open(relative: String, start: Long, length: Long, total: Long): InputStream {
    val file = sftp.open(checked(relative), setOf(OpenMode.READ))
    try {
      if (file.length() != total) throw NetworkFailure("远端文件大小已改变，请重新打开视频")
      val ahead = file.ReadAheadRemoteFileInputStream(15, start, length)
      val buffered = java.io.BufferedInputStream(ahead, 65536)
      return LimitedNetworkStream(buffered, length) { file.close() }
    } catch (error: Exception) { file.close(); throw error }
  }

  @Synchronized
  override fun readAtExact(relative: String, position: Long, buffer: ByteArray, offset: Int, length: Int, total: Long): Int {
    require(position >= 0 && offset >= 0 && length >= 0 && offset <= buffer.size - length)
    if (length == 0) return 0
    if (position >= total) return -1
    return sftp.open(checked(relative), setOf(OpenMode.READ)).use { file ->
      if (file.length() != total) throw NetworkFailure("远端文件大小已改变，请重新打开视频")
      file.read(position, buffer, offset, minOf(length.toLong(), total - position, 64 * 1024L).toInt())
    }
  }

  @Synchronized
  override fun publishAudioCache(videoRelative: String, audioIndex: Int, jobId: String, input: java.io.File,
    expected: RemoteStat, cancellation: AudioCancellation): String {
    val names = AudioCacheNames.derive(videoRelative, audioIndex, jobId)
    val size = AudioCacheTransfer.inputSize(input)
    cancellation.check()
    AudioCacheTransfer.verifyVideo(expected, stat(names.video))
    if (stat(names.final).kind != "missing") throw NetworkFailure("同名音轨缓存已存在，未覆盖任何文件")
    val parent = checked(names.parent)
    val temporaryPath = parent.trimEnd('/') + "/" + names.temporary.substringAfterLast('/')
    val finalPath = parent.trimEnd('/') + "/" + names.final.substringAfterLast('/')
    var created = false
    cancellation.onCancel { abort() }
    try {
      sftp.open(temporaryPath, setOf(OpenMode.CREAT, OpenMode.EXCL, OpenMode.WRITE)).use { temporary ->
        created = true
        AudioCacheTransfer.copy(input, size, cancellation) { position, bytes, offset, count ->
          temporary.write(position, bytes, offset, count)
          count
        }
        val attributes = temporary.fetchAttributes()
        if (attributes.type != FileMode.Type.REGULAR || attributes.size != size) throw NetworkFailure("SFTP 临时音轨缓存校验失败")
      }
      cancellation.check()
      if (checked(names.parent) != parent || checked(names.temporary) != temporaryPath) throw NetworkFailure("SFTP 缓存路径发生变化")
      val attributes = sftp.lstat(temporaryPath)
      if (attributes.type != FileMode.Type.REGULAR || attributes.size != size) throw NetworkFailure("SFTP 临时缓存关闭后校验失败")
      AudioCacheTransfer.verifyVideo(expected, stat(names.video))
      cancellation.commit { sftp.rename(temporaryPath, finalPath, emptySet()) }
      return names.final
    } catch (error: Exception) {
      if (cancellation.commitAttempted && !cancellation.published) throw NetworkFailure("SFTP 发布结果未确认，未重试或删除正式缓存；请重新浏览检查")
      if (created) throw NetworkFailure("SFTP 音轨缓存未发布；为避免误删，已保留本任务专属临时文件（${error.javaClass.simpleName}）")
      throw error
    }
  }

  override fun close() { abort(); runCatching { sftp.close() }; runCatching { ssh.close() } }

  companion object {
    @Synchronized
    private fun prepareCrypto() {
      val provider = Security.getProvider("BC")
      if (provider !is BouncyCastleProvider) {
        if (provider != null) Security.removeProvider("BC")
        Security.addProvider(BouncyCastleProvider())
      }
    }
  }
}
