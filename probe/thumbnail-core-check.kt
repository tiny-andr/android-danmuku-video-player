package com.danmuku.bplayer.android

import java.io.File
import java.io.IOException

private class Source : ThumbnailRangeSource {
  override val size = 1024L * 1024 * 1024
  override val modifiedMs = 1234L
  var calls = 0
  var requested = 0L
  var aborted = false
  override fun readAt(position: Long, buffer: ByteArray, offset: Int, length: Int): Int {
    calls++; requested += length
    buffer.fill(7, offset, offset + length)
    return length
  }
  override fun abort() { aborted = true }
  override fun close() = Unit
}

private fun denied(action: () -> Unit) {
  try { action(); error("Expected IOException") } catch (_: IOException) { Unit }
}

fun main(args: Array<String>) {
  check(ThumbnailFrames.positions(7_200_000_000L).contentEquals(longArrayOf(30_000_000L, 60_000_000L)))
  check(ThumbnailFrames.positions(20_000_000L).contentEquals(longArrayOf(2_000_000L, 5_000_000L)))
  check(ThumbnailFrames.positions(2_000_000L).contentEquals(longArrayOf(1_000_000L, 1_999_999L)))
  check(ThumbnailFrames.positions(500_000L).contentEquals(longArrayOf(499_999L)))
  check(ThumbnailFrames.positions(1L).contentEquals(longArrayOf(0L)))
  check(ThumbnailFrames.positions(null).contentEquals(longArrayOf(1_000_000L, 10_000_000L)))
  check(ThumbnailFrames.positions(Long.MAX_VALUE).all { it >= 0 && it < Long.MAX_VALUE })
  check(ThumbnailFrames.nearBlack(IntArray(256)))
  check(ThumbnailFrames.nearBlack(IntArray(256) { 0x00050505 }))
  check(!ThumbnailFrames.nearBlack(IntArray(256) { 0x00202020 }))
  val letterbox = IntArray(256) { if (it < 160) 0 else 0x00202020 }
  check(!ThumbnailFrames.nearBlack(letterbox))
  check(!ThumbnailFrames.nearBlack(IntArray(256) { if (it < 250) 0 else 0x00ffffff }))

  val decoderGate = ThumbnailDecoderGate()
  check(decoderGate.claim("old"))
  check(!decoderGate.claim("next"))
  check(decoderGate.stopOnce("old"))
  check(!decoderGate.stopOnce("old"))
  check(!decoderGate.claim("next"))
  decoderGate.release("unrelated")
  check(!decoderGate.claim("next"))
  decoderGate.release("old")
  check(decoderGate.claim("next"))
  check(!decoderGate.stopOnce("old"))
  decoderGate.release("old")
  check(decoderGate.stopOnce("next"))

  val source = Source()
  val token = ThumbnailCancellation()
  val budget = ThumbnailBudget(source, token, 100000)
  val buffer = ByteArray(80000)
  check(budget.readAt(5000000, buffer, 0, buffer.size) == 65536)
  check(budget.reservedBytes == 65536L)
  denied { budget.readAt(0, buffer, 0, 65536) }
  check(source.calls == 1 && source.requested == 65536L)
  check(budget.readAt(source.size, buffer, 0, 1) == -1)
  check(source.calls == 1)
  denied { budget.readAt(-1, buffer, 0, 1) }
  denied { budget.readAt(0, buffer, buffer.size, 1) }

  val fullSource = Source()
  val fullBudget = ThumbnailBudget(fullSource, ThumbnailCancellation(System.nanoTime() + 30_000_000_000L))
  repeat(192) { check(fullBudget.readAt(it * 65536L, buffer, 0, 65536) == 65536) }
  check(fullSource.requested == 12L * 1024 * 1024)
  denied { fullBudget.readAt(0, buffer, 0, 1) }
  check(fullSource.calls == 192)

  token.onCancel { source.abort() }
  token.cancel()
  check(source.aborted)
  denied { budget.readAt(0, buffer, 0, 1) }
  check(source.calls == 1)
  var lateCancel = false
  token.onCancel { lateCancel = true }
  check(lateCancel)
  denied { ThumbnailBudget(Source(), ThumbnailCancellation(0)).readAt(0, buffer, 0, 1) }

  val readData = ByteArray(65636) { (it % 251).toByte() }
  val blockReads = mutableListOf<Pair<Long, Int>>()
  val readCache = ThumbnailReadCache(readData.size.toLong(), { position, target, offset, length ->
    blockReads.add(position to length)
    readData.copyInto(target, offset, position.toInt(), position.toInt() + length)
    length
  })
  val crossing = ByteArray(24)
  check(readCache.readAt(65530, crossing, 2, 20) == 20)
  check(crossing.copyOfRange(2, 22).contentEquals(readData.copyOfRange(65530, 65550)))
  check(blockReads == listOf(0L to 65536, 65536L to 100))
  check(readCache.readAt(65531, crossing, 0, 8) == 8 && blockReads.size == 2)
  check(readCache.readAt(readData.size - 4L, crossing, 0, 20) == 4)
  check(readCache.readAt(readData.size.toLong(), crossing, 0, 1) == -1)
  check(readCache.readAt(0, crossing, 0, 0) == 0)
  denied { readCache.readAt(-1, crossing, 0, 1) }
  denied { readCache.readAt(0, crossing, crossing.size, 1) }
  denied { readCache.readAt(0, crossing, 0, -1) }

  val shortReads = mutableListOf<Long>()
  val shortCache = ThumbnailReadCache(80, { position, target, offset, length ->
    val count = minOf(length, 3)
    shortReads.add(position)
    repeat(count) { index -> target[offset + index] = (position + index).toByte() }
    count
  }, blockSize = 16, maxBlocks = 2)
  check(shortCache.readAt(2, crossing, 0, 9) == 9)
  check(crossing.copyOfRange(0, 9).contentEquals(ByteArray(9) { (it + 2).toByte() }))
  check(shortReads == listOf(0L, 3L, 6L, 9L, 12L, 15L))
  check(shortCache.readAt(4, crossing, 0, 1) == 1 && shortReads.size == 6)
  check(shortCache.readAt(16, crossing, 0, 1) == 1)
  check(shortCache.readAt(0, crossing, 0, 1) == 1)
  check(shortCache.readAt(32, crossing, 0, 1) == 1)
  check(shortReads.size == 18)
  check(shortCache.readAt(0, crossing, 0, 1) == 1 && shortReads.size == 18)
  check(shortCache.readAt(16, crossing, 0, 1) == 1 && shortReads.size == 24)
  listOf(-1, 0, 17).forEach { response ->
    val invalidCache = ThumbnailReadCache(16, { _, _, _, _ -> response }, blockSize = 16)
    denied { invalidCache.readAt(0, crossing, 0, 1) }
  }

  val cachedBudgetSource = Source()
  val cachedBudget = ThumbnailBudget(cachedBudgetSource, ThumbnailCancellation(System.nanoTime() + 30_000_000_000L))
  val budgetCache = ThumbnailReadCache(cachedBudgetSource.size, cachedBudget::readAt)
  repeat(192) { check(budgetCache.readAt(it * 65536L + 2, crossing, 0, 1) == 1) }
  check(cachedBudgetSource.requested == 12L * 1024 * 1024)
  check(cachedBudget.readCalls == 192L)
  check(budgetCache.readAt(191 * 65536L + 4, crossing, 0, 1) == 1)
  check(cachedBudget.readCalls == 192L)
  denied { budgetCache.readAt(192 * 65536L, crossing, 0, 1) }
  check(cachedBudget.readCalls == 192L && cachedBudgetSource.calls == 192)

  val stable = "/@network/12345678-1234-1234-1234-123456789abc/Share/movie.mkv"
  check(ThumbnailPaths.stable(stable) == stable)
  listOf("https://example.com/a.mp4", "file:///storage/a.mp4", "/data/user/0/a.mp4", "/@network/not-id/a.mp4", "/@network/12345678-1234-1234-1234-123456789abc/../a.mp4").forEach { denied { ThumbnailPaths.stable(it) } }
  check(ThumbnailPaths.hash(stable).length == 64)

  val directory = File(args[0], "cache").apply { mkdirs() }
  val cache = ThumbnailCache(directory, 12)
  val legacy = File(directory, ThumbnailPaths.hash(stable) + "_" + ThumbnailPaths.hash("100:1000") + ".jpg")
  legacy.writeBytes(byteArrayOf(9, 9, 9, 9))
  check(cache.get(stable, 100, 1000) == null)
  check(cache.latest(stable) == null)
  cache.put(stable, 100, 1000, byteArrayOf(1, 2, 3, 4))
  check(cache.get(stable, 100, 1000)!!.contentEquals(byteArrayOf(1, 2, 3, 4)))
  check(cache.get(stable, 101, 1000) == null)
  check(cache.get(stable, 100, 1001) == null)
  check(cache.get(stable, 100, null) == null)
  check(cache.latest(stable) != null)
  cache.put(stable, 101, 1001, ByteArray(10))
  check(cache.get(stable, 101, 1001)?.size == 10)
  check(cache.get(stable, 100, 1000) == null)
  val another = stable.replace("movie", "another")
  cache.put(another, 102, 1002, ByteArray(4))
  check(cache.get(another, 102, 1002)?.size == 4)
  check(directory.listFiles()!!.sumOf { it.length() } <= 12)
  check(directory.listFiles()!!.isNotEmpty())
  check(directory.listFiles()!!.all { it.name.matches(Regex("v2_[a-f0-9]{64}_[a-f0-9]{64}\\.jpg")) })
  check(directory.listFiles()!!.none { it.name.contains("Share") || it.name.contains("movie") })
  println("Thumbnail core: budget, EOF, cancellation, deadline, block cache, short reads, LRU, path allowlist and versioned cache passed")
}
