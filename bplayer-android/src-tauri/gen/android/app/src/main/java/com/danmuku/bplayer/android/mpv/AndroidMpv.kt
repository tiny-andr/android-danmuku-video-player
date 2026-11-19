package com.danmuku.bplayer.android.mpv

import android.graphics.Matrix
import android.webkit.JavascriptInterface
import android.webkit.WebView
import dev.jdtech.mpv.MPVLib

/**
 * JS bridge for the libmpv player.
 *
 * Everything is synchronous on purpose: the danmaku layer reads the clock from a rAF loop, and a
 * request/reply round trip per frame would add latency for no benefit. `@JavascriptInterface`
 * calls are plain JNI calls, and mpv's property getters are thread safe, so the JavaBridge thread
 * is a fine caller.
 *
 * Times are seconds (mpv native unit). Callers stop polling once [ready] is false.
 */
class AndroidMpv(private val view: MPVView, private val webView: WebView) {

    init {
        view.onEndFile = { reason, error ->
            webView.evaluateJavascript("window.__mpvEndFile&&window.__mpvEndFile($reason,$error)", null)
        }
        view.onEvent = { id ->
            if (id == MPVLib.MpvEvent.MPV_EVENT_FILE_LOADED) {
                webView.evaluateJavascript("window.__mpvFileLoaded&&window.__mpvFileLoaded()", null)
            }
        }
    }

    @JavascriptInterface
    fun ready(): Boolean = view.lib != null

    @JavascriptInterface
    fun open(path: String, startAt: Double): Boolean {
        val lib = view.lib ?: return false
        view.open(path, startAt)
        return true
    }

    @JavascriptInterface
    fun timePos(): Double = view.lib?.getPropertyDouble("time-pos") ?: 0.0

    @JavascriptInterface
    fun duration(): Double = view.lib?.getPropertyDouble("duration") ?: 0.0

    @JavascriptInterface
    fun paused(): Boolean = view.lib?.getPropertyBoolean("pause") ?: true

    @JavascriptInterface
    fun eof(): Boolean = view.lib?.getPropertyBoolean("eof-reached") ?: false

    @JavascriptInterface
    fun playing(): Boolean = view.lib?.getPropertyBoolean("pause")?.not() ?: false

    @JavascriptInterface
    fun buffering(): Boolean = view.lib?.getPropertyBoolean("paused-for-cache") ?: false

    @JavascriptInterface
    fun play() {
        view.lib?.setPropertyBoolean("pause", false)
    }

    @JavascriptInterface
    fun pause() {
        view.lib?.setPropertyBoolean("pause", true)
    }

    @JavascriptInterface
    fun seekTo(seconds: Double) {
        if (!seconds.isFinite()) return
        view.lib?.command(arrayOf("seek", seconds.toString(), "absolute"))
    }

    @JavascriptInterface
    fun setRate(value: Double) {
        if (!value.isFinite() || value <= 0.0) return
        view.lib?.setPropertyDouble("speed", value)
    }

    @JavascriptInterface
    fun rate(): Double = view.lib?.getPropertyDouble("speed") ?: 1.0

    /** 0..100, mpv's own scale. */
    @JavascriptInterface
    fun setVolume(value: Double) {
        if (!value.isFinite()) return
        view.lib?.setPropertyDouble("volume", value.coerceIn(0.0, 100.0))
    }

    @JavascriptInterface
    fun volume(): Double = view.lib?.getPropertyDouble("volume") ?: 100.0

    @JavascriptInterface
    fun setMute(on: Boolean) {
        view.lib?.setPropertyBoolean("mute", on)
    }

    @JavascriptInterface
    fun muted(): Boolean = view.lib?.getPropertyBoolean("mute") ?: false

    /** Raw mpv `track-list` JSON; the front end owns the shape it needs. */
    @JavascriptInterface
    fun tracks(): String = view.lib?.getPropertyString("track-list") ?: "[]"

