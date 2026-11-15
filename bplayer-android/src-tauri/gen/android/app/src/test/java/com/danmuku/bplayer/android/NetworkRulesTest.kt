package com.danmuku.bplayer.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class NetworkRulesTest {
  private val id = "c79fb2a9-c91a-4bc3-8e05-c6221ff1d20c"

  @Test fun preservesRawChineseAndSpaces() {
    val path = "/@network/$id/电影 合集/第一集 中文.mp4"
    val parsed = NetworkPaths.parse(path)
    assertEquals(id, parsed.id)
    assertEquals("电影 合集/第一集 中文.mp4", parsed.relative)
    assertEquals(path, parsed.virtual)
    assertEquals("/@network/$id/%2e%2e/片名+空格.mp4", NetworkPaths.parse("/@network/$id/%2e%2e/片名+空格.mp4").virtual)
  }

  @Test fun rejectsTraversalAndInvalidRoots() {
    listOf("/@network/$id/../secret", "/@network/$id/a/./b", "/@network/$id/a\\b", "/@network/$id/a\u0000b",
      "/@network/no-id/file", "/storage/emulated/0/video.mp4", "/@network/$id/.. \\x").forEach { path ->
      assertThrows(NetworkFailure::class.java) { NetworkPaths.parse(path) }
    }
    listOf("../escape", "a/b", "a\\b", "", ".", "..").forEach { name ->
      assertThrows(NetworkFailure::class.java) { NetworkPaths.child("/@network/$id", name) }
    }
    assertEquals("/@network/$id", NetworkPaths.parse("/@network/$id/").virtual)
  }

  @Test fun parsesClosedOpenAndSuffixRanges() {
    assertEquals(NetworkByteRange(10, 19), NetworkByteRange.parse("bytes=10-19", 100))
    assertEquals(NetworkByteRange(10, 99), NetworkByteRange.parse("bytes=10-", 100))
    assertEquals(NetworkByteRange(90, 99), NetworkByteRange.parse("bytes=-10", 100))
    assertEquals(NetworkByteRange(0, 99), NetworkByteRange.parse("bytes=-1000", 100))
    assertEquals(NetworkByteRange(10, 99), NetworkByteRange.parse("bytes=10-999", 100))
    assertEquals(NetworkByteRange(0, 99), NetworkByteRange.parse(null, 100))
  }

  @Test fun uses64BitSizesAndRejectsOverflow() {
    val size = 6558821553L
    assertEquals(NetworkByteRange(4294967296L, size - 1), NetworkByteRange.parse("bytes=4294967296-", size))
    assertEquals(NetworkByteRange(size - 1024, size - 1), NetworkByteRange.parse("bytes=-1024", size))
    assertEquals(NetworkByteRange(0, Long.MAX_VALUE - 1), NetworkByteRange.parse(null, Long.MAX_VALUE))
    assertEquals(Long.MAX_VALUE, NetworkByteRange.parse(null, Long.MAX_VALUE)!!.length)
    assertNull(NetworkByteRange.parse("bytes=9223372036854775808-", Long.MAX_VALUE))
    assertNull(NetworkByteRange.parse("bytes=-9223372036854775808", Long.MAX_VALUE))
  }

  @Test fun rejectsUnsatisfiableMalformedAndMultiRanges() {
    listOf("bytes=100-", "bytes=50-49", "bytes=-0", "bytes=-", "bytes=", "bytes=0-1,4-5", "items=0-1", "bytes=+1-2", "bytes=1-a").forEach {
      assertNull(NetworkByteRange.parse(it, 100))
    }
    assertNull(NetworkByteRange.parse(null, 0))
    assertNull(NetworkByteRange.parse("bytes=0-0", 0))
    assertNull(NetworkByteRange.parse("bytes=-1", 0))
    assertNull(NetworkByteRange.parse("bytes=0-", 0))
  }
}
