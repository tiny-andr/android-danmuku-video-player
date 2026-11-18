package com.danmuku.bplayer.android.mpv

import android.content.Context
import android.graphics.SurfaceTexture
import android.util.Log
import android.view.Surface
import android.view.TextureView
import dev.jdtech.mpv.MPVLib

/**
 * Texture that libmpv renders into.
 *
 * TextureView rather than SurfaceView on purpose: the Tauri WebView composites on its own
 * SurfaceControl layer which always wins against a SurfaceView's media sublayer (measured:
 * `vo-configured=yes`, surface attached, hardware decoding running, screen still black; only
 * `setZOrderOnTop` made the picture appear, and that would cover the danmaku). A TextureView is
 * an ordinary View, so it composites in normal View order — added at index 0 it sits under the
 * transparent WebView and the picture shows through.
 */
class MPVView(context: Context) : TextureView(context), TextureView.SurfaceTextureListener {

    private var mpv: MPVLib? = null
    private var surface: Surface? = null
    private var pendingFile: String? = null
    private var pendingStart = -1.0

    @Volatile var surfaceCreates = 0
    @Volatile var attaches = 0
    @Volatile var lastAttachValid = false
    @Volatile var lastError = ""

    var onEvent: ((Int) -> Unit)? = null
    var onEndFile: ((Int, Int) -> Unit)? = null

    val lib: MPVLib? get() = mpv

    private val observer = object : MPVLib.EventObserver {
        override fun event(eventId: Int) {
            post { onEvent?.invoke(eventId) }
        }

        override fun eventEndFile(reason: Int, error: Int) {
            post { onEndFile?.invoke(reason, error) }
        }
    }

    fun initialize() {
        if (mpv != null) return
        val created = MPVLib.create(context.applicationContext)
        if (created == null) {
            lastError = "mpv_create failed"
            Log.e(TAG, lastError)
            return
        }
        mpv = created

        created.setOptionString("config", "no")
        created.setOptionString("idle", "yes")
        created.setOptionString("vo", "gpu")
        created.setOptionString("gpu-context", "android")
        created.setOptionString("opengl-es", "yes")
        created.setOptionString("hwdec", "mediacodec,mediacodec-copy")
        created.setOptionString("ao", "audiotrack,opensles")
        created.setOptionString("keep-open", "yes")
        created.setOptionString("osd-level", "0")
        created.setOptionString("save-position-on-quit", "no")
        created.setOptionString("demuxer-max-bytes", (64L * 1024 * 1024).toString())
        created.setOptionString("audio-file-auto", "no")
        // 内嵌轨由 mpv 按容器 default 自动选，libass/PGS 直接画在画面上；外挂字幕等用户
        // 显式选择后再 sub-add。前端不再抽取 cue 文本。
        created.setOptionString("sub-auto", "fuzzy")
        // 字号交给 mpv 按窗口高度缩放（`sub-scale-by-window=yes`）。
        // 试过 `=no` + 前端反向补偿，实测 `sub-scale` 与画面缩放不是线性关系：
        // 横屏乘 1.96 会把字幕放大到占满屏幕，竖屏乘 3.62 反而正常。
        // 在那条关系被实测清楚之前，先不自己做补偿。
        created.setOptionString("sub-scale-by-window", "yes")
        created.setOptionString("image-subs-video-resolution", "no")
        created.init()

        created.requestLogMessages("warn")
        created.addObserver(observer)
        surfaceTextureListener = this
    }

    fun shutdown() {
        surfaceTextureListener = null
        mpv?.let {
            it.removeObserver(observer)
            try { it.setPropertyString("vo", "null") } catch (_: Throwable) {}
            try { it.detachSurface() } catch (_: Throwable) {}
            it.destroy()
        }
        mpv = null
        surface?.release()
        surface = null
    }

    fun open(path: String, startAt: Double = -1.0) {
        val lib = mpv ?: return
        pendingStart = startAt
        val live = surface
        if (live != null && live.isValid) {
            pendingFile = null
            lib.setPropertyString("vo", "gpu")
            lib.command(arrayOf("loadfile", path))
            applyPendingStart(lib)
        } else {
            pendingFile = path
        }
    }

    private fun applyPendingStart(lib: MPVLib) {
        val at = pendingStart
        pendingStart = -1.0
        if (at > 0.0) lib.command(arrayOf("seek", at.toString(), "absolute"))
    }

    // ---- TextureView.SurfaceTextureListener ----

    override fun onSurfaceTextureAvailable(st: SurfaceTexture, width: Int, height: Int) {
        surfaceCreates++
        val lib = mpv ?: return
        try {
            st.setDefaultBufferSize(width.coerceAtLeast(1), height.coerceAtLeast(1))
            val s = Surface(st)
            surface?.release()
            surface = s
            lastAttachValid = s.isValid
            lib.attachSurface(s)
            attaches++
            lib.setPropertyString("vo", "gpu")
            lib.setPropertyString("android-surface-size", "${width}x$height")
            val file = pendingFile
            pendingFile = null
            if (file != null) {
                lib.command(arrayOf("loadfile", file))
                applyPendingStart(lib)
            }
        } catch (e: Throwable) {
            lastError = e.message ?: e.toString()
            Log.e(TAG, "surface attach failed", e)
        }
    }

    override fun onSurfaceTextureSizeChanged(st: SurfaceTexture, width: Int, height: Int) {
        try {
            mpv?.setPropertyString("android-surface-size", "${width}x$height")
        } catch (_: Throwable) {}
    }

    override fun onSurfaceTextureDestroyed(st: SurfaceTexture): Boolean {
        mpv?.let {
            try { it.setPropertyString("vo", "null") } catch (_: Throwable) {}
            try { it.detachSurface() } catch (_: Throwable) {}
        }
        surface?.release()
        surface = null
        return true
    }

    override fun onSurfaceTextureUpdated(st: SurfaceTexture) {}

    companion object {
        private const val TAG = "BplayerMpv"
    }
}
