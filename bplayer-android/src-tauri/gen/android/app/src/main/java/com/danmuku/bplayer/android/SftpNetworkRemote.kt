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
      timeoutMs = 20000
      channelReadTimeoutMs = 20000
    }
    ssh = SSHClient(config).apply { connectTimeout = 10000; timeout = 20000 }
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
    .map { RemoteEntry(it.name, it.attributes.size.coerceAtLeast(0), it.isDirectory) }

  @Synchronized
  override fun stat(relative: String): RemoteStat = try {
    val attributes = sftp.stat(checked(relative))
    when (attributes.type) {
      FileMode.Type.DIRECTORY -> RemoteStat("dir", 0)
      FileMode.Type.REGULAR -> RemoteStat("file", attributes.size.coerceAtLeast(0))
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

  override fun close() { runCatching { sftp.close() }; runCatching { ssh.close() } }

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
