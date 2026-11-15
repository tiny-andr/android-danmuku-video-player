package com.danmuku.bplayer.android

import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
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
  private var immersive = false
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

      // 首页跟随传感器（不替用户决定方向）；播放页才转横屏看片。
      @JavascriptInterface
      fun setLandscape(on: Boolean) {
        runOnUiThread {
          requestedOrientation = if (on) {
            ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
          } else {
            ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR
          }
        }
      }
    }, "AndroidUI")
  }

  override fun onDestroy() {
    webView?.removeJavascriptInterface("AndroidNetwork")
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
