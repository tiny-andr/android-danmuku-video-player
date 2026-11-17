package com.danmuku.bplayer.android

import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.content.Context
import android.database.ContentObserver
import android.media.AudioManager
import android.net.Uri
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.View
import android.widget.Toast
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
  private var thumbnails: AndroidThumbnails? = null
  private var playbackAudio: PlaybackAudioFocus? = null
  private var audioNative: AndroidAudioNative? = null
  private var updateChecker: UpdateChecker? = null
  private var immersive = false
  private var playbackActive = false
  private var keepScreenOn = true
  private var foreground = false
  private var playbackShape = "home"
  private var playbackOrientationOverride = ""
  @Volatile private var playbackBrightness = -1f
  private val audio by lazy { getSystemService(Context.AUDIO_SERVICE) as AudioManager }
  private val rotationObserver = object : ContentObserver(Handler(Looper.getMainLooper())) {
    override fun onChange(selfChange: Boolean) { applyPlaybackOrientation() }
  }

  private fun applyPlaybackOrientation() {
    val autoRotate = Settings.System.getInt(contentResolver, Settings.System.ACCELEROMETER_ROTATION, 0) != 0
    // 大屏（折叠机展开内屏、平板）上 USER_LANDSCAPE / USER_PORTRAIT 依旧不生效，
    // 只有显式 LANDSCAPE / PORTRAIT 能把视频按比例铺满；小屏保持跟随传感器的
    // user 系列，避免手机被硬锁方向。
    val largeScreen = resources.configuration.smallestScreenWidthDp >= 600
    requestedOrientation = when {
      playbackShape == "home" -> ActivityInfo.SCREEN_ORIENTATION_USER
      playbackOrientationOverride == "landscape" -> ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
      playbackOrientationOverride == "portrait" -> ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
      !autoRotate -> ActivityInfo.SCREEN_ORIENTATION_LOCKED
      playbackShape == "landscape" ->
        if (largeScreen) ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE else ActivityInfo.SCREEN_ORIENTATION_USER_LANDSCAPE
      playbackShape == "portrait" ->
        if (largeScreen) ActivityInfo.SCREEN_ORIENTATION_PORTRAIT else ActivityInfo.SCREEN_ORIENTATION_USER_PORTRAIT
      else -> ActivityInfo.SCREEN_ORIENTATION_USER
    }
  }

  // 文件浏览和播放都直接走文件路径，依赖「所有文件访问权限」。这个权限是特殊的
  // 应用访问权限（MANAGE_EXTERNAL_STORAGE），没有运行时授权弹窗：新装应用默认关闭，
  // 只能由用户在系统设置页里手动打开。所以必须在打开浏览器前主动检测并引导，
  // 否则新用户看到的是一个空白目录，会以为软件坏了。
  private fun storageAccessGranted(): Boolean =
    if (Build.VERSION.SDK_INT >= 30) {
      Environment.isExternalStorageManager()
    } else {
      checkSelfPermission(android.Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED
    }

  private fun requestStorageAccess() {
    // 提示停留时间统一按 60% 缩短（用户 2026-11-17 要求）。原生 Toast 只有两档，
    // LONG≈3.5s、SHORT≈2s（≈57%），取 SHORT；读不完也不影响后续步骤——
    // 跳转前还有一次同样的提示，返回首页后常驻的权限横幅会继续引导。
    Toast.makeText(this, "请允许「所有文件访问权限」，返回本应用后再次点击即可浏览", Toast.LENGTH_SHORT).show()
    val packageUri = Uri.fromParts("package", packageName, null)
    val primary = if (Build.VERSION.SDK_INT >= 30) {
      Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, packageUri)
    } else {
      Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, packageUri)
    }
    try {
      startActivity(primary)
    } catch (error: Exception) {
      // 少数机型没有应用专属页，退到全量列表页，再不济交给应用详情。
      runCatching { startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)) }
        .onFailure {
          runCatching {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, packageUri))
          }
        }
    }
  }

  private fun clearViewKeepScreenOn(view: android.view.View) {
    if (view.keepScreenOn) view.keepScreenOn = false
    if (view is android.view.ViewGroup) {
      for (index in 0 until view.childCount) clearViewKeepScreenOn(view.getChildAt(index))
    }
  }

  private fun applyKeepScreenOn() {
    val enabled = foreground && playbackActive && keepScreenOn
    val flag = android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
    if (!enabled) clearViewKeepScreenOn(window.decorView)
    if ((window.attributes.flags and flag != 0) != enabled) {
      if (enabled) window.addFlags(flag) else window.clearFlags(flag)
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
    // enableEdgeToEdge() 在 super 之前调用，Tauri/WryActivity 的 onCreate 之后可能重置
    // decorFits，这里再钉一次：内容是 edge-to-edge 的，否则底部系统条区域会被当成布局边界。
    WindowCompat.setDecorFitsSystemWindows(window, false)
    window.decorView.viewTreeObserver.addOnGlobalLayoutListener { applyKeepScreenOn() }
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
    audioNative?.close()
    audioNative = AndroidAudioNative(applicationContext, webView)
    audioNative?.setForeground(foreground)
    webView.addJavascriptInterface(audioNative!!, "AndroidAudioNative")
    thumbnails?.close()
    val thumbnailSources = NetworkThumbnailSources(applicationContext)
    thumbnails = AndroidThumbnails(applicationContext, webView, thumbnailSources::open)
    webView.addJavascriptInterface(thumbnails!!, "AndroidThumbnails")
    playbackAudio?.close()
    playbackAudio = PlaybackAudioFocus(applicationContext, webView)
    webView.addJavascriptInterface(playbackAudio!!, "AndroidPlaybackAudio")
    // 应用内升级：检查 GitHub Release → 镜像下载 → sha256 校验 → 调起系统安装器。
    updateChecker?.close()
    updateChecker = UpdateChecker(applicationContext, this, webView)
    webView.addJavascriptInterface(updateChecker!!, "AndroidUpdate")
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
          playbackActive = on
          applyKeepScreenOn()
        }
      }

      @JavascriptInterface
      fun setKeepScreenOn(on: Boolean) {
        runOnUiThread {
          keepScreenOn = on
          applyKeepScreenOn()
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

      @JavascriptInterface
      fun hasAllFilesAccess(): Boolean = storageAccessGranted()

      @JavascriptInterface
      fun requestAllFilesAccess() {
        runOnUiThread { requestStorageAccess() }
      }

      // 首页要在界面上标出这是调试包，不然 debug 和正式包装在一起时分不清。
      @JavascriptInterface
      fun buildKind(): String = if (BuildConfig.DEBUG) "debug" else "release"
    }, "AndroidUI")
  }

  override fun onStart() {
    super.onStart()
    foreground = true
    applyKeepScreenOn()
    playbackAudio?.onStart()
    audioNative?.setForeground(true)
  }

  override fun onStop() {
    foreground = false
    applyKeepScreenOn()
    playbackAudio?.onStop()
    audioNative?.setForeground(false)
    super.onStop()
  }

  override fun onDestroy() {
    contentResolver.unregisterContentObserver(rotationObserver)
    playbackBrightness = -1f
    window.attributes = window.attributes.apply { screenBrightness = -1f }
    webView?.removeJavascriptInterface("AndroidAudioNative")
    audioNative?.close()
    audioNative = null
    webView?.removeJavascriptInterface("AndroidNetwork")
    webView?.removeJavascriptInterface("AndroidThumbnails")
    thumbnails?.close()
    thumbnails = null
    webView?.removeJavascriptInterface("AndroidPlaybackAudio")
    playbackAudio?.close()
    playbackAudio = null
    webView?.removeJavascriptInterface("AndroidUpdate")
    updateChecker?.close()
    updateChecker = null
    network?.close()
    network = null
    networkPermissionWaiters.clear()
    webView = null
    super.onDestroy()
  }

  override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
    super.onConfigurationChanged(newConfig)
    webView?.let { view ->
      view.post {
        if (!isDestroyed) {
          view.requestLayout()
          view.invalidate()
        }
      }
    }
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
      applyLegacyImmersive(true)
    } else {
      controller.show(WindowInsetsCompat.Type.systemBars())
      applyLegacyImmersive(false)
    }
  }

  // 荣耀折叠屏（MagicOS）开了桌面任务栏（secure is_taskbar_switch_open=1）时，只调
  // WindowInsetsController.hide(systemBars()) 不够：系统仍按「任务栏 + 导航栏」缩小窗口的
  // appBounds，播放页底部会露出约 141 CSS px 的系统条（实测窗口 2156x1983，屏幕 2156x2344，
  // 同机系统设置窗口是全屏 2156x2344，且它的 vsysui 带 IMMERSIVE 位）。补上旧式
  // systemUiVisibility 位后 appBounds 才回到全屏。
  @Suppress("DEPRECATION")
  private fun applyLegacyImmersive(on: Boolean) {
    window.decorView.systemUiVisibility = if (on) {
      View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
        View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or
        View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
        View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
        View.SYSTEM_UI_FLAG_FULLSCREEN or
        View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
    } else {
      View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
        View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or
        View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
    }
  }
}
