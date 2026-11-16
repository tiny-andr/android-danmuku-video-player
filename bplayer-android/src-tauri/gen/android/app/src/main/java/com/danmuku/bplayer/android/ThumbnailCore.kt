package com.danmuku.bplayer.android

import java.io.Closeable
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean

internal interface ThumbnailRangeSource : Closeable {
  val size: Long
  val modifiedMs: Long?
  fun readAt(position: Long, buffer: ByteArray, offset: Int, length: Int): Int
  fun abort()
}

internal class ThumbnailCancellation(private val deadlineNanos: Long = System.nanoTime() + 4_000_000_000L) {
  private val cancelled = AtomicBoolean(false)
  private val callbacks = CopyOnWriteArrayList<() -> Unit>()
  fun check() {
    if (cancelled.get() || System.nanoTime() >= deadlineNanos) throw IOException("Thumbnail cancelled or timed out")
  }
  fun onCancel(callback: () -> Unit) {
    callbacks.add(callback)
    if (cancelled.get()) callback()
  }
  fun cancel() {
    if (cancelled.compareAndSet(false, true)) callbacks.forEach { runCatching { it() } }
  }
}

internal class ThumbnailDecoderGate {
  private var owner: String? = null
  private var stopping = false
  @Synchronized
  fun claim(id: String): Boolean {
    if (owner != null) return false
    owner = id
    stopping = false
    return true
  }
  @Synchronized
  fun stopOnce(id: String): Boolean {
    if (owner != id || stopping) return false
    stopping = true
    return true
  }
  @Synchronized
  fun release(id: String) { if (owner == id) { owner = null; stopping = false } }
}

internal class ThumbnailBudget(
  private val source: ThumbnailRangeSource,
  private val cancellation: ThumbnailCancellation,
  private val maximumBytes: Long = 12L * 1024 * 1024
) : Closeable {
  @Volatile var reservedBytes: Long = 0
    private set
  @Volatile var readCalls: Long = 0
    private set
  @Synchronized
  fun readAt(position: Long, buffer: ByteArray, offset: Int, length: Int): Int {
    cancellation.check()
    if (position < 0 || offset < 0 || length < 0 || offset > buffer.size - length) throw IOException("Invalid thumbnail read")
    if (length == 0) return 0
    if (position >= source.size) return -1
    val count = minOf(length.toLong(), 65536L, source.size - position).toInt()
    if (count > maximumBytes - reservedBytes) throw IOException("Thumbnail byte budget exceeded")
    reservedBytes += count
    readCalls++
    val received = source.readAt(position, buffer, offset, count)
    cancellation.check()
    if (received <= 0 || received > count) throw IOException("Invalid thumbnail source response")
    return received
  }
  override fun close() { source.close() }
}

internal class ThumbnailReadCache(
  private val size: Long,
  private val reader: (Long, ByteArray, Int, Int) -> Int,
  private val blockSize: Int = 65536,
  private val maxBlocks: Int = 32
) {
  private val blocks = java.util.LinkedHashMap<Long, ByteArray>(maxBlocks, 0.75f, true)
  init {
    require(size >= 0 && blockSize in 1..65536 && maxBlocks in 1..32)
  }
  @Synchronized
  fun readAt(position: Long, buffer: ByteArray, offset: Int, length: Int): Int {
    if (position < 0 || offset < 0 || length < 0 || offset > buffer.size - length) throw IOException("Invalid thumbnail cache read")
    if (length == 0) return 0
    if (position >= size) return -1
    val requested = minOf(length.toLong(), 65536L, size - position).toInt()
    var copied = 0
    while (copied < requested) {
      val current = position + copied
      val start = current - current % blockSize
      val block = blocks[start] ?: ByteArray(minOf(blockSize.toLong(), size - start).toInt()).also { created ->
        var received = 0
        while (received < created.size) {
          val count = reader(start + received, created, received, created.size - received)
          if (count <= 0 || count > created.size - received) throw IOException("Invalid thumbnail cached source response")
          received += count
        }
        blocks[start] = created
        if (blocks.size > maxBlocks) blocks.remove(blocks.keys.first())
      }
      val within = (current - start).toInt()
      val count = minOf(requested - copied, block.size - within)
      System.arraycopy(block, within, buffer, offset + copied, count)
      copied += count
    }
    return copied
  }
}

