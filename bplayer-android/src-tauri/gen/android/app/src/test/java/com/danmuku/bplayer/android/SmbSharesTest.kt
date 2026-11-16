package com.danmuku.bplayer.android

import com.hierynomus.msdtyp.FileTime
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.net.SocketException
import java.util.concurrent.atomic.AtomicInteger

class SmbSharesTest {
  private val id = "c79fb2a9-c91a-4bc3-8e05-c6221ff1d20c"
  private val source = NetworkSource(id, "测试", "smb", "server.invalid", 445, "", "user", "secret", "", "视频", "", "")
  private val server = source.copy(scope = "server", share = "")

  private class FakeRemote(val source: NetworkSource) : NetworkRemote {
    var aborted = false
    val requests = mutableListOf<String>()
    override fun isConnected(): Boolean = !aborted
    override fun abort() { aborted = true }
    override fun close() { abort() }
    override fun list(relative: String): List<RemoteEntry> {
      requests.add("list:$relative")
      return if (source.scope == "server") listOf(RemoteEntry("视频", 0, true))
        else listOf(RemoteEntry("片名.mp4", 100, false, 1710000000123))
    }
    override fun stat(relative: String): RemoteStat {
      requests.add("stat:$relative")
      return RemoteStat("file", 100, 1710000000123)
    }
    override fun open(relative: String, start: Long, length: Long, total: Long): InputStream {
      requests.add("open:$relative")
      return ByteArrayInputStream(ByteArray(length.toInt()))
    }
    override fun readAtExact(relative: String, position: Long, buffer: ByteArray, offset: Int, length: Int, total: Long): Int {
      requests.add("read:$relative:$position:$length")
      buffer.fill(7, offset, offset + length)
      return length
    }
  }

  @Test fun legacySourcesKeepBoundShareAndStablePaths() {
    val legacy = source.json(true).apply { remove("scope") }
    val restored = NetworkSource.from(legacy)
    assertEquals("share", restored.scope)
    val parsed = NetworkPaths.parse("/@network/$id/电影 合集/第 2 集.mp4")
    val resolved = SmbShares.resolve(restored, parsed.relative)
    assertEquals("视频", resolved.first.share)
    assertEquals("电影 合集/第 2 集.mp4", resolved.second)
    assertEquals(parsed.virtual, "/@network/$id/电影 合集/第 2 集.mp4")
    assertThrows(NetworkFailure::class.java) { NetworkSource.from(legacy.put("share", "")) }
  }

  @Test fun serverScopeMustBeExplicitAndCannotReinterpretExistingSource() {
    assertEquals("server", NetworkSource.from(server.json(true)).scope)
    assertThrows(NetworkFailure::class.java) { NetworkSource.from(server.json(true), source) }
    assertThrows(NetworkFailure::class.java) { NetworkSource.from(source.json(true), server) }
    assertThrows(NetworkFailure::class.java) { NetworkSource.from(server.json(true).put("share", "视频")) }
    assertThrows(NetworkFailure::class.java) { NetworkSource.from(server.json(true).put("root", "folder")) }
    assertThrows(NetworkFailure::class.java) { NetworkSource.from(server.json(true).put("protocol", "sftp")) }
    assertEquals("share", NetworkSource.from(source.json(true).put("share", "新共享"), source).scope)
  }

  @Test fun publicSourcesNeverReturnPasswordAndPreserveStoredPassword() {
    val public = server.json()
    assertFalse(public.has("password"))
    assertTrue(public.getBoolean("hasPassword"))
    assertEquals("server", public.getString("scope"))
    assertEquals("secret", NetworkSource.from(public, server).password)
  }

  @Test fun serverPathsResolveExactlyOneShareSegmentWithoutDecoding() {
    val resolved = SmbShares.resolve(server, "电影院/片 名/%2e%2e.mp4")
    assertEquals("share", resolved.first.scope)
    assertEquals("电影院", resolved.first.share)
    assertEquals("片 名/%2e%2e.mp4", resolved.second)
    assertEquals("", resolved.first.root)
    assertEquals(id, resolved.first.id)
    assertEquals("", SmbShares.resolve(server, "电影院").second)
    listOf("", "../secret", "IPC$/../secret", "a:b/file", "trailing. /x").forEach {
      assertThrows(NetworkFailure::class.java) { SmbShares.resolve(server, it) }
    }
  }

  @Test fun shareEnumerationFiltersPrintersIpcAdminAndUnsafeNames() {
    val entries = listOf(Triple("Video", 0, "Movies"), Triple("video", 0, "duplicate"),
      Triple("图片", 0, "Photos"), Triple("IPC$", 3, ""), Triple("Printer", 1, ""),
      Triple("C$", Int.MIN_VALUE, ""), Triple("ADMIN$", Int.MIN_VALUE, ""),
      Triple("hidden$", 0, ""), Triple("特殊", Int.MIN_VALUE, ""), Triple("a/b", 0, ""),
      Triple("..", 0, ""), Triple("bad:", 0, ""))
    val shares = SmbShares.clean(entries)
    assertEquals(listOf("Video", "图片"), shares.map { it.name })
    assertEquals("Movies", shares.first().comment)
    assertTrue(SmbShares.clean(emptyList()).isEmpty())
  }

