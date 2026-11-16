package com.danmuku.bplayer.android

import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

class AudioCacheTransferTest {
  private val id = "12345678-1234-4234-8234-123456789abc"
  private fun denied(action: () -> Unit) {
    try { action(); fail("Expected rejection") } catch (_: IllegalArgumentException) { } catch (_: IOException) { }
  }
  private fun fixture(bytes: Int, action: (File) -> Unit) {
    val file = File.createTempFile("audio-cache-transfer-", ".mka")
    try { file.writeBytes(ByteArray(bytes) { (it % 251).toByte() }); action(file) } finally { file.delete() }
  }

  @Test fun namesPreserveDirectoryAndOneBasedOrdinal() {
    val names = AudioCacheNames.derive("Movies/影片.part.1.MKV", 0, id.uppercase())
    assertEquals("Movies", names.parent)
    assertEquals("Movies/影片.part.1 (音轨1).mka", names.final)
    assertEquals("Movies/影片.part.1 (音轨1).bplayer-$id.tmp.mka", names.temporary)
    assertEquals("movie (音轨128).mka", AudioCacheNames.derive("movie.mp4", 127, id).final)
    assertNotEquals(names.final, names.temporary)
  }

  @Test fun rejectsTraversalAlternateStreamsAndInvalidOwnership() {
    listOf("", "/movie.mkv", "a//movie.mkv", "../movie.mkv", "a/./movie.mkv", "a/../movie.mkv", "a\\movie.mkv", "a/movie:mkv", "a./movie.mkv", "a /movie.mkv", "a/movie.mkv/", ".mkv", "a/\u0000movie.mkv").forEach {
      denied { AudioCacheNames.derive(it, 0, id) }
    }
    denied { AudioCacheNames.derive("movie.mkv", -1, id) }
    denied { AudioCacheNames.derive("movie.mkv", 128, id) }
    listOf("", "1234", "$id/other", "{${id}}", "$id\n").forEach { job -> denied { AudioCacheNames.derive("movie.mkv", 0, job) } }
  }

  @Test fun sourceIdentityRequiresKnownMatchingMetadata() {
    val expected = RemoteStat("file", 123, 456)
    AudioCacheTransfer.verifyVideo(expected, expected.copy())
    listOf(RemoteStat("file", 124, 456), RemoteStat("file", 123, 457), RemoteStat("missing", 0), RemoteStat("file", 123, null)).forEach {
      denied { AudioCacheTransfer.verifyVideo(expected, it) }
    }
    denied { AudioCacheTransfer.verifyVideo(RemoteStat("file", 123), expected) }
    denied { AudioCacheTransfer.verifyVideo(RemoteStat("file", 0, 456), RemoteStat("file", 0, 456)) }
  }

  @Test fun boundedCopyHandlesShortWritesWithoutLosingBytes() = fixture(700001) { file ->
    val output = java.io.ByteArrayOutputStream()
    var position = 0L
    var calls = 0
    AudioCacheTransfer.copy(file, AudioCacheTransfer.inputSize(file), AudioCancellation()) { remotePosition, bytes, offset, count ->
      assertEquals(position, remotePosition)
      assertTrue(count <= 256 * 1024)
      val accepted = minOf(count, 17003)
      output.write(bytes, offset, accepted); position += accepted; calls++
      accepted
    }
    assertArrayEquals(file.readBytes(), output.toByteArray())
    assertTrue(calls > 3)
  }

  @Test fun invalidWritesInputGrowthAndEarlyEofAreRejected() = fixture(20) { file ->
    denied { AudioCacheTransfer.copy(file, 20, AudioCancellation()) { _, _, _, _ -> 0 } }
    denied { AudioCacheTransfer.copy(file, 20, AudioCancellation()) { _, _, _, count -> count + 1 } }
    denied { AudioCacheTransfer.copy(file, 19, AudioCancellation()) { _, _, _, count -> count } }
    denied { AudioCacheTransfer.copy(file, 21, AudioCancellation()) { _, _, _, count -> count } }
  }

  @Test fun copyCancellationStopsBeforeNextChunk() = fixture(600000) { file ->
    val cancellation = AudioCancellation(); var calls = 0
    denied { AudioCacheTransfer.copy(file, file.length(), cancellation) { _, _, _, count -> calls++; cancellation.cancel(); count } }
    assertEquals(1, calls)
  }

  @Test fun inputRejectsDirectoriesEmptyFilesAndSymlinks() {
    val directory = Files.createTempDirectory("audio-cache-input-")
    try {
      denied { AudioCacheTransfer.inputSize(directory.toFile()) }
      fixture(0) { denied { AudioCacheTransfer.inputSize(it) } }
      fixture(1) { file ->
        val link = directory.resolve("link.mka")
        try { Files.createSymbolicLink(link, file.toPath()); denied { AudioCacheTransfer.inputSize(link.toFile()) } }
        catch (_: UnsupportedOperationException) { } catch (_: java.nio.file.FileSystemException) { }
      }
    } finally { directory.toFile().listFiles()?.forEach { it.delete() }; directory.toFile().delete() }
  }

  @Test fun cancellationIsIdempotentAndLateCallbacksRunExactlyOnce() {
    val token = AudioCancellation(); var count = 0
    token.onCancel { count++ }; token.onCancel { throw IOException("ignored callback") }; token.onCancel { count++ }
    token.cancel(); token.cancel(); token.onCancel { count++ }
    assertTrue(token.cancelled); assertEquals(3, count)
    denied { token.check() }
    denied { token.commit { fail("Cancelled commit executed") } }
    assertFalse(token.commitAttempted)
  }

  @Test fun completedCommitCannotTriggerCleanupAndCannotRetry() {
    val token = AudioCancellation(); var cleanup = false
    token.onCancel { cleanup = true }
    assertEquals("published", token.commit { "published" })
    assertTrue(token.published); assertTrue(token.commitAttempted)
    token.cancel(); token.onCancel { cleanup = true }
    assertTrue(token.cancelled); assertFalse(cleanup)
    denied { token.commit { fail("Retried") } }
  }

  @Test fun failedCommitIsUncertainAndNotRetried() {
    val token = AudioCancellation()
    denied { token.commit<Unit> { throw IOException("Connection lost after rename") } }
    assertTrue(token.commitAttempted); assertFalse(token.published)
    denied { token.commit { fail("Unknown outcome retried") } }
  }

  @Test fun commitAndCancelAreMutuallyExclusive() {
    val token = AudioCancellation(); val entered = CountDownLatch(1); val release = CountDownLatch(1); val cancelled = CountDownLatch(1)
    var cleanup = false
    token.onCancel { cleanup = true }
    val publisher = thread { token.commit { entered.countDown(); check(release.await(3, TimeUnit.SECONDS)) } }
    assertTrue(entered.await(3, TimeUnit.SECONDS))
    val canceller = thread { token.cancel(); cancelled.countDown() }
    assertFalse(cancelled.await(30, TimeUnit.MILLISECONDS))
    release.countDown(); publisher.join(3000); canceller.join(3000)
    assertTrue(token.published); assertTrue(token.cancelled); assertFalse(cleanup)
  }

  @Test fun onlyStrongQuotedEtagsPermitConditionalOwnership() {
    assertEquals("\"version-1\"", AudioCacheTransfer.strongEtag("\"version-1\""))
    assertEquals("\"\"", AudioCacheTransfer.strongEtag("\"\""))
    listOf(null, "", "W/\"weak\"", "unquoted", "\"newline\n\"", "\"space value\"", "\"bad\"quote\"").forEach { assertNull(AudioCacheTransfer.strongEtag(it)) }
  }
}
