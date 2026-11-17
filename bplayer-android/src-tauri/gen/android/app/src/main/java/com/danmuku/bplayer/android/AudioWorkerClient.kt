package com.danmuku.bplayer.android

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import org.json.JSONObject
import java.io.Closeable
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

internal class AudioWorkerClient(context: Context) : Closeable {
  private val context = context.applicationContext
  private val handler = Handler(Looper.getMainLooper())
  private val connected = CountDownLatch(1)
  private data class Pending(val latch: CountDownLatch = CountDownLatch(1),
    @Volatile var result: String? = null, @Volatile var error: String? = null,
    val progress: (Bundle) -> Unit, val assembling: (Bundle) -> Unit = {},
    val started: (Bundle) -> Unit = {})
  private val pending = ConcurrentHashMap<String, Pending>()
  @Volatile private var service: Messenger? = null
  @Volatile private var closed = false
  @Volatile private var bound = false
  private val replies = Messenger(Handler(Looper.getMainLooper()) { message ->
    val id = message.data.getString("jobId") ?: return@Handler true
    val request = pending[id] ?: return@Handler true
    when (message.what) {
      AudioWorkerProtocol.PROGRESS -> request.progress(message.data)
      AudioWorkerProtocol.ASSEMBLING -> request.assembling(message.data)
      AudioWorkerProtocol.STARTED -> request.started(message.data)
      AudioWorkerProtocol.DONE -> { request.result = message.data.getString("result") ?: "{}"; request.latch.countDown() }
      AudioWorkerProtocol.ERROR -> { request.error = message.data.getString("message") ?: "音轨处理失败"; request.latch.countDown() }
    }
    true
  })
  private val connection = object : ServiceConnection {
    override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
      if (closed || binder == null) return
      try {
        binder.linkToDeath({ disconnected() }, 0)
        service = Messenger(binder)
        connected.countDown()
      } catch (_: android.os.RemoteException) { disconnected() }
    }
    override fun onServiceDisconnected(name: ComponentName?) { disconnected() }
    override fun onBindingDied(name: ComponentName?) { disconnected() }
    override fun onNullBinding(name: ComponentName?) { disconnected() }
  }

  init {
    handler.post {
      if (!closed) {
        bound = context.bindService(Intent(context, AudioDecodeService::class.java), connection, Context.BIND_AUTO_CREATE)
        if (!bound) { closed = true; connected.countDown() }
      }
    }
  }

  private fun disconnected() {
    service = null
    closed = true
    connected.countDown()
    pending.values.forEach { it.error = "原生音轨服务已停止，请重新打开影片后重试"; it.latch.countDown() }
  }

  fun call(command: Int, id: String, args: Bundle, cancellation: AudioCancellation,
    progress: (Bundle) -> Unit = {}, assembling: (Bundle) -> Unit = {}): JSONObject {
    cancellation.check()
    if (!connected.await(10, TimeUnit.SECONDS) || closed || service == null) {
      close()
      throw NetworkFailure("原生音轨服务未能启动")
    }
    val request = Pending(progress = progress, assembling = assembling)
    if (pending.putIfAbsent(id, request) != null) throw NetworkFailure("音轨任务标识重复")
    try {
      args.putString("jobId", id)
      val message = Message.obtain(null, command).apply { data = args; replyTo = replies }
      service!!.send(message)
      cancellation.onCancel {
        runCatching { service?.send(Message.obtain(null, AudioWorkerProtocol.CANCEL).apply {
          data = Bundle().apply { putString("jobId", id) }; replyTo = replies
        }) }
      }
      val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(if (command == AudioWorkerProtocol.PROBE) 35 else 1860)
      var cancelledAt = 0L
      while (!request.latch.await(200, TimeUnit.MILLISECONDS)) {
        if (cancellation.cancelled) {
          if (cancelledAt == 0L) cancelledAt = System.nanoTime()
          if (System.nanoTime() - cancelledAt > TimeUnit.SECONDS.toNanos(5)) throw NetworkFailure("音轨任务已取消，原生服务仍在结束处理")
        }
        if (System.nanoTime() >= deadline) {
          cancellation.cancel()
          throw NetworkFailure("音轨处理超时，已请求取消")
        }
      }
      cancellation.check()
      request.error?.let { throw NetworkFailure(it) }
      return JSONObject(request.result ?: throw NetworkFailure("音轨服务没有返回结果"))
    } finally { pending.remove(id, request) }
  }

  val isClosed: Boolean get() = closed

  /**
   * 启动一路流式转码（[AudioWorkerProtocol.STREAM]）。与 [call] 的区别是**不阻塞**：
   * 收到 STARTED 立刻返回，之后由一个守护线程等终态，通过 [onFinished] 回报错误或完成。
   * 流式期间主进程要不停读文件，阻塞在这里会把单线程的执行器堵死。
   */
  fun startStream(id: String, args: Bundle, cancellation: AudioCancellation,
    onStarted: () -> Unit, onFinished: (String?) -> Unit): Boolean {
    if (!connected.await(10, TimeUnit.SECONDS) || closed || service == null) { close(); return false }
    val request = Pending(progress = {}, started = { onStarted() })
    if (pending.putIfAbsent(id, request) != null) return false
    val sent = try {
      args.putString("jobId", id)
      service!!.send(Message.obtain(null, AudioWorkerProtocol.STREAM).apply { data = args; replyTo = replies })
      cancellation.onCancel {
        runCatching { service?.send(Message.obtain(null, AudioWorkerProtocol.CANCEL).apply {
          data = Bundle().apply { putString("jobId", id) }; replyTo = replies
        }) }
      }
      true
    } catch (_: Exception) { false }
    if (!sent) { pending.remove(id, request); return false }
    Thread({
      try {
        // 上限与 worker 侧一致（60 分钟）；超时让 worker 自己收尾，这里只负责回报
        if (!request.latch.await(61, TimeUnit.MINUTES)) onFinished("音轨流等待超时")
        else onFinished(request.error)
      } catch (_: InterruptedException) { onFinished("音轨流已中断") }
      finally { pending.remove(id, request) }
    }, "audio-stream-wait").apply { isDaemon = true }.start()
    return true
  }

  /** 停一路流：只发 CANCEL，不等待（worker 会自己取消 ffmpeg 并清理文件）。 */
  fun stopStream(id: String) {
    runCatching {
      service?.send(Message.obtain(null, AudioWorkerProtocol.CANCEL).apply {
        data = Bundle().apply { putString("jobId", id) }; replyTo = replies
      })
    }
  }

  override fun close() {
    if (closed && !bound) return
    closed = true
    pending.keys.forEach { id ->
      runCatching { service?.send(Message.obtain(null, AudioWorkerProtocol.CANCEL).apply {
        data = Bundle().apply { putString("jobId", id) }; replyTo = replies
      }) }
    }
    disconnected()
    handler.post {
      if (bound) { runCatching { context.unbindService(connection) }; bound = false }
    }
  }
}
