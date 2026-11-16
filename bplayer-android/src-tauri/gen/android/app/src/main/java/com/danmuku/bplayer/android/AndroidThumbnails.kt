package com.danmuku.bplayer.android

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.net.Uri
import android.os.Binder
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Parcel
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject
import java.io.Closeable
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

@androidx.annotation.Keep
internal class AndroidThumbnails(
  context: Context,
  private val webView: WebView,
  private val factory: (String, ThumbnailCancellation) -> ThumbnailRangeSource
) : Closeable {
  private val context = context.applicationContext
  private val main = Handler(Looper.getMainLooper())
  private val cache = ThumbnailCache(File(this.context.cacheDir, "video-thumbnails-v1"))
  private val worker = ThreadPoolExecutor(1, 1, 30, TimeUnit.SECONDS, LinkedBlockingQueue(32),
    { task -> Thread(task, "thumbnail-source").apply { isDaemon = true } })
  private val cacheWorker = ThreadPoolExecutor(1, 1, 30, TimeUnit.SECONDS, LinkedBlockingQueue(48),
    { task -> Thread(task, "thumbnail-cache").apply { isDaemon = true } })
  private val jobs = mutableMapOf<String, Job>()
  private val decoderGate = ThumbnailDecoderGate()
  private var decoderOwner: Job? = null
  private var closed = false

  private inner class Job(val id: String, val path: String, val args: JSONObject) : Runnable {
    val createdAt = android.os.SystemClock.elapsedRealtime()
    @Volatile var startedAt = 0L
    @Volatile var sourceStartedAt = 0L
    @Volatile var sourceMs = 0L
    @Volatile var decodeStartedAt = 0L
    @Volatile var phase = "queued"
    @Volatile var failure = ""
    @Volatile var decoderPhase = ""
    @Volatile var budget: ThumbnailBudget? = null
    val done = AtomicBoolean(false)
    val decoderDead = CountDownLatch(1)
    val latch = CountDownLatch(1)
    @Volatile var cancellation: ThumbnailCancellation? = null
    @Volatile var decoder: IBinder? = null
    @Volatile var bound = false
    var connection: ServiceConnection? = null
    var jpeg: ByteArray? = null
    val timeout = Runnable { finish(this, null, "timeout") }
    override fun run() {
      if (done.get()) return
      startedAt = android.os.SystemClock.elapsedRealtime()
      phase = "cache"
      val token = ThumbnailCancellation()
      cancellation = token
      if (done.get()) { token.cancel(); return }
      main.post { if (!done.get()) main.postDelayed(timeout, 4000) }
      var source: ThumbnailRangeSource? = null
      try {
        token.check()
        val size = args.optLong("size", -1).takeIf { it >= 0 }
        val modified = if (args.isNull("modified_ms")) null else args.optLong("modified_ms")
        val cached = if (args.optBoolean("cacheOnly")) {
          if (size == null) cache.latest(path) else cache.get(path, size, modified)
        } else cache.get(path, size, modified)
        if (cached != null) { finish(this, cached, "cache"); return }
        if (args.optBoolean("cacheOnly")) { finish(this, null, "missing"); return }
        phase = "source"; sourceStartedAt = android.os.SystemClock.elapsedRealtime()
        val opened = if (path.startsWith("/@network/")) factory(path, token) else LocalSource(path, token)
        source = opened
        sourceMs = android.os.SystemClock.elapsedRealtime() - sourceStartedAt
        token.onCancel { opened.abort() }
        token.check()
        if (opened.size <= 0) throw IOException("Thumbnail file is empty")
        val actualCached = cache.get(path, opened.size, opened.modifiedMs)
        if (actualCached != null) { finish(this, actualCached, "cache"); return }
        val reader = ThumbnailBudget(opened, token)
        budget = reader
        phase = "decode"; decodeStartedAt = android.os.SystemClock.elapsedRealtime()
        bind(this, reader, opened.size)
        while (!done.get() && !latch.await(100, TimeUnit.MILLISECONDS)) token.check()
        token.check()
        val result = jpeg
        if (result != null && !done.get()) cache.put(path, opened.size, opened.modifiedMs, result)
        finish(this, result, if (result == null) "unsupported" else "ready")
      } catch (error: Exception) {
        failure = error.javaClass.simpleName
        finish(this, null, "unavailable")
      } finally {
        runCatching { source?.close() }
        stopDecoder(this)
        if (decoder != null) runCatching { decoderDead.await(1500, TimeUnit.MILLISECONDS) }
      }
    }
    fun metrics(): JSONObject {
      val now = android.os.SystemClock.elapsedRealtime()
      return JSONObject().put("queueMs", (if (startedAt == 0L) now else startedAt) - createdAt)
        .put("elapsedMs", if (startedAt == 0L) 0 else now - startedAt)
        .put("sourceMs", if (sourceMs > 0 || sourceStartedAt == 0L) sourceMs else now - sourceStartedAt)
        .put("decodeMs", if (decodeStartedAt == 0L) 0 else now - decodeStartedAt)
        .put("readBytes", budget?.reservedBytes ?: 0).put("readCalls", budget?.readCalls ?: 0)
        .put("phase", phase).put("decoderPhase", decoderPhase).put("failure", failure)
    }
  }

  @JavascriptInterface
  fun request(id: String, command: String, argsJson: String) {
    if (id.length !in 1..128 || argsJson.length > 16384) return
    main.post {
      if (closed || !trusted()) return@post
      if (command != "get" || jobs.containsKey(id)) { reply(id, null, "invalid"); return@post }
      try {
        val args = JSONObject(argsJson)
        val path = ThumbnailPaths.stable(args.getString("path"))
        if (!Regex("(?i).+\\.(mp4|m4v|webm|mov|mkv|avi|ts|flv|wmv|mpg|mpeg)$").matches(path)) {
          reply(id, null, "unsupported"); return@post
        }
        val job = Job(id, path, args)
        jobs[id] = job
        try { (if (args.optBoolean("cacheOnly")) cacheWorker else worker).execute(job) }
        catch (_: java.util.concurrent.RejectedExecutionException) { finish(job, null, "busy") }
      } catch (_: Exception) { reply(id, null, "invalid") }
    }
  }

  @JavascriptInterface
  fun store(id: String, argsJson: String) {
    if (id.length !in 1..128) return
    main.post {
      if (closed || !trusted()) return@post
      if (argsJson.length > 350000 || jobs.containsKey(id)) { reply(id, null, "invalid"); return@post }
      try {
        cacheWorker.execute {
          var stored: ByteArray? = null
          try {
            val args = JSONObject(argsJson)
            val path = ThumbnailPaths.stable(args.getString("path"))
            if (!Regex("(?i).+\\.(mp4|m4v|webm|mov|mkv|avi|ts|flv|wmv|mpg|mpeg)$").matches(path)) {
              throw IOException("Invalid thumbnail video path")
            }
            val size = args.getLong("size")
            if (size <= 0) throw IOException("Invalid thumbnail file size")
            val modified = if (args.isNull("modified_ms")) null else args.getLong("modified_ms")
            if (modified != null && modified < 0) throw IOException("Invalid thumbnail modification time")
            val image = args.getString("image")
            val prefix = "data:image/jpeg;base64,"
            if (!image.startsWith(prefix)) throw IOException("Invalid thumbnail image type")
            val encoded = image.substring(prefix.length)
            if (!Regex("[A-Za-z0-9+/]+={0,2}").matches(encoded)) throw IOException("Invalid thumbnail image encoding")
            val bytes = Base64.decode(encoded, Base64.NO_WRAP)
            if (bytes.size !in 1..262144) throw IOException("Invalid thumbnail image size")
            val options = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
            android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
            if (options.outMimeType != "image/jpeg" || options.outWidth !in 1..320 || options.outHeight !in 1..320) {
              throw IOException("Invalid thumbnail dimensions")
            }
            cache.put(path, size, modified, bytes)
            if (cache.get(path, size, modified)?.contentEquals(bytes) != true) throw IOException("Thumbnail cache write unavailable")
            stored = bytes
          } catch (_: Exception) { Unit }
          main.post { if (!closed) reply(id, stored, if (stored == null) "invalid" else "captured") }
        }
      } catch (_: java.util.concurrent.RejectedExecutionException) { reply(id, null, "busy") }
    }
  }

  @JavascriptInterface
  fun cancel(id: String) {
    main.post { if (!closed && trusted()) jobs[id]?.let { finish(it, null, "cancelled") } }
  }

  private fun bind(job: Job, budget: ThumbnailBudget, size: Long) {
    val sourceBinder = object : Binder() {
      override fun onTransact(code: Int, data: Parcel, reply: Parcel?, flags: Int): Boolean {
        if (code != ThumbnailWire.READ || reply == null) return super.onTransact(code, data, reply, flags)
        data.enforceInterface(ThumbnailWire.DESCRIPTOR)
        try {
          if (job.done.get()) throw IOException("Thumbnail cancelled")
          val position = data.readLong()
          val requested = data.readInt()
          if (requested !in 1..65536) throw IOException("Thumbnail read too large")
          val buffer = ByteArray(requested)
          val count = budget.readAt(position, buffer, 0, requested)
          reply.writeNoException(); reply.writeInt(count)
          if (count >= 0) reply.writeByteArray(buffer, 0, count)
        } catch (_: Exception) { reply.writeException(IllegalStateException("Thumbnail read unavailable")) }
        return true
      }
    }
    val callback = object : Binder() {
      override fun onTransact(code: Int, data: Parcel, reply: Parcel?, flags: Int): Boolean {
        if (code == ThumbnailWire.PROGRESS) {
          data.enforceInterface(ThumbnailWire.DESCRIPTOR)
          job.decoderPhase = data.readString()?.takeIf { it in setOf("metadata", "frame") } ?: ""
          return true
        }
        if (code != ThumbnailWire.RESULT) return super.onTransact(code, data, reply, flags)
        data.enforceInterface(ThumbnailWire.DESCRIPTOR)
        val bytes = data.createByteArray()
        if (!job.done.get() && bytes != null && bytes.size in 1..262144) job.jpeg = bytes
        job.latch.countDown()
        return true
      }
    }
    val connection = object : ServiceConnection {
      override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
        if (service == null) { releaseDecoder(job); job.latch.countDown(); return }
        job.decoder = service
        try {
          service.linkToDeath({
            job.decoderDead.countDown()
            main.post { releaseDecoder(job) }
          }, 0)
        } catch (_: Exception) {
          releaseDecoder(job)
          job.latch.countDown()
          return
        }
        if (job.done.get()) { stopDecoder(job); job.latch.countDown(); return }
        val parcel = ThumbnailWire.parcel()
        try {
          parcel.writeString(job.id)
          parcel.writeStrongBinder(sourceBinder); parcel.writeStrongBinder(callback); parcel.writeLong(size)
          if (!service.transact(ThumbnailWire.START, parcel, null, IBinder.FLAG_ONEWAY)) job.latch.countDown()
        } catch (_: Exception) { job.latch.countDown() }
        finally { parcel.recycle() }
      }
      override fun onServiceDisconnected(name: ComponentName?) { releaseDecoder(job); job.latch.countDown() }
      override fun onNullBinding(name: ComponentName?) { releaseDecoder(job); job.latch.countDown() }
      override fun onBindingDied(name: ComponentName?) { releaseDecoder(job); job.latch.countDown() }
    }
    job.connection = connection
    main.post {
      if (!job.done.get() && decoderGate.claim(job.id)) {
        decoderOwner = job
        try {
          job.bound = context.bindService(Intent(context, ThumbnailDecodeService::class.java), connection, Context.BIND_AUTO_CREATE)
          if (!job.bound) { releaseDecoder(job); job.latch.countDown() }
        } catch (_: Exception) { releaseDecoder(job); job.latch.countDown() }
      } else job.latch.countDown()
    }
  }

  private fun stopDecoder(job: Job) {
    val decoder = job.decoder ?: return
    if (!decoderGate.stopOnce(job.id)) return
    val parcel = ThumbnailWire.parcel()
    try { parcel.writeString(job.id); decoder.transact(ThumbnailWire.STOP, parcel, null, IBinder.FLAG_ONEWAY) }
    catch (_: Exception) { Unit }
    finally { parcel.recycle() }
  }

  private fun releaseDecoder(job: Job) {
    job.decoderDead.countDown()
    job.decoder = null
    decoderGate.release(job.id)
    if (decoderOwner === job) decoderOwner = null
    if (job.bound) {
      job.bound = false
      runCatching { job.connection?.let { context.unbindService(it) } }
    }
  }

  private fun finish(job: Job, bytes: ByteArray?, reason: String) {
    if (!job.done.compareAndSet(false, true)) return
    job.cancellation?.cancel()
    job.latch.countDown()
    worker.remove(job); cacheWorker.remove(job)
    stopDecoder(job)
    val metrics = job.metrics()
    main.post { main.removeCallbacks(job.timeout); jobs.remove(job.id); if (!closed) reply(job.id, bytes, reason, metrics) }
  }

  private fun trusted(): Boolean {
    val uri = Uri.parse(webView.url ?: return false)
    return uri.scheme == "http" && uri.host == "tauri.localhost" && uri.port in setOf(-1, 80)
  }

  private fun reply(id: String, bytes: ByteArray?, reason: String, metrics: JSONObject? = null) {
    if (!trusted()) return
    val result = JSONObject().put("status", reason).put("image", if (bytes == null) JSONObject.NULL else
      "data:image/jpeg;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP))
    if (metrics != null) result.put("metrics", metrics)
    val envelope = JSONObject().put("ok", true).put("result", result)
    val payload = JSONObject.quote(envelope.toString()).replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    webView.evaluateJavascript("window.__aThumbnailReply && window.__aThumbnailReply(${JSONObject.quote(id)},JSON.parse($payload))", null)
  }

  override fun close() {
    main.post {
      closed = true
      jobs.values.toList().forEach { finish(it, null, "cancelled") }
      jobs.clear()
      decoderOwner?.let { stopDecoder(it); releaseDecoder(it) }
      worker.shutdownNow(); cacheWorker.shutdownNow()
    }
  }

  private class LocalSource(path: String, cancellation: ThumbnailCancellation) : ThumbnailRangeSource {
    private val file = File(path)
    private val input = RandomAccessFile(file, "r")
    override val size = input.length()
    override val modifiedMs: Long = file.lastModified()
    init { cancellation.onCancel { abort() }; cancellation.check() }
    @Synchronized
    override fun readAt(position: Long, buffer: ByteArray, offset: Int, length: Int): Int {
      input.seek(position)
      return input.read(buffer, offset, length)
    }
    override fun abort() { runCatching { input.close() } }
    override fun close() { input.close() }
  }
}
