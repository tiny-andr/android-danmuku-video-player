package com.danmuku.bplayer.android

import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.content.Context
import android.database.ContentObserver
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import org.json.JSONObject
import android.os.Build
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
  private var webView: WebView? = null
  private var network: AndroidNetwork? = null
  private var playbackAudio: PlaybackAudioFocus? = null
  private var immersive = false
  private var playbackShape = "home"
  private var playbackOrientationOverride = ""
  @Volatile private var playbackBrightness = -1f
  private val audio by lazy { getSystemService(Context.AUDIO_SERVICE) as AudioManager }
  private val rotationObserver = object : ContentObserver(Handler(Looper.getMainLooper())) {
    override fun onChange(selfChange: Boolean) { applyPlaybackOrientation() }
  }

  private fun applyPlaybackOrientation() {
    val autoRotate = Settings.System.getInt(contentResolver, Settings.System.ACCELEROMETER_ROTATION, 0) != 0
    requestedOrientation = when {
      playbackShape == "home" -> ActivityInfo.SCREEN_ORIENTATION_USER
      playbackOrientationOverride == "landscape" -> ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
      playbackOrientationOverride == "portrait" -> ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
      !autoRotate -> ActivityInfo.SCREEN_ORIENTATION_LOCKED
      playbackShape == "landscape" -> ActivityInfo.SCREEN_ORIENTATION_USER_LANDSCAPE
      playbackShape == "portrait" -> ActivityInfo.SCREEN_ORIENTATION_USER_PORTRAIT
      else -> ActivityInfo.SCREEN_ORIENTATION_USER
    }
  }

  private fun controls(): String {
    val max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC).coerceAtLeast(1)
    val min = if (Build.VERSION.SDK_INT >= 28) audio.getStreamMinVolume(AudioManager.STREAM_MUSIC) else 0
    val systemBrightness = Settings.System.getInt(contentResolver, Settings.System.SCREEN_BRIGHTNESS, 128) / 255f
    return JSONObject().put("brightness", if (playbackBrightness >= 0f) playbackBrightness else systemBrightness)
      .put("volume", audio.getStreamVolume(AudioManager.STREAM_MUSIC)).put("maxVolume", max).put("minVolume", min).toString()
  }
  private val networkPermissionWaiters = mutableListOf<(Boolean) -> Unit>()
  private val networkPermissionLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
    val waiting = networkPermissionWaiters.toList()
    networkPermissionWaiters.clear()
    waiting.forEach { it(granted) }
  }

  private fun ensureNetworkPermission(callback: (Boolean) -> Unit) {
    runOnUiThread {
      if (isFinishing || isDestroyed) {
        callback(false)
      } else if (Build.VERSION.SDK_INT < 37 || checkSelfPermission("android.permission.ACCESS_LOCAL_NETWORK") == PackageManager.PERMISSION_GRANTED) {
        callback(true)
      } else if (networkPermissionWaiters.size >= 64) {
        callback(false)
      } else {
        networkPermissionWaiters.add(callback)
        if (networkPermissionWaiters.size == 1) {
          try { networkPermissionLauncher.launch("android.permission.ACCESS_LOCAL_NETWORK") }
          catch (_: Exception) {
            val waiting = networkPermissionWaiters.toList()
            networkPermissionWaiters.clear()
            waiting.forEach { it(false) }
          }
        }
      }
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    contentResolver.registerContentObserver(Settings.System.getUriFor(Settings.System.ACCELEROMETER_ROTATION), false, rotationObserver)
    applyPlaybackOrientation()

    // 返回键交给网页决定：关闭文件浏览器 / 收起播放列表 / 退出播放页，最后才退出应用。
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val w = webView
        if (w != null) {
          w.evaluateJavascript("window.__aAndroidBack ? window.__aAndroidBack() : false", null)
        } else {
          finish()
        }
      }
    })
  }

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    network?.close()
    network = AndroidNetwork(applicationContext, webView, ::ensureNetworkPermission)
    webView.addJavascriptInterface(network!!, "AndroidNetwork")
    playbackAudio?.close()
    playbackAudio = PlaybackAudioFocus(applicationContext, webView)
    webView.addJavascriptInterface(playbackAudio!!, "AndroidPlaybackAudio")
    // 播放页 JS 通过它控制系统栏；只暴露两个最小能力。
    webView.addJavascriptInterface(object {
      @JavascriptInterface
      fun setImmersive(on: Boolean) {
        runOnUiThread { applyImmersive(on) }
      }

      @JavascriptInterface
      fun exitApp() {
        runOnUiThread { finish() }
      }

      @JavascriptInterface
      fun setPlaybackOrientation(direction: String) {
        if (direction !in setOf("", "portrait", "landscape")) return
        runOnUiThread {
          playbackOrientationOverride = direction
          applyPlaybackOrientation()
        }
      }

      @JavascriptInterface
      fun setVideoOrientation(width: Int, height: Int) {
        runOnUiThread {
          playbackShape = if (width <= 0 || height <= 0) "home" else if (width > height) "landscape" else "portrait"
          if (playbackShape == "home") {
            playbackOrientationOverride = ""
            playbackBrightness = -1f
            window.attributes = window.attributes.apply { screenBrightness = -1f }
          }
          applyPlaybackOrientation()
        }
      }

      @JavascriptInterface
      fun setPlaybackActive(on: Boolean) {
        runOnUiThread {
          if (on) window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
          else window.clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
      }

      @JavascriptInterface
      fun getPlaybackControls(): String = controls()

      @JavascriptInterface
      fun setPlaybackBrightness(value: Float) {
        if (!value.isFinite()) return
        runOnUiThread {
          playbackBrightness = value.coerceIn(0.05f, 1f)
          window.attributes = window.attributes.apply { screenBrightness = playbackBrightness }
        }
      }

      @JavascriptInterface
      fun setPlaybackVolume(index: Int) {
        val max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
        val min = if (Build.VERSION.SDK_INT >= 28) audio.getStreamMinVolume(AudioManager.STREAM_MUSIC) else 0
        runCatching { audio.setStreamVolume(AudioManager.STREAM_MUSIC, index.coerceIn(min, max), 0) }
      }
    }, "AndroidUI")
  }

  override fun onStart() {
    super.onStart()
    playbackAudio?.onStart()
  }

  override fun onStop() {
    playbackAudio?.onStop()
    super.onStop()
  }

  override fun onDestroy() {
    contentResolver.unregisterContentObserver(rotationObserver)
    playbackBrightness = -1f
    window.attributes = window.attributes.apply { screenBrightness = -1f }
    webView?.removeJavascriptInterface("AndroidNetwork")
    webView?.removeJavascriptInterface("AndroidPlaybackAudio")
    playbackAudio?.close()
    playbackAudio = null
    network?.close()
    network = null
    networkPermissionWaiters.clear()
    webView = null
    super.onDestroy()
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    // 从后台回来、或状态栏被系统恢复时，按当前状态重新收紧
    if (hasFocus && immersive) applyImmersive(true)
  }

  private fun applyImmersive(on: Boolean) {
    immersive = on
    val controller = WindowCompat.getInsetsController(window, window.decorView)
    if (on) {
      controller.systemBarsBehavior =
        WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
      controller.hide(WindowInsetsCompat.Type.systemBars())
    } else {
      controller.show(WindowInsetsCompat.Type.systemBars())
    }
  }
}
