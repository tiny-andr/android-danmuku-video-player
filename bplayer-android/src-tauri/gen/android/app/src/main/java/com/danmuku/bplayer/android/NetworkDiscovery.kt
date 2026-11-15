package com.danmuku.bplayer.android

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Xml
import org.json.JSONArray
import org.json.JSONObject
import org.xmlpull.v1.XmlPullParser
import java.io.Closeable
import java.io.StringReader
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.SocketTimeoutException
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

internal class NetworkDiscovery(context: Context) : Closeable {
  private val app = context.applicationContext
  private val nsd = app.getSystemService(Context.NSD_SERVICE) as NsdManager
  private val handler = Handler(Looper.getMainLooper())
  private val current = AtomicReference<Session?>()
  private val closed = AtomicBoolean(false)

  fun discoverSmb(): JSONArray {
    if (closed.get()) throw NetworkFailure("网络发现服务已关闭")
    val session = Session()
    if (!current.compareAndSet(null, session)) throw NetworkFailure("正在发现局域网设备，请等待当前发现完成")
    try {
      if (closed.get()) throw NetworkFailure("网络发现已取消")
      return session.run()
    } finally {
      session.close()
      current.compareAndSet(session, null)
    }
  }

  override fun close() {
    closed.set(true)
    current.getAndSet(null)?.close()
  }

