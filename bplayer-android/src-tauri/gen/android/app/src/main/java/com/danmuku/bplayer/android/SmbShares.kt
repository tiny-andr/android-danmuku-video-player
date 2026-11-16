package com.danmuku.bplayer.android

import java.io.InputStream
import java.util.Locale

internal data class SmbShareInfo(val name: String, val comment: String)

internal object SmbShares {
  fun validName(name: String): Boolean = name.isNotEmpty() && name.length <= 255 &&
    name != "." && name != ".." && !name.endsWith('.') && !name.endsWith(' ') &&
    name.none { it.code < 32 || it.code == 127 || it in "/\\:*?\"<>|" }

  fun visibleDisk(name: String, type: Int): Boolean = validName(name) && !name.endsWith('$') &&
    type and 0xffff == 0 && type and Int.MIN_VALUE == 0

  fun clean(entries: List<Triple<String, Int, String>>): List<SmbShareInfo> = entries
    .filter { visibleDisk(it.first, it.second) }
    .distinctBy { it.first.lowercase(Locale.ROOT) }
    .sortedBy { it.first.lowercase(Locale.ROOT) }
    .map { SmbShareInfo(it.first, it.third.take(1024)) }

  fun resolve(source: NetworkSource, relative: String): Pair<NetworkSource, String> {
    if (source.protocol != "smb" || source.scope != "server") return source to relative
    val segments = NetworkPaths.segments(relative)
    val share = segments.firstOrNull() ?: throw NetworkFailure("请先选择 SMB 共享")
    if (!validName(share)) throw NetworkFailure("SMB 共享名称无效")
    return source.copy(scope = "share", share = share, root = "") to segments.drop(1).joinToString("/")
  }
}

internal class SmbServerNetworkRemote(
  private val source: NetworkSource,
  private val connections: NetworkConnections,
  private val role: NetworkRole,
  private val owned: Boolean = false
) : NetworkRemote {
  @Volatile private var closed = false

  private fun <Result> withShare(relative: String, action: (NetworkSource, String, NetworkRemote) -> Result): Result {
    if (closed) throw NetworkFailure("网络请求已取消")
    val (bound, path) = SmbShares.resolve(source, relative)
    return connections.runBound(bound, role) { remote -> action(bound, path, remote) }
  }

  override fun list(relative: String): List<RemoteEntry> {
    if (closed) throw NetworkFailure("网络请求已取消")
    return if (NetworkPaths.segments(relative).isEmpty()) {
      connections.runBound(source, role) { it.list("") }
    } else withShare(relative) { _, path, remote -> remote.list(path) }
  }

  override fun stat(relative: String): RemoteStat = if (NetworkPaths.segments(relative).isEmpty()) {
    if (closed) throw NetworkFailure("网络请求已取消")
    RemoteStat("dir", 0)
  } else withShare(relative) { _, path, remote -> remote.stat(path) }

  override fun open(relative: String, start: Long, length: Long, total: Long): InputStream =
    withShare(relative) { bound, path, remote ->
      connections.watch(bound, role, remote, remote.open(path, start, length, total))
    }

  override fun readAtExact(relative: String, position: Long, buffer: ByteArray, offset: Int, length: Int, total: Long): Int =
    withShare(relative) { _, path, remote -> remote.readAtExact(path, position, buffer, offset, length, total) }

  override fun isConnected(): Boolean = !closed
  override fun abort() {
    closed = true
    if (owned) connections.close()
  }
  override fun close() { abort() }
}