    @JavascriptInterface
    fun vid(): Int = view.lib?.getPropertyInt("vid") ?: 0

    @JavascriptInterface
    fun aid(): Int = view.lib?.getPropertyInt("aid") ?: 0

    @JavascriptInterface
    fun sid(): Int = view.lib?.getPropertyInt("sid") ?: 0

    @JavascriptInterface
    fun setVid(id: Int) {
        view.lib?.setPropertyString("vid", if (id <= 0) "no" else id.toString())
    }

    @JavascriptInterface
    fun setAid(id: Int) {
        view.lib?.setPropertyString("aid", if (id <= 0) "no" else id.toString())
    }

    @JavascriptInterface
    fun setSid(id: Int) {
        view.lib?.setPropertyString("sid", if (id <= 0) "no" else id.toString())
    }

    /**
     * 恢复「按容器 default 自动选字幕」。`sid` 是黏性 option：上一部显式选过的轨道号
     * （或 `no`）会被下一部文件原样套用，换片不重置的话，字幕语言偏好和自动挂载都
     * 会被上一部的选择顶掉——连播时表现为「这一集没有字幕」。
     */
    @JavascriptInterface
    fun setSidAuto() {
        view.lib?.setPropertyString("sid", "auto")
    }

    @JavascriptInterface
    fun addSub(path: String, select: Boolean): Boolean {
        val lib = view.lib ?: return false
        val args = if (select) arrayOf("sub-add", path, "select") else arrayOf("sub-add", path, "auto")
        lib.command(args)
        return true
    }

    @JavascriptInterface
    fun addAudio(path: String, select: Boolean): Boolean {
        val lib = view.lib ?: return false
        val args = if (select) arrayOf("audio-add", path, "select") else arrayOf("audio-add", path, "auto")
        lib.command(args)
        return true
    }

    /** Seconds; positive delays the subtitles. */
    @JavascriptInterface
    fun setSubDelay(seconds: Double) {
        if (!seconds.isFinite()) return
        view.lib?.setPropertyDouble("sub-delay", seconds)
    }

    @JavascriptInterface
    fun setSubScale(scale: Double) {
        if (!scale.isFinite() || scale <= 0.0) return
        view.lib?.setPropertyDouble("sub-scale", scale)
    }

    @JavascriptInterface
    fun setSubVisible(on: Boolean) {
        view.lib?.setPropertyString("sub-visibility", if (on) "yes" else "no")
    }

    /**
     * 字幕文字颜色 `#RRGGBB`。只接受 6 位十六进制：mpv 的颜色解析器对非法值会静默
     * 落回默认色，前端因此看不出自己的 bug，所以这里先拒绝掉。
     */
    @JavascriptInterface
    fun setSubColor(color: String) {
        if (!HEX_COLOR.matches(color)) return
        view.lib?.setPropertyString("sub-color", color.uppercase())
    }

    /** 描边宽度，单位和 `sub-font-size` 相同（mpv 默认 3.0）；0 = 不描边。 */
    @JavascriptInterface
    fun setSubBorder(size: Double) {
        if (!size.isFinite()) return
        view.lib?.setPropertyDouble("sub-border-size", size.coerceIn(0.0, 10.0))
    }

    /**
     * 字幕样式的真实生效值，供 CDP 断言「设置有没有下发」。
     * 单独一个方法而不是塞进 [debug]：debug 的字段被真机探针按 `key=value` 解析，
     * 往里加段会破坏既有输出。
     */
    @JavascriptInterface
    fun subStyle(): String {
        val lib = view.lib ?: return "no-mpv"
        fun read(key: String): String = runCatching { lib.getPropertyString(key) ?: "-" }.getOrDefault("-")
        return "sub-delay=" + read("sub-delay") +
            " sub-scale=" + read("sub-scale") +
            " sub-pos=" + read("sub-pos") +
            " sub-visibility=" + read("sub-visibility") +
            " sub-color=" + read("sub-color") +
            " sub-border-size=" + read("sub-border-size")
    }