internal object ThumbnailPaths {
  fun stable(path: String): String {
    if (path.isEmpty() || path.length > 8192 || path.any { it.code < 32 || it.code == 127 || it == '\\' }) throw IOException("Invalid thumbnail path")
    val segments = path.split('/').filter { it.isNotEmpty() }
    if (segments.any { it == "." || it == ".." }) throw IOException("Invalid thumbnail path")
    if (path.startsWith("/@network/")) {
      if (segments.size < 3 || !Regex("[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}").matches(segments[1])) throw IOException("Invalid thumbnail source")
      return "/" + segments.joinToString("/")
    }
    if (!path.startsWith("/storage/") && !path.startsWith("/sdcard/")) throw IOException("Thumbnail path outside storage")
    val canonical = File(path).canonicalPath
    if (!canonical.startsWith("/storage/")) throw IOException("Thumbnail path outside storage")
    return canonical
  }
  fun hash(value: String): String = MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8))
    .joinToString("") { byte -> "%02x".format(byte.toInt() and 255) }
}

internal object ThumbnailFrames {
  fun positions(durationUs: Long?): LongArray {
    if (durationUs == null || durationUs <= 0) return longArrayOf(1_000_000L, 10_000_000L)
    val duration = durationUs.coerceAtMost(Long.MAX_VALUE / 4)
    val last = (duration - 1).coerceAtLeast(0)
    val first = minOf(30_000_000L, duration / 10).coerceAtLeast(1_000_000L).coerceAtMost(last)
    val later = minOf(maxOf(first + 1_000_000L, duration / 4), first + 30_000_000L).coerceAtMost(last)
    return if (later > first) longArrayOf(first, later) else longArrayOf(first)
  }
  fun nearBlack(pixels: IntArray): Boolean {
    if (pixels.isEmpty()) return true
    var total = 0L
    var dark = 0
    pixels.forEach { pixel ->
      val red = pixel ushr 16 and 255
      val green = pixel ushr 8 and 255
      val blue = pixel and 255
      val luminance = (54 * red + 183 * green + 19 * blue) / 256
      total += luminance
      if (luminance <= 12) dark++
    }
    return total <= pixels.size * 8L && dark.toLong() * 100 >= pixels.size * 98L
  }
}

internal class ThumbnailCache(private val directory: File, private val maximumBytes: Long = 32L * 1024 * 1024) {
  init { directory.mkdirs() }
  private fun prefix(path: String): String = "v2_" + ThumbnailPaths.hash(path) + "_"
  private fun name(path: String, size: Long, modifiedMs: Long?): String = prefix(path) + ThumbnailPaths.hash("$size:${modifiedMs ?: "unknown"}") + ".jpg"
  @Synchronized
  fun get(path: String, size: Long?, modifiedMs: Long?): ByteArray? {
    if (size == null || size < 0) return null
    val file = File(directory, name(path, size, modifiedMs))
    if (!file.isFile || file.length() !in 1..262144L) return null
    return runCatching { file.readBytes().also { file.setLastModified(System.currentTimeMillis()) } }.getOrNull()
  }
  @Synchronized
  fun latest(path: String): ByteArray? {
    val file = directory.listFiles()?.filter { it.name.startsWith(prefix(path)) && it.name.endsWith(".jpg") }
      ?.maxByOrNull { it.lastModified() } ?: return null
    if (!file.isFile || file.length() !in 1..262144L) return null
    return runCatching { file.readBytes().also { file.setLastModified(System.currentTimeMillis()) } }.getOrNull()
  }
  @Synchronized
  fun put(path: String, size: Long, modifiedMs: Long?, bytes: ByteArray) {
    if (bytes.isEmpty() || bytes.size > 262144) return
    val file = File(directory, name(path, size, modifiedMs))
    val temporary = File(directory, file.name + ".tmp")
    try {
      temporary.writeBytes(bytes)
      if (!temporary.renameTo(file)) { temporary.delete(); return }
      directory.listFiles()?.filter { it.name.startsWith(prefix(path)) && it.name.endsWith(".jpg") && it.name != file.name }
        ?.forEach { it.delete() }
      var total = directory.listFiles()?.sumOf { it.length() } ?: 0
      directory.listFiles()?.sortedWith(compareBy<File> { it.name == file.name }.thenBy { it.lastModified() })?.forEach { entry ->
        val length = entry.length()
        if (total > maximumBytes && entry.delete()) total -= length
      }
    } finally { temporary.delete() }
  }
}
