package com.danmuku.bplayer.android

import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.LinkOption

internal class AudioCancellation {
  private val lock = Any()
  private val callbacks = mutableListOf<() -> Unit>()
  @Volatile var cancelled: Boolean = false
    private set
  @Volatile var commitAttempted: Boolean = false
    private set
  @Volatile var published: Boolean = false
    private set

  fun check() { if (cancelled || Thread.currentThread().isInterrupted) throw IOException("Audio cache task cancelled") }
  fun onCancel(callback: () -> Unit) {
    val run = synchronized(lock) { if (published) false else if (cancelled) true else { callbacks.add(callback); false } }
    if (run) runCatching(callback)
  }
  fun cancel() {
    val pending = synchronized(lock) {
      if (cancelled) return
      cancelled = true
      if (published) return
      callbacks.toList().also { callbacks.clear() }
    }
    pending.forEach { runCatching(it) }
  }
  fun <Result> commit(action: () -> Result): Result = synchronized(lock) {
    check()
    if (commitAttempted) throw IOException("Audio cache publication must not be retried")
    commitAttempted = true
    action().also { published = true; callbacks.clear() }
  }
}

internal data class AudioCacheNames(val video: String, val parent: String, val final: String, val temporary: String) {
  companion object {
    fun derive(videoRelative: String, audioIndex: Int, jobId: String): AudioCacheNames {
      require(audioIndex in 0..127) { "Invalid audio track index" }
      require(Regex("[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}").matches(jobId)) { "Invalid audio cache job ID" }
      require(videoRelative.isNotEmpty() && !videoRelative.startsWith('/') && !videoRelative.endsWith('/')) { "Invalid video relative path" }
      val segments = videoRelative.split('/')
      require(segments.all { part -> part.isNotEmpty() && part != "." && part != ".." && part.none { it == '\\' || it == ':' || it.code < 32 || it.code == 127 } && !part.endsWith('.') && !part.endsWith(' ') }) { "Invalid audio cache path" }
      val name = segments.last()
      val stem = name.substringBeforeLast('.', name)
      require(stem.isNotBlank() && stem != "." && stem != "..") { "Invalid video name" }
      val parent = segments.dropLast(1).joinToString("/")
      val base = "$stem (音轨${audioIndex + 1})"
      fun child(name: String) = if (parent.isEmpty()) name else "$parent/$name"
      return AudioCacheNames(videoRelative, parent, child("$base.mka"), child("$base.bplayer-${jobId.lowercase(java.util.Locale.ROOT)}.tmp.mka"))
    }
  }
}

internal object AudioCacheTransfer {
  const val BLOCK_BYTES = 256 * 1024
  const val MAX_BYTES = 16L * 1024 * 1024 * 1024
  fun inputSize(input: File): Long {
    if (!Files.isRegularFile(input.toPath(), LinkOption.NOFOLLOW_LINKS)) throw IOException("Audio cache input is not a regular file")
    val size = input.length()
    if (size !in 1..MAX_BYTES) throw IOException("Audio cache input size is invalid")
    return size
  }
  fun verifyVideo(expected: RemoteStat, actual: RemoteStat) {
    if (expected.kind != "file" || actual.kind != "file" || expected.size <= 0 || expected.size != actual.size) {
      throw IOException("Source video changed before audio cache publication")
    }
    if (expected.modifiedMs == null || actual.modifiedMs == null) throw IOException("Server did not provide a modification time; safe audio cache publication is unavailable")
    if (expected.modifiedMs != actual.modifiedMs) throw IOException("Source video modification time changed")
  }
  fun copy(input: File, expectedSize: Long, cancellation: AudioCancellation, write: (Long, ByteArray, Int, Int) -> Int) {
    input.inputStream().use { stream ->
      val buffer = ByteArray(BLOCK_BYTES)
      var position = 0L
      while (position < expectedSize) {
        cancellation.check()
        val count = stream.read(buffer, 0, minOf(buffer.size.toLong(), expectedSize - position).toInt())
        if (count <= 0) throw IOException("Audio cache input ended early")
        var written = 0
        while (written < count) {
          cancellation.check()
          val accepted = write(position + written, buffer, written, count - written)
          if (accepted <= 0 || accepted > count - written) throw IOException("Audio cache write returned an invalid length")
          written += accepted
        }
        position += count
      }
      cancellation.check()
      if (stream.read() != -1 || inputSize(input) != expectedSize) throw IOException("Audio cache input changed while publishing")
    }
  }
  fun strongEtag(value: String?): String? = value?.takeIf {
    it.length in 2..1024 && it.startsWith('"') && it.endsWith('"') && it.substring(1, it.length - 1).all { character -> character.code >= 33 && character != '"' && character.code != 127 }
  }
}