  private inner class Session : Closeable {
    private val alive = AtomicBoolean(true)
    private val deadline = SystemClock.elapsedRealtime() + 6500
    private val cancelled = CountDownLatch(1)
    private val results = linkedMapOf<String, JSONObject>()
    private val resolutions = mutableSetOf<NsdManager.ResolveListener>()
    private val serviceNames = mutableSetOf<String>()
    private val messageId = "urn:uuid:" + UUID.randomUUID().toString()
    @Volatile private var socket: DatagramSocket? = null
    @Volatile private var multicastLock: WifiManager.MulticastLock? = null
    @Volatile private var discoveryStarted = false

    private fun active(): Boolean = alive.get() && !closed.get() && SystemClock.elapsedRealtime() < deadline

    private val discovery = object : NsdManager.DiscoveryListener {
      override fun onDiscoveryStarted(serviceType: String) {
        if (!active()) runCatching { nsd.stopServiceDiscovery(this) }
      }
      override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
        discoveryStarted = false
        runCatching { nsd.stopServiceDiscovery(this) }
      }
      override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) { discoveryStarted = false }
      override fun onDiscoveryStopped(serviceType: String) { discoveryStarted = false }
      override fun onServiceLost(serviceInfo: NsdServiceInfo) = Unit
      override fun onServiceFound(serviceInfo: NsdServiceInfo) {
        if (!active() || serviceInfo.serviceType.trimEnd('.').lowercase() != "_smb._tcp") return
        synchronized(serviceNames) {
          if (serviceNames.size >= 24 || !serviceNames.add(serviceInfo.serviceName)) return
        }
        val listener = object : NsdManager.ResolveListener {
          override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
            synchronized(resolutions) { resolutions.remove(this) }
          }
          override fun onServiceResolved(resolved: NsdServiceInfo) {
            synchronized(resolutions) { resolutions.remove(this) }
            if (!active() || resolved.port !in 1..65535) return
            val hosts = if (Build.VERSION.SDK_INT >= 34) resolved.hostAddresses else listOfNotNull(resolved.host)
            hosts.forEach { add(resolved.serviceName, it, resolved.port, "mdns") }
          }
        }
        synchronized(resolutions) {
          if (!active()) return
          resolutions.add(listener)
        }
        handler.post {
          if (active()) {
            runCatching { nsd.resolveService(serviceInfo, listener) }.onFailure {
              synchronized(resolutions) { resolutions.remove(listener) }
            }
          } else synchronized(resolutions) { resolutions.remove(listener) }
        }
      }
    }

    fun run(): JSONArray {
      handler.post {
        if (active()) {
          discoveryStarted = true
          runCatching { nsd.discoverServices("_smb._tcp.", NsdManager.PROTOCOL_DNS_SD, discovery) }
            .onFailure { discoveryStarted = false }
        }
      }
      runCatching {
        val wifi = app.getSystemService(Context.WIFI_SERVICE) as WifiManager
        val lock = wifi.createMulticastLock("bplayer-smb-discovery").apply { setReferenceCounted(false) }
        synchronized(this) {
          if (active()) { lock.acquire(); multicastLock = lock }
        }
        val datagram = java.net.MulticastSocket(null).apply { timeToLive = 1 }
        synchronized(this) {
          if (!active()) { datagram.close(); return@runCatching }
          socket = datagram
        }
        datagram.reuseAddress = false
        datagram.bind(InetSocketAddress(0))
        datagram.soTimeout = 250
        val probe = ("<?xml version=\"1.0\" encoding=\"utf-8\"?>" +
          "<s:Envelope xmlns:s=\"http://www.w3.org/2003/05/soap-envelope\" xmlns:a=\"http://schemas.xmlsoap.org/ws/2004/08/addressing\" xmlns:d=\"http://schemas.xmlsoap.org/ws/2005/04/discovery\" xmlns:dp=\"http://schemas.xmlsoap.org/ws/2006/02/devprof\">" +
          "<s:Header><a:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</a:Action><a:MessageID>$messageId</a:MessageID>" +
          "<a:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</a:To></s:Header><s:Body><d:Probe><d:Types>dp:Device</d:Types></d:Probe></s:Body></s:Envelope>").toByteArray(Charsets.UTF_8)
        datagram.send(DatagramPacket(probe, probe.size, InetAddress.getByName("239.255.255.250"), 3702))
      }
      var packets = 0
      while (active() && !Thread.currentThread().isInterrupted) {
        val datagram = socket
        if (datagram == null || datagram.isClosed || packets >= 128) {
          cancelled.await(minOf(200, (deadline - SystemClock.elapsedRealtime()).coerceAtLeast(1)), TimeUnit.MILLISECONDS)
          continue
        }
        val bytes = ByteArray(16385)
        val packet = DatagramPacket(bytes, bytes.size)
        try {
          datagram.receive(packet)
          packets++
          if (packet.length <= 16384 && localAddress(packet.address) && safeProbeMatch(bytes, packet.length)) {
            add(packet.address.hostAddress.orEmpty(), packet.address, 445, "ws-discovery")
          }
        } catch (_: SocketTimeoutException) {
          continue
        } catch (_: Exception) {
          datagram.close()
        }
      }
      return synchronized(results) { JSONArray().apply { results.values.forEach { put(it) } } }
    }

    private fun add(name: String, address: InetAddress, port: Int, via: String) {
      if (!active() || !localAddress(address)) return
      val host = address.hostAddress ?: return
      val display = name.filter { it.code >= 32 && it.code != 127 }.take(128).ifBlank { host }
      synchronized(results) {
        if (!active() || results.size >= 32) return
        val key = "$host:$port"
        if (!results.containsKey(key) || via == "mdns") {
          results[key] = JSONObject().put("name", display).put("host", host).put("port", port).put("via", via)
        }
      }
    }

    private fun safeProbeMatch(bytes: ByteArray, size: Int): Boolean = runCatching {
      val xml = String(bytes, 0, size, Charsets.UTF_8)
      if (Regex("<!\\s*(DOCTYPE|ENTITY)", RegexOption.IGNORE_CASE).containsMatchIn(xml)) return@runCatching false
      val parser = Xml.newPullParser().apply {
        setFeature(XmlPullParser.FEATURE_PROCESS_NAMESPACES, true)
        setFeature(XmlPullParser.FEATURE_PROCESS_DOCDECL, false)
        setInput(StringReader(xml))
      }
      var match = false
      var related = false
      var field = false
      val text = StringBuilder()
      var events = 0
      while (true) {
        if (++events > 2048) return@runCatching false
        when (parser.nextToken()) {
          XmlPullParser.END_DOCUMENT -> break
          XmlPullParser.DOCDECL, XmlPullParser.ENTITY_REF -> return@runCatching false
          XmlPullParser.START_TAG -> {
            if (parser.depth > 24) return@runCatching false
            if (parser.name == "ProbeMatch" && parser.namespace in setOf("http://schemas.xmlsoap.org/ws/2005/04/discovery", "http://docs.oasis-open.org/ws-dd/ns/discovery/2009/01")) match = true
            if (parser.name == "RelatesTo" && parser.namespace in setOf("http://schemas.xmlsoap.org/ws/2004/08/addressing", "http://www.w3.org/2005/08/addressing")) { field = true; text.setLength(0) }
          }
          XmlPullParser.TEXT, XmlPullParser.CDSECT -> if (field) {
            text.append(parser.text)
            if (text.length > 256) return@runCatching false
          }
          XmlPullParser.END_TAG -> if (field && parser.name == "RelatesTo") { related = text.toString().trim() == messageId; field = false }
        }
      }
      match && related
    }.getOrDefault(false)

    override fun close() {
      if (!alive.compareAndSet(true, false)) return
      cancelled.countDown()
      synchronized(this) {
        socket?.close()
        socket = null
        multicastLock?.let { runCatching { if (it.isHeld) it.release() } }
        multicastLock = null
      }
      handler.post {
        if (discoveryStarted) runCatching { nsd.stopServiceDiscovery(discovery) }
        val pending = synchronized(resolutions) { resolutions.toList().also { resolutions.clear() } }
        if (Build.VERSION.SDK_INT >= 34) pending.forEach { listener -> runCatching { nsd.stopServiceResolution(listener) } }
      }
    }
  }

  private fun localAddress(address: InetAddress): Boolean {
    if (address.isAnyLocalAddress || address.isLoopbackAddress || address.isMulticastAddress) return false
    val bytes = address.address
    return address.isSiteLocalAddress || address.isLinkLocalAddress || (bytes.size == 16 && bytes[0].toInt() and 0xfe == 0xfc)
  }
}
