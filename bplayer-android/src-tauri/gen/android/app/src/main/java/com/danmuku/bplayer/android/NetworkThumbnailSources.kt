package com.danmuku.bplayer.android

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build

internal class NetworkThumbnailSources(context: Context) {
  private val context = context.applicationContext
  private val store = NetworkSourceStore(this.context)

  fun open(path: String, cancellation: ThumbnailCancellation): ThumbnailRangeSource {
    cancellation.check()
    if (Build.VERSION.SDK_INT >= 37 && context.checkSelfPermission("android.permission.ACCESS_LOCAL_NETWORK") != PackageManager.PERMISSION_GRANTED) {
      throw NetworkFailure("未获得局域网访问权限")
    }
    val parsed = NetworkPaths.parse(path)
    val configured = store.get(parsed.id)
    val resolved = if (configured.protocol == "smb") SmbShares.resolve(configured, parsed.relative)
      else configured to parsed.relative
    val source = resolved.first
    val relative = resolved.second
    cancellation.check()
    val remote = when (source.protocol) {
      "smb" -> SmbNetworkRemote(source, cancellation)
      "sftp" -> SftpNetworkRemote(source)
      "webdav" -> WebDavNetworkRemote(source)
      else -> throw NetworkFailure("不支持的网络存储协议")
    }
    cancellation.onCancel { remote.abort() }
    try {
      cancellation.check()
      val stat = remote.stat(relative)
      if (stat.kind != "file" || stat.size <= 0) throw NetworkFailure("缩略图片源不是有效文件")
      cancellation.check()
      return object : ThumbnailRangeSource {
        override val size = stat.size
        override val modifiedMs = stat.modifiedMs
        override fun readAt(position: Long, buffer: ByteArray, offset: Int, length: Int): Int {
          cancellation.check()
          return remote.readAtExact(relative, position, buffer, offset, length, size)
        }
        override fun abort() { remote.abort() }
        override fun close() { remote.close() }
      }
    } catch (error: Exception) {
      remote.abort()
      runCatching { remote.close() }
      throw error
    }
  }
}
