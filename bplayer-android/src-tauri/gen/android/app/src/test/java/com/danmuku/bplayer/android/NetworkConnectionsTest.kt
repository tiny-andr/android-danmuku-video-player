package com.danmuku.bplayer.android

import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.net.SocketException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class NetworkConnectionsTest {
  private val source = NetworkSource("c79fb2a9-c91a-4bc3-8e05-c6221ff1d20c", "测试", "smb", "192.168.1.2", 445,
    "", "测试", "", "", "视频", "", "")

  private class FakeRemote : NetworkRemote {
    @Volatile var connected = true
    val closes = AtomicInteger()
    var onClose: () -> Unit = {}
    override fun isConnected(): Boolean = connected
    override fun abort() { connected = false }
    override fun close() { onClose(); closes.incrementAndGet() }
    override fun list(relative: String): List<RemoteEntry> = emptyList()
    override fun stat(relative: String): RemoteStat = RemoteStat("file", 1)
    override fun open(relative: String, start: Long, length: Long, total: Long): InputStream = ByteArrayInputStream(byteArrayOf(1))
  }

  @Test fun reusesWithinRoleButSeparatesMediaAndMetadata() {
    val count = AtomicInteger()
    NetworkConnections(factory = { count.incrementAndGet(); FakeRemote() }).use { pool ->
      val metadata = pool.run(source) { it }
      val media = pool.run(source, NetworkRole.MEDIA) { it }
      assertNotSame(metadata, media)
      repeat(8) {
        assertSame(metadata, pool.run(source) { it })
        assertSame(media, pool.run(source, NetworkRole.MEDIA) { it })
      }
      assertEquals(2, count.get())
    }
  }

  @Test fun reconnectsDeadSessionWithoutUsingIt() {
    val count = AtomicInteger()
    NetworkConnections(factory = { count.incrementAndGet(); FakeRemote() }).use { pool ->
      val first = pool.run(source) { it } as FakeRemote
      first.connected = false
      val second = pool.run(source) { it }
      assertNotSame(first, second)
      assertEquals(2, count.get())
    }
  }

  @Test fun transientOperationRetriesOnlyOnce() {
    val count = AtomicInteger()
    val attempts = AtomicInteger()
    NetworkConnections(factory = { count.incrementAndGet(); FakeRemote() }).use { pool ->
      val result = pool.run(source) {
        if (attempts.incrementAndGet() == 1) throw SocketException("reset")
        "恢复"
      }
      assertEquals("恢复", result)
      assertEquals(2, attempts.get())
      assertEquals(2, count.get())
      val failed = AtomicInteger()
      assertThrows(SocketException::class.java) {
        pool.run(source) { failed.incrementAndGet(); throw SocketException("reset") }
      }
      assertEquals(2, failed.get())
    }
  }

  @Test fun authenticationPermissionAndSecurityFailuresNeverRetryOrEvict() {
    val count = AtomicInteger()
    NetworkConnections(factory = { count.incrementAndGet(); FakeRemote() }).use { pool ->
      val first = pool.run(source) { it }
      val failures = listOf<Exception>(NetworkFailure("路径无效"), javax.net.ssl.SSLException("certificate"),
        com.hierynomus.mssmb2.SMBApiException(0xC0000022L, com.hierynomus.mssmb2.SMB2MessageCommandCode.SMB2_CREATE, "denied", null),
        com.hierynomus.mssmb2.SMBApiException(0xC000006DL, com.hierynomus.mssmb2.SMB2MessageCommandCode.SMB2_SESSION_SETUP, "login", null))
      failures.forEach { error ->
        val attempts = AtomicInteger()
        assertThrows(error.javaClass) { pool.run(source) { attempts.incrementAndGet(); throw error } }
        assertEquals(1, attempts.get())
        assertSame(first, pool.run(source) { it })
      }
      assertEquals(1, count.get())
    }
  }

  @Test fun oldFailureCannotInvalidateReplacementOrOtherRole() {
    NetworkConnections(factory = { FakeRemote() }).use { pool ->
      val metadata = pool.run(source) { it }
      val old = pool.run(source, NetworkRole.MEDIA) { it }
      pool.invalidate(source.id, NetworkRole.MEDIA, old)
      val replacement = pool.run(source, NetworkRole.MEDIA) { it }
      pool.invalidate(source.id, NetworkRole.MEDIA, old)
      assertSame(replacement, pool.run(source, NetworkRole.MEDIA) { it })
      assertSame(metadata, pool.run(source) { it })
    }
  }

  @Test fun streamCancellationDoesNotEvictEitherSessionOrRetryRead() {
    NetworkConnections(factory = { FakeRemote() }).use { pool ->
      val metadata = pool.run(source) { it }
      val media = pool.run(source, NetworkRole.MEDIA) { it }
      val closes = AtomicInteger()
      val input = object : ByteArrayInputStream(byteArrayOf(1)) {
        override fun close() { closes.incrementAndGet(); throw SocketException("cancelled") }
      }
      val watched = pool.watch(source, NetworkRole.MEDIA, media, input)
      assertThrows(SocketException::class.java) { watched.close() }
      watched.close()
      assertEquals(1, closes.get())
      assertSame(media, pool.run(source, NetworkRole.MEDIA) { it })
      assertSame(metadata, pool.run(source) { it })
      val attempts = AtomicInteger()
      val broken = pool.watch(source, NetworkRole.MEDIA, media, object : InputStream() {
        override fun read(): Int { attempts.incrementAndGet(); throw SocketException("reset") }
      })
      assertThrows(SocketException::class.java) { broken.read() }
      assertEquals(1, attempts.get())
      assertNotSame(media, pool.run(source, NetworkRole.MEDIA) { it })
      assertSame(metadata, pool.run(source) { it })
    }
  }

  @Test fun slowMediaCloseAndOperationDoNotBlockMetadataOrOtherSources() {
    val closeStarted = CountDownLatch(1)
    val finishClose = CountDownLatch(1)
    val operationStarted = CountDownLatch(1)
    val finishOperation = CountDownLatch(1)
    val workers = Executors.newSingleThreadExecutor()
    val pool = NetworkConnections(factory = { FakeRemote() })
    try {
      val metadata = pool.run(source) { it }
      val oldMedia = pool.run(source, NetworkRole.MEDIA) { it } as FakeRemote
      oldMedia.onClose = { closeStarted.countDown(); finishClose.await(3, TimeUnit.SECONDS) }
      pool.invalidate(source.id, NetworkRole.MEDIA, oldMedia)
      assertTrue(closeStarted.await(1, TimeUnit.SECONDS))
      val task = workers.submit {
        pool.run(source, NetworkRole.MEDIA) { operationStarted.countDown(); finishOperation.await(3, TimeUnit.SECONDS) }
      }
      assertTrue(operationStarted.await(1, TimeUnit.SECONDS))
      val started = System.nanoTime()
      assertSame(metadata, pool.run(source) { it })
      pool.run(source.copy(id = "069dafec-e0ba-48f7-a528-f249e73b5bab")) { it.list("") }
      assertTrue(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started) < 500)
      finishOperation.countDown()
      task.get(1, TimeUnit.SECONDS)
    } finally {
      finishOperation.countDown(); finishClose.countDown(); pool.close(); workers.shutdownNow()
    }
  }

  @Test fun explicitInvalidationStopsOldRequestFromReconnecting() {
    val count = AtomicInteger()
    NetworkConnections(factory = { count.incrementAndGet(); FakeRemote() }).use { pool ->
      assertThrows(NetworkFailure::class.java) {
        pool.run(source) {
          pool.invalidate(source.id)
          throw SocketException("old request")
        }
      }
      assertEquals(1, count.get())
      pool.run(source) { it.list("") }
      assertEquals(2, count.get())
    }
  }

  @Test fun transientFailureDuringCreationRetriesOnceButPermissionDoesNot() {
    val count = AtomicInteger()
    NetworkConnections(factory = { if (count.incrementAndGet() == 1) throw SocketException("reset"); FakeRemote() }).use { pool ->
      pool.run(source) { it.list("") }
      assertEquals(2, count.get())
    }
    val denied = AtomicInteger()
    NetworkConnections(factory = { denied.incrementAndGet(); throw NetworkFailure("主机指纹不匹配") }).use { pool ->
      assertThrows(NetworkFailure::class.java) { pool.run(source) { it.list("") } }
      assertEquals(1, denied.get())
    }
  }
}