    /**
     * 字幕纵向位置，百分比基准是**窗口高度**（mpv 的 sub-pos 语义），不是视频画面高度。
     * 竖屏 letterbox 时画面底边只到窗口的六成左右，前端必须按实际画面矩形算出字幕底边
     * 对应的窗口百分比再传进来，不能直接拿 100 当「画面底边」。
     */
    @JavascriptInterface
    fun setSubPos(percent: Double) {
        if (!percent.isFinite()) return
        view.lib?.setPropertyDouble("sub-pos", percent.coerceIn(0.0, 100.0))
    }

    /**
     * 软旋转视频画面。Android 16/17 在 sw>=600dp 的屏幕上会直接丢弃
     * setRequestedOrientation（平板无法再改设备方向），所以「横屏观看」只能由
     * 播放器自己把画面转 90°，窗口保持竖持。旋转后宽高互换，必须反向缩放才能
     * 铺满；否则会按原始宽高比被裁掉一大块。
     */
    @JavascriptInterface
    fun setVideoRotation(degrees: Int) {
        view.post {
            // 交给 mpv 自己转，而不是对 TextureView 套 Matrix：
            // 用 Matrix 转出来的是「已经把画面 contain 进竖窗口的位图」再旋转，
            // 旋转后比例仍是竖长条，还得反算缩放，很容易算歪（实测缩成方块）。
            // video-rotate 让 mpv 先转画面再按新宽高做 contain，天然铺满宽度。
            val normalized = ((degrees % 360) + 360) % 360
            view.lib?.setPropertyInt("video-rotate", normalized)
            view.setTransform(null)
        }
    }

    @JavascriptInterface
    fun stop() {
        view.lib?.command(arrayOf("stop"))
    }

    /**
     * 画面宽度。`width` 要等 VO 配置完才有值：7.5 GB 的 4K 片首帧解码慢，这段时间里它
     * 一直是 0，而前端的「进入播放页」判据要求 videoWidth 非零 —— 结果就是声音已经在放、
     * 画面还挂着「正在缓冲视频…」。按 `width → video-params/w → dwidth` 依次回退，
     * 后两个在解码器初始化后就有值，比 VO 早得多。
     */
    @JavascriptInterface
    fun videoWidth(): Int = firstPositive("width", "video-params/w", "dwidth")

    @JavascriptInterface
    fun videoHeight(): Int = firstPositive("height", "video-params/h", "dheight")

    private fun firstPositive(vararg keys: String): Int {
      val lib = view.lib ?: return 0
      for (key in keys) {
        val value = runCatching { lib.getPropertyInt(key) }.getOrNull() ?: 0
        if (value > 0) return value
      }
      return 0
    }

    @JavascriptInterface
    fun hwdec(): String = view.lib?.getPropertyString("hwdec-current") ?: ""

    @JavascriptInterface
    fun mediaTitle(): String = view.lib?.getPropertyString("media-title") ?: ""

    /** Picture-path diagnostic: is the video output configured against our surface? */
    @JavascriptInterface
    fun debug(): String {
        val lib = view.lib ?: return "no-mpv"
        val vo = lib.getPropertyString("vo") ?: "-"
        val configured = lib.getPropertyString("vo-configured") ?: "-"
        val size = lib.getPropertyString("android-surface-size") ?: "-"
        val hw = lib.getPropertyString("hwdec-current") ?: "-"
        val dropped = lib.getPropertyInt("vo-drop-frame-count") ?: -1
        return "vo=" + vo + " configured=" + configured + " size=" + size +
            " hwdec=" + hw + " dropped=" + dropped +
            " surfaceCreates=" + view.surfaceCreates + " attaches=" + view.attaches +
            " attachValid=" + view.lastAttachValid
    }

    companion object {
        private val HEX_COLOR = Regex("^#[0-9a-fA-F]{6}$")
    }
}
