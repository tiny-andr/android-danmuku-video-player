package com.danmuku.bplayer.android

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal class NetworkFailure(message: String) : IOException(message)

internal object NetworkPaths {
  fun segments(path: String): List<String> {
    if (path.length > 8192 || path.any { it == '\\' || it.code < 32 || it.code == 127 }) {
      throw NetworkFailure("网络路径含有不允许的字符")
    }
    val parts = path.trim('/').split('/').filter { it.isNotEmpty() }
    if (parts.any { it == "." || it == ".." }) throw NetworkFailure("网络路径不允许越过根目录")
    return parts
  }

  fun parse(path: String): NetworkPath {
    if (!path.startsWith("/@network/")) throw NetworkFailure("不是有效的网络存储路径")
    val parts = segments(path)
    if (parts.size < 2 || parts[0] != "@network") throw NetworkFailure("网络存储路径不完整")
    val id = uuid(parts[1])
    return NetworkPath(id, parts.drop(2).joinToString("/"))
  }

  fun uuid(value: String): String {
    val parsed = try { UUID.fromString(value).toString() } catch (_: Exception) {
      throw NetworkFailure("网络存储标识无效")
    }
    if (parsed != value.lowercase()) throw NetworkFailure("网络存储标识无效")
    return parsed
  }

  fun child(parent: String, name: String): String {
    if (name.isEmpty() || name.contains('/') || segments(name).size != 1) {
      throw NetworkFailure("远端返回了不安全的文件名")
    }
    return parent.trimEnd('/') + "/" + name
  }
}

internal data class NetworkPath(val id: String, val relative: String) {
  val virtual: String get() = "/@network/$id" + if (relative.isEmpty()) "" else "/$relative"
}

internal data class NetworkSource(
  val id: String,
  val name: String,
  val protocol: String,
  val host: String,
  val port: Int,
  val root: String,
  val username: String,
  val password: String,
  val domain: String,
  val share: String,
  val url: String,
  val hostKey: String
) {
  fun json(secret: Boolean = false): JSONObject = JSONObject().apply {
    put("id", id); put("name", name); put("protocol", protocol)
    put("host", host); put("port", port); put("root", root)
    put("username", username); put("domain", domain); put("share", share)
    put("url", url); put("hostKey", hostKey)
    if (secret) put("password", password) else put("hasPassword", password.isNotEmpty())
  }

  companion object {
    fun from(json: JSONObject, previous: NetworkSource? = null): NetworkSource {
      val id = json.optString("id").takeIf { it.isNotBlank() && it != "null" }
        ?.let(NetworkPaths::uuid) ?: UUID.randomUUID().toString()
      val protocol = json.optString("protocol").lowercase()
      if (protocol !in setOf("smb", "sftp", "webdav")) throw NetworkFailure("不支持的网络存储协议")
      val name = json.optString("name").trim()
      if (name.isEmpty() || name.length > 128) throw NetworkFailure("请输入有效的存储名称")
      val host = json.optString("host").trim()
      if (protocol != "webdav" && (host.isEmpty() || host.any { it.isWhitespace() || it in "/\\@?#" })) {
        throw NetworkFailure("请输入有效的服务器地址")
      }
      val port = json.optInt("port", if (protocol == "smb") 445 else if (protocol == "sftp") 22 else 443)
      if (port !in 1..65535) throw NetworkFailure("服务器端口必须在 1 至 65535 之间")
      val root = NetworkPaths.segments(json.optString("root")).joinToString("/")
      val share = json.optString("share").trim()
      if (protocol == "smb" && (share.isEmpty() || share.contains('/') || NetworkPaths.segments(share).size != 1)) {
        throw NetworkFailure("请输入有效的 SMB 共享名称")
      }
      val key = json.optString("hostKey").trim()
      if (key.isNotEmpty() && !Regex("SHA256:[A-Za-z0-9+/]{43}=?").matches(key)) {
        throw NetworkFailure("SFTP 主机指纹必须是 SHA256 格式")
      }
      val password = json.optString("password").takeIf { it.isNotEmpty() } ?: previous?.password.orEmpty()
      return NetworkSource(id, name, protocol, host, port, root, json.optString("username"),
        password, json.optString("domain"), share, json.optString("url").trim(), key.trimEnd('='))
    }
  }
}

internal class NetworkSourceStore(context: Context) {
  private val file = AtomicFile(File(context.noBackupFilesDir, "network-sources.aes"))
  private val alias = "bplayer.network.sources.v1"
  private val aad = "bplayer.network.sources.v1".toByteArray(Charsets.UTF_8)

  private fun key(): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (store.getKey(alias, null) as? SecretKey)?.let { return it }
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
      init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setRandomizedEncryptionRequired(true).build())
    }.generateKey()
  }

  @Synchronized
  fun all(): List<NetworkSource> {
    if (!file.baseFile.exists()) return emptyList()
    try {
      val encoded = JSONObject(file.openRead().use { String(it.readBytes(), Charsets.UTF_8) })
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(encoded.getString("iv"), Base64.NO_WRAP)))
      cipher.updateAAD(aad)
      val array = JSONArray(String(cipher.doFinal(Base64.decode(encoded.getString("data"), Base64.NO_WRAP)), Charsets.UTF_8))
      return (0 until array.length()).map { NetworkSource.from(array.getJSONObject(it)) }
    } catch (_: Exception) {
      throw NetworkFailure("无法解密网络存储配置，请检查设备密钥是否可用")
    }
  }

  @Synchronized
  fun get(id: String): NetworkSource = all().find { it.id == id } ?: throw NetworkFailure("网络存储已删除或尚未保存")

  @Synchronized
  fun save(source: NetworkSource) {
    val sources = all().filterNot { it.id == source.id } + source
    persist(sources)
  }

  @Synchronized
  fun remove(id: String) { persist(all().filterNot { it.id == id }) }

  private fun persist(sources: List<NetworkSource>) {
    if (sources.size > 64) throw NetworkFailure("网络存储数量已达到上限")
    val array = JSONArray().apply { sources.forEach { put(it.json(true)) } }
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, key())
    cipher.updateAAD(aad)
    val data = cipher.doFinal(array.toString().toByteArray(Charsets.UTF_8))
    val envelope = JSONObject().put("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
      .put("data", Base64.encodeToString(data, Base64.NO_WRAP)).toString().toByteArray(Charsets.UTF_8)
    val output = file.startWrite()
    try { output.write(envelope); file.finishWrite(output) }
    catch (error: Exception) { file.failWrite(output); throw NetworkFailure("保存加密网络存储配置失败") }
  }
}
