package com.danmuku.bplayer.android

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.AudioFocusRequest
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

/**
 * 播放会话 + 系统音频焦点。
 *
 * 0.2.0 起解码和发声都在本进程的 libmpv 里，Chromium 不再持焦：这一层必须自己申请
 * `AudioFocusRequest`，否则来电或别的 App 放声音时会双声。策略按 AGENTS.md：
 * `LOSS` / `LOSS_TRANSIENT` 一律暂停且**不自动恢复**，让用户自己点播放。
 */
@androidx.annotation.Keep
internal class PlaybackAudioFocus(context: Context, private val webView: WebView) : Closeable {
  private val app = context.applicationContext
  private val state = PlaybackSessionState()
  private val lifecycleClosed = java.util.concurrent.atomic.AtomicBoolean(false)
  @Volatile private var closed = false
  private var registered = false
  private val audioManager = app.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private var focusRequest: AudioFocusRequest? = null

  private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
    val session = state.active() ?: return@OnAudioFocusChangeListener
    when (change) {
      AudioManager.AUDIOFOCUS_LOSS,
      AudioManager.AUDIOFOCUS_LOSS_TRANSIENT ->
        if (state.interrupt(session)) notify(session, "focus-loss")
      // AUDIOFOCUS_GAIN 不自动续播：用户可能是被电话打断的，恢复播放要他自己决定。
      else -> Unit
    }
  }

  private fun abandonSystemFocus() {
    focusRequest?.let { runCatching { audioManager.abandonAudioFocusRequest(it) } }
  }
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

  /** 授予播放会话并申请系统音频焦点；被拒时调用方不应开始播放。 */
  @JavascriptInterface
  fun requestFocus(): Boolean {
    if (closed || state.begin() == null) return false
    val request = focusRequest ?: AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
      .setAudioAttributes(
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_MEDIA)
          .setContentType(AudioAttributes.CONTENT_TYPE_MOVIE)
          .build()
      )
      .setOnAudioFocusChangeListener(focusListener)
      .build()
      .also { focusRequest = it }
    return audioManager.requestAudioFocus(request) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
  }

  /** 页面暂停、退出或换片时结束会话并交还焦点。 */
  @JavascriptInterface
  fun abandonFocus() {
    state.abandon()
    abandonSystemFocus()
  }

  fun onStart() { if (!closed) state.foreground(true) }

  fun onStop() {
    if (closed) return
    notify(state.background(), "background")
    abandonSystemFocus()
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
    abandonSystemFocus()
    if (registered) { registered = false; runCatching { app.unregisterReceiver(noisy) } }
  }
}