  @Test fun nullableTimestampsAreExplicitAndSmbTimesUseEpochMillis() {
    assertTrue(RemoteEntry("x", 1, false).json("/@network/$id").isNull("modified_ms"))
    assertTrue(RemoteStat("dir", 0).json().isNull("modified_ms"))
    assertEquals(1710000000123, RemoteEntry("x", 1, false, 1710000000123).json("/@network/$id").getLong("modified_ms"))
    assertEquals(1710000000123, RemoteStat("file", 1, 1710000000123).json().getLong("modified_ms"))
    assertNull(smbModifiedMs(null))
    assertNull(smbModifiedMs(FileTime(0)))
    assertNull(smbModifiedMs(FileTime(-1)))
    assertEquals(1710000000123, smbModifiedMs(FileTime.ofEpochMillis(1710000000123)))
    assertEquals(0L, smbModifiedMs(FileTime.ofEpochMillis(0)))
  }

  @Test fun serverRootListsSharesAndDirectoriesKeepTheirRawRelativePaths() {
    val created = mutableListOf<FakeRemote>()
    NetworkConnections(factory = { FakeRemote(it).also(created::add) }).use { pool ->
      assertEquals("视频", pool.run(server) { it.list("") }.single().name)
      assertEquals(RemoteStat("dir", 0), pool.run(server) { it.stat("") })
      pool.run(server) { it.list("电影院/目录") }
      assertEquals(2, created.size)
      assertEquals("server", created[0].source.scope)
      assertEquals("电影院", created[1].source.share)
      assertEquals(listOf("list:目录"), created[1].requests)
      pool.run(server) { it.stat("电影院/目录/片名.mp4") }
      assertEquals("stat:目录/片名.mp4", created[1].requests.last())
    }
  }

  @Test fun shareAndRoleSlotsAreIndependentAndInvalidateOnlyExpectedRemote() {
    val created = mutableListOf<FakeRemote>()
    NetworkConnections(factory = { FakeRemote(it).also(created::add) }).use { pool ->
      pool.run(server) { it.list("A") }
      pool.run(server) { it.list("B") }
      pool.run(server, NetworkRole.MEDIA) { it.stat("A/x.mp4") }
      pool.run(server, NetworkRole.THUMBNAIL) { it.stat("A/x.mp4") }
      assertEquals(4, created.size)
      repeat(3) {
        pool.run(server) { it.list("A") }
        pool.run(server) { it.list("B") }
      }
      assertEquals(4, created.size)
      pool.invalidate(id, NetworkRole.MEDIA, created[2])
      assertTrue(created[2].aborted)
      assertFalse(created[0].aborted)
      assertFalse(created[1].aborted)
      assertFalse(created[3].aborted)
      pool.run(server, NetworkRole.MEDIA) { it.stat("A/x.mp4") }
      pool.invalidate(id, NetworkRole.MEDIA, created[2])
      assertFalse(created[4].aborted)
      pool.invalidate(id)
      assertTrue(created.all { it.aborted })
    }
  }

  @Test fun standaloneServerConnectionCancellationDoesNotTouchPlaybackPool() {
    val created = mutableListOf<FakeRemote>()
    NetworkConnections(factory = { FakeRemote(it).also(created::add) }).use { pool ->
      pool.run(server, NetworkRole.MEDIA) { it.stat("A/x.mp4") }
      val independent = pool.create(server)
      independent.stat("A/x.mp4")
      assertEquals(2, created.size)
      independent.abort()
      assertFalse(created[0].aborted)
      assertTrue(created[1].aborted)
      assertThrows(NetworkFailure::class.java) { independent.stat("A/x.mp4") }
      pool.run(server, NetworkRole.MEDIA) { it.stat("A/x.mp4") }
      assertEquals(2, created.size)
    }
  }

  @Test fun exactReadsRouteWithoutBufferedStreamFallback() {
    val created = mutableListOf<FakeRemote>()
    NetworkConnections(factory = { FakeRemote(it).also(created::add) }).use { pool ->
      val buffer = ByteArray(16)
      val count = pool.run(server, NetworkRole.THUMBNAIL) { it.readAtExact("A/目录/x.mp4", 50, buffer, 3, 5, 100) }
      assertEquals(5, count)
      assertEquals(listOf("read:目录/x.mp4:50:5"), created.single().requests)
      assertEquals(listOf<Byte>(0, 0, 0, 7, 7, 7, 7, 7, 0, 0, 0, 0, 0, 0, 0, 0), buffer.toList())
    }
  }

  @Test fun thumbnailReadsNeverRetryImplicitly() {
    val attempts = AtomicInteger()
    NetworkConnections(factory = { FakeRemote(it) }).use { pool ->
      assertThrows(SocketException::class.java) {
        pool.run(source, NetworkRole.THUMBNAIL) { attempts.incrementAndGet(); throw SocketException("reset") }
      }
      assertEquals(1, attempts.get())
    }
  }

  @Test fun releasedRpcJarExposesLevelOneAndExplicitPipeLifetime() {
    assertNotNull(com.rapid7.client.dcerpc.mssrvs.ServerService::class.java.getMethod("getShares1"))
    assertNotNull(com.rapid7.client.dcerpc.mssrvs.dto.NetShareInfo1("视频", 0, "Movies").netName)
    assertTrue(java.io.Closeable::class.java.isAssignableFrom(com.rapid7.helper.smbj.share.NamedPipe::class.java))
  }
}
