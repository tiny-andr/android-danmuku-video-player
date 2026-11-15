package com.danmuku.bplayer.android

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject
import java.io.Closeable

internal class PlaybackSessionState {
  private var generation = 0L
  private var current: Long? = null
  private var foreground = true
  private var closed = false

  @Synchronized fun begin(): Long? {
    if (closed || !foreground) return null
    current?.let { return it }
    return (++generation).also { current = it }
  }

  @Synchronized fun interrupt(session: Long): Boolean {
    if (closed || current != session) return false
    current = null
    return true
  }

  @Synchronized fun abandon(): Long? {
    generation++
    return current.also { current = null }
  }

  @Synchronized fun active(): Long? = current
  @Synchronized fun valid(event: Long): Boolean = !closed && generation == event
  @Synchronized fun foreground(on: Boolean) { foreground = on }
  @Synchronized fun background(): Long {
    foreground = false
    abandon()
    return generation
  }
  @Synchronized fun close() {
    abandon()
    closed = true
  }
}

/** Chromium 是唯一的系统音频焦点所有者；此桥只管理前台播放会话及暂停通知。 */
@androidx.annotation.Keep
internal class PlaybackAudioFocus(context: Context, private val webView: WebView) : Closeable {
  private val app = context.applicationContext
  private val state = PlaybackSessionState()
  private val lifecycleClosed = java.util.concurrent.atomic.AtomicBoolean(false)
  @Volatile private var closed = false
  private var registered = false
  private val noisy = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      if (intent?.action != AudioManager.ACTION_AUDIO_BECOMING_NOISY) return
      val session = state.active() ?: return
      if (state.interrupt(session)) notify(session, "headphones-disconnected")
    }
  }

  init {
    val filter = IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY)
    if (Build.VERSION.SDK_INT >= 33) app.registerReceiver(noisy, filter, Context.RECEIVER_NOT_EXPORTED)
    else app.registerReceiver(noisy, filter)
    registered = true
  }

  /** 保留桥接口名称：只授予前台会话许可，不申请或声称持有系统音频焦点。 */
  @JavascriptInterface
  fun requestFocus(): Boolean = !closed && state.begin() != null

  /** 页面暂停、退出或换片时结束会话；系统焦点释放由 Chromium 随媒体暂停处理。 */
  @JavascriptInterface
  fun abandonFocus() { state.abandon() }

  fun onStart() { if (!closed) state.foreground(true) }

  fun onStop() {
    if (!closed) notify(state.background(), "background")
  }

  private fun notify(generation: Long, reason: String) {
    webView.post {
      if (closed || !state.valid(generation)) return@post
      val uri = Uri.parse(webView.url ?: return@post)
      if (uri.scheme != "http" || uri.host != "tauri.localhost" || (uri.port != -1 && uri.port != 80)) return@post
      webView.evaluateJavascript("window.AndroidPlaybackAudioEvent && window.AndroidPlaybackAudioEvent(${JSONObject.quote(reason)})", null)
    }
  }

  override fun close() {
    if (!lifecycleClosed.compareAndSet(false, true)) return
    closed = true
    state.close()
    if (registered) { registered = false; runCatching { app.unregisterReceiver(noisy) } }
  }
}
