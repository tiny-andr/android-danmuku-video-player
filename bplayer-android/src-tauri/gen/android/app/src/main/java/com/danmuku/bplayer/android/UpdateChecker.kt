package com.danmuku.bplayer.android

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.content.FileProvider
import okhttp3.Call
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.io.Closeable
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 应用内自动升级（Android）：GitHub Release 发现 → 镜像回退下载 → 官方 digest 校验 → 系统安装器。
 *
 * 信任边界：
 * - 版本信息只来自 `api.github.com` 的 `/releases/latest`（TLS），且只认 draft=false / prerelease=false。
 * - 完整性只认 Release API 里 asset 的 `digest`（`sha256:<64 hex>`）；镜像自报的校验值一律不采信，
 *   digest 缺失时拒绝自动下载安装。
 * - 安装包下载走原生 OkHttp（WebView fetch 受 CORS 限制不可用），先写 `.part`，sha256 与大小都吻合后
 *   才 rename 成最终文件，再从 cache/updates 经 FileProvider 交给系统安装器。
 *
 * 线程模型：JS 桥方法在 WebView 主线程被调用，真正的网络/哈希工作全部丢到单线程 executor，
 * 避免 NetworkOnMainThreadException；进度由 JS 轮询 `state()`（读写 @Volatile 快照，不阻塞）。
 */
@androidx.annotation.Keep
internal class UpdateChecker(
  context: Context,
  private val activity: Activity,
  private val webView: WebView
) : Closeable {
  private val context = context.applicationContext
  private val currentVersion = runCatching { BuildConfig.VERSION_NAME }.getOrNull()?.trim()
    ?.takeIf { it.isNotEmpty() }
    ?: runCatching {
      context.packageManager.getPackageInfo(context.packageName, 0).versionName
    }.getOrNull()?.trim()?.takeIf { it.isNotEmpty() } ?: "0"

  /** 镜像顺序固定，不随机：直连 → 4 个 GitHub 加速前缀代理。 */
  private data class Mirror(val label: String, val prefix: String) {
    fun url(original: String): String = prefix + original
  }

  private data class Release(
    val tag: String,
    val version: String,
    val assetName: String,
    val assetUrl: String,
    val size: Long,
    /** `releases.latest` 的 `published_at` 原文（ISO 8601），仅用于弹窗展示。 */
    val publishedAt: String,
    /** `releases.latest` 的 `body` 原文；按纯文本展示，不解析 markdown。 */
    val notes: String,
    /** 归一化后的 64 位小写 hex；为空表示官方未提供 digest，禁止自动安装。 */
    val digest: String
  )

  private data class Snapshot(
    val phase: String = PHASE_IDLE,
    val currentVersion: String = "",
    val latestTag: String = "",
    val latestVersion: String = "",
    val publishedAt: String = "",
    val notes: String = "",
    val assetName: String = "",
    val totalBytes: Long = 0,
    val downloadedBytes: Long = 0,
    val mirror: String = "",
    val error: String = "",
    val message: String = "",
    val digestPresent: Boolean = false,
    val canInstall: Boolean = false,
    val file: String = ""
  )

  private data class FetchResult(val written: Long, val sha256: String)

  private class UpdateFailure(message: String) : Exception(message)
  private class UpdateCancelled : Exception("已取消")

  private val lock = Any()
  @Volatile private var snapshot = Snapshot(currentVersion = currentVersion)
  @Volatile private var currentRelease: Release? = null
  @Volatile private var activeCall: Call? = null
  @Volatile private var closed = false
  private val cancelled = AtomicBoolean(false)
  private var chainBusy = false

  private val executor = ThreadPoolExecutor(1, 1, 30, TimeUnit.SECONDS, LinkedBlockingQueue(8),
    { task -> Thread(task, "update-check").apply { isDaemon = true } })

  // 下载客户端：总时长不设限（324 MB 的包要下载几分钟），但 30 秒没有任何数据就判定镜像卡死。
  private val downloadClient = OkHttpClient.Builder()
    .connectTimeout(CONNECT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
    .readTimeout(IDLE_TIMEOUT_MS, TimeUnit.MILLISECONDS)
    .writeTimeout(IDLE_TIMEOUT_MS, TimeUnit.MILLISECONDS)
    .callTimeout(0, TimeUnit.MILLISECONDS)
    .retryOnConnectionFailure(false)
    .build()
  // 探测客户端：6 秒内没有首字节就换镜像。
  private val probeClient = downloadClient.newBuilder().callTimeout(PROBE_TIMEOUT_MS, TimeUnit.MILLISECONDS).build()
  // Release API 客户端：GitHub 官方接口，超时收紧。
  private val apiClient = downloadClient.newBuilder()
    .connectTimeout(API_TIMEOUT_MS, TimeUnit.MILLISECONDS)
    .readTimeout(API_TIMEOUT_MS, TimeUnit.MILLISECONDS)
    .callTimeout(API_TIMEOUT_MS, TimeUnit.MILLISECONDS)
    .build()

  init {
    cleanStaleParts()
  }

  // ---------------------------------------------------------------- JS 桥

  /**
   * JS 入口：request(id, command, argsJson)，命令：
   * - check              检查最新 Release（异步，完成后 reply）
   * - download           按镜像顺序下载当前发现的新版本（异步）
   * - cancel             取消正在进行的检查/下载，清理 .part，状态回到可重试
   * - install            用 FileProvider 调起系统安装器（同步，主线程）
   * - download_for_test  仅 debug 构建、仅用于验证下载链路；可指定 url/digest/maxBytes/mirrorLimit
   * - state              返回当前状态（等价于 state()）
   */
  @JavascriptInterface
  fun request(id: String, command: String, argsJson: String) {
    if (closed || id.length > 256) return
    webView.post {
      if (closed || !trustedPage()) return@post
      when (command) {
        "check" -> submit(id) { check() }
        "download" -> submit(id) { download() }
        "download_for_test" -> submit(id) {
          if (!BuildConfig.DEBUG) throw UpdateFailure("下载测试入口只在 debug 构建可用")
          downloadForTest(JSONObject(argsJson))
        }
        "cancel" -> {
          cancel()
          reply(id, true, JSONObject(stateJson()))
        }
        "install" -> runCatching { install() }.fold(
          { reply(id, true, JSONObject(stateJson())) },
          { reply(id, false, readable(it)) }
        )
        "state" -> reply(id, true, JSONObject(stateJson()))
        else -> reply(id, false, "不支持的更新命令")
      }
    }
  }

  /** 供 JS 轮询的只读状态快照（不阻塞、不联网）。 */
  @JavascriptInterface
  fun state(): String = runCatching { stateJson() }.getOrDefault("{}")

  /** 当前版本号（例如 0.1.0），供前端显示。 */
  @JavascriptInterface
  fun versionName(): String = currentVersion

  private fun submit(id: String, block: () -> Snapshot) {
    if (!beginChain()) {
      reply(id, false, "更新任务正在进行，请稍候")
      return
    }
    cancelled.set(false)
    try {
      executor.execute {
        try {
          block()
          reply(id, true, JSONObject(stateJson()))
        } catch (cancelledError: UpdateCancelled) {
          resetAfterCancel()
          reply(id, true, JSONObject(stateJson()))
        } catch (error: Throwable) {
          fail(readable(error))
          reply(id, false, readable(error))
        } finally {
          endChain()
        }
      }
    } catch (_: RejectedExecutionException) {
      endChain()
      reply(id, false, "更新请求过多，请稍后重试")
    }
  }

  // ---------------------------------------------------------------- 检查更新

  private fun check(): Snapshot {
    markChecking()
    val release = try {
      fetchRelease()
    } catch (cancelledError: UpdateCancelled) {
      throw cancelledError
    } catch (error: Throwable) {
      if (cancelled.get()) throw UpdateCancelled()
      return fail("检查更新失败：" + readable(error))
    }
    throwIfCancelled()
    currentRelease = release
    val newest = compareVersions(release.version, currentVersion)
    return update {
      copy(
        phase = if (newest > 0) PHASE_AVAILABLE else PHASE_UP_TO_DATE,
        latestTag = release.tag,
        latestVersion = release.version,
        publishedAt = release.publishedAt,
        notes = release.notes,
        assetName = release.assetName,
        totalBytes = release.size,
        downloadedBytes = 0,
        mirror = "",
        error = "",
        message = when {
          newest > 0 && release.digest.isEmpty() -> "缺少官方校验值"
          newest < 0 -> "当前版本高于最新发布"
          else -> ""
        },
        digestPresent = release.digest.isNotEmpty(),
        canInstall = false,
        file = ""
      )
    }
  }

  private fun fetchRelease(): Release {
    val request = Request.Builder().url(RELEASES_URL)
      .header("User-Agent", USER_AGENT)
      .header("Accept", "application/vnd.github+json")
      .header("X-GitHub-Api-Version", "2022-11-28")
      .build()
    val call = apiClient.newCall(request)
    activeCall = call
    val text = try {
      call.execute().use { response ->
        if (response.code == 404) throw UpdateFailure("仓库还没有发布任何 Release")
        if (!response.isSuccessful) throw UpdateFailure("GitHub 返回 HTTP ${response.code}")
        val body = response.body ?: throw UpdateFailure("GitHub 返回空响应")
        val bytes = body.bytes()
        if (bytes.size > 4 * 1024 * 1024) throw UpdateFailure("Release 信息响应过大")
        String(bytes, Charsets.UTF_8)
      }
    } finally {
      if (activeCall === call) activeCall = null
    }
    val json = JSONObject(text)
    if (json.optBoolean("draft", false) || json.optBoolean("prerelease", false)) {
      throw UpdateFailure("最新条目不是正式发布版本（draft / prerelease）")
    }
    val tag = json.optString("tag_name").trim()
    if (tag.isEmpty()) throw UpdateFailure("Release 缺少 tag_name")
    val version = versionOf(tag) ?: throw UpdateFailure("无法识别发布版本号：$tag")
    val assets = json.optJSONArray("assets") ?: JSONArray()
    val apks = (0 until assets.length()).mapNotNull { assets.optJSONObject(it) }
      .filter { it.optString("name").endsWith(".apk", ignoreCase = true) }
      .filter { !it.optString("name").contains("unsigned", ignoreCase = true) }
    // Debug and release builds ship side by side with independent signatures, so each one
    // must upgrade along its own track: a debug install that grabs the release APK cannot
    // install it at all. Match the asset name against this build type first.
    val wantsDebug = BuildConfig.DEBUG
    val asset = apks.firstOrNull {
      it.optString("name").contains("debug", ignoreCase = true) == wantsDebug
    } ?: apks.firstOrNull()
      ?: throw UpdateFailure("该版本没有 APK 安装包")
    val assetName = sanitizeName(asset.optString("name"))
    if (assetName.isEmpty()) throw UpdateFailure("Release 的 APK 文件名不可用")
    val url = validateAssetUrl(asset.optString("browser_download_url"))
    val notes = json.optString("body").let { if (it.length > RELEASE_NOTES_LIMIT) it.take(RELEASE_NOTES_LIMIT) + "…" else it }
    return Release(tag, version, assetName, url, asset.optLong("size", 0L),
      json.optString("published_at").trim(), notes, normalizeDigest(asset.optString("digest")))
  }

  /** 只接受本仓库 GitHub Release 的 HTTPS 下载地址；镜像前缀基于它拼接。 */
  private fun validateAssetUrl(raw: String): String {
    val url = raw.trim().toHttpUrlOrNull() ?: throw UpdateFailure("Release 里的下载地址无效")
    if (url.scheme != "https" || url.host != "github.com") throw UpdateFailure("Release 里的下载地址不是 GitHub HTTPS 地址")
    if (!url.encodedPath.startsWith("/tiny-andr/android-danmuku-video-player/releases/download/")) {
      throw UpdateFailure("Release 里的下载地址不属于本仓库")
    }
    return url.toString()
  }

  // ---------------------------------------------------------------- 下载

  private fun download(): Snapshot {
    var release = currentRelease
    if (release != null && snapshot.phase == PHASE_DOWNLOADED) {
      val ready = File(updatesDirectory() ?: return fail("更新缓存目录不可用"), release.assetName)
      if (ready.isFile && ready.length() > 0L) {
        return update { copy(phase = PHASE_DOWNLOADED, canInstall = true, file = ready.name, message = "安装包已下载，可直接安装") }
      }
    }
    if (release == null || snapshot.phase in setOf(PHASE_IDLE, PHASE_UP_TO_DATE, PHASE_ERROR)) {
      check()
      release = currentRelease
      if (snapshot.phase != PHASE_AVAILABLE) return snapshot
    }
    return runChain(release!!, mirrorLimit = MIRRORS.size, maxBytes = 0L,
      message = "正在从 GitHub Release 下载")
  }

  /**
   * 验证专用入口（debug 构建）：跳过版本比较，直接按给定的 tag/url/digest 走镜像下载链。
   * - `maxBytes > 0`：只读前 N 字节后主动中断，用来在几秒内验证「sha256 不符 → 换下一个镜像」。
   * - `mirrorLimit`：最多尝试前几个镜像，避免打满全部代理。
   * 生产路径（download）不会经过这里；参数由受信任页面（tauri.localhost）传入。
   */
  private fun downloadForTest(args: JSONObject): Snapshot {
    val tag = args.optString("tag").trim()
    val url = validateAssetUrl(args.optString("url"))
    if (tag.isEmpty()) throw UpdateFailure("测试入口缺少 tag")
    val release = Release(
      tag = tag,
      version = args.optString("version", "9.9.9"),
      assetName = sanitizeName(args.optString("assetName", "update-test.apk")).ifEmpty { "update-test.apk" },
      assetUrl = url,
      size = args.optLong("expectedBytes", 0L),
      publishedAt = args.optString("publishedAt", ""),
      notes = args.optString("notes", ""),
      digest = normalizeDigest(args.optString("digest"))
    )
    currentRelease = release
    val preview = update {
      copy(
        phase = PHASE_AVAILABLE,
        latestTag = release.tag,
        latestVersion = release.version,
        publishedAt = release.publishedAt,
        notes = release.notes,
        assetName = release.assetName,
        totalBytes = release.size,
        downloadedBytes = 0,
        mirror = "",
        error = "",
        message = "下载测试（仅用于验证下载链路）",
        digestPresent = release.digest.isNotEmpty(),
        canInstall = false,
        file = ""
      )
    }
    // dryRun：只把状态机推到「发现新版本」，用于验证弹窗/设置行 UI，不发起任何下载。
    if (args.optBoolean("dryRun", false)) return preview
    return runChain(
      release,
      mirrorLimit = args.optInt("mirrorLimit", MIRRORS.size).coerceIn(1, MIRRORS.size),
      maxBytes = args.optLong("maxBytes", 0L).coerceAtLeast(0L),
      message = "下载测试（仅用于验证下载链路）"
    )
  }

  private fun runChain(release: Release, mirrorLimit: Int, maxBytes: Long, message: String): Snapshot {
    if (release.digest.isEmpty()) {
      return fail("该版本没有官方 sha256 校验值，已拒绝自动下载安装")
    }
    val directory = updatesDirectory() ?: return fail("无法创建更新缓存目录")
    directory.listFiles()?.filter { it.name.endsWith(".part") }?.forEach { it.delete() }
    directory.listFiles()?.filter { it.name.endsWith(".apk") && it.name != release.assetName }?.forEach { it.delete() }
    val part = File(directory, release.assetName + ".part")
    val target = File(directory, release.assetName)
    if (release.size > 0) {
      val usable = directory.usableSpace
      if (usable in 1 until release.size + 16L * 1024 * 1024) {
        return fail("缓存空间不足：需要 ${formatBytes(release.size)}，当前可用 ${formatBytes(usable)}")
      }
    }
    var lastError = ""
    try {
      for ((index, mirror) in MIRRORS.withIndex()) {
        if (index >= mirrorLimit) break
        throwIfCancelled()
        update {
          copy(
            phase = PHASE_DOWNLOADING,
            mirror = mirror.label,
            downloadedBytes = 0,
            totalBytes = release.size,
            error = "",
            message = message,
            canInstall = false,
            file = ""
          )
        }
        try {
          probe(mirror, release.assetUrl)
          throwIfCancelled()
          val result = fetch(mirror, release.assetUrl, part, release.size, maxBytes)
          throwIfCancelled()
          if (release.size > 0 && result.written != release.size) {
            lastError = "${mirror.label}：文件大小不符（${formatBytes(result.written)} / ${formatBytes(release.size)}）"
            continue
          }
          if (!result.sha256.equals(release.digest, ignoreCase = true)) {
            lastError = "${mirror.label}：sha256 校验不符"
            continue
          }
          if (target.exists() && !target.delete()) throw UpdateFailure("旧的安装包无法删除")
          if (!part.renameTo(target)) throw UpdateFailure("安装包保存失败（rename）")
          return update {
            copy(
              phase = PHASE_DOWNLOADED,
              downloadedBytes = target.length(),
              totalBytes = target.length(),
              mirror = mirror.label,
              error = "",
              message = "下载完成，sha256 与 Release 一致",
              canInstall = true,
              file = target.name
            )
          }
        } catch (cancelledError: UpdateCancelled) {
          throw cancelledError
        } catch (error: Throwable) {
          if (cancelled.get()) throw UpdateCancelled()
          lastError = "${mirror.label}：${readable(error)}"
        }
      }
      return fail("所有下载镜像均失败：$lastError")
    } finally {
      // 失败/取消一律清掉 .part；成功时它已被 rename 成最终文件，不存在也无需处理。
      runCatching { if (part.exists()) part.delete() }
    }
  }

  /** Range bytes=0-0 探测；6 秒没有首字节就换镜像。只读 1 字节即关闭。 */
  private fun probe(mirror: Mirror, url: String) {
    val request = Request.Builder().url(mirror.url(url))
      .header("User-Agent", USER_AGENT)
      .header("Range", "bytes=0-0")
      .build()
    val call = probeClient.newCall(request)
    activeCall = call
    try {
      call.execute().use { response ->
        if (!response.isSuccessful) throw UpdateFailure("探测失败：HTTP ${response.code}")
        val body = response.body ?: throw UpdateFailure("探测响应为空")
        body.byteStream().use { input -> input.read() }
      }
    } finally {
      if (activeCall === call) activeCall = null
    }
  }

  /** 流式下载写入 .part，边写边算 sha256；maxBytes>0 时只读前 N 字节（测试截断用）。 */
  private fun fetch(mirror: Mirror, url: String, part: File, expectedTotal: Long, maxBytes: Long): FetchResult {
    val request = Request.Builder().url(mirror.url(url))
      .header("User-Agent", USER_AGENT)
      .header("Accept-Encoding", "identity")
      .build()
    val call = downloadClient.newCall(request)
    activeCall = call
    var written = 0L
    var lastProgress = 0L
    var reportedTotal = expectedTotal
    val digest = MessageDigest.getInstance("SHA-256")
    try {
      call.execute().use { response ->
        if (!response.isSuccessful) throw UpdateFailure("HTTP ${response.code}")
        val body = response.body ?: throw UpdateFailure("响应为空")
        val length = body.contentLength()
        if (reportedTotal <= 0 && length > 0) reportedTotal = length
        if (reportedTotal > 0) update { copy(totalBytes = reportedTotal) }
        body.byteStream().use { input ->
          FileOutputStream(part).use { output ->
            val buffer = ByteArray(256 * 1024)
            while (true) {
              throwIfCancelled()
              val read = try {
                input.read(buffer)
              } catch (error: IOException) {
                if (cancelled.get()) throw UpdateCancelled()
                if (error is java.net.SocketTimeoutException) throw UpdateFailure("下载超时（30 秒没有数据）")
                throw error
              }
              if (read < 0) break
              var count = read
              if (maxBytes > 0 && written + count > maxBytes) count = (maxBytes - written).toInt()
              output.write(buffer, 0, count)
              digest.update(buffer, 0, count)
              written += count
              if (maxBytes > 0 && written >= maxBytes) break // 测试模式：故意截断，交给 sha256 判失败
              val now = System.currentTimeMillis()
              if (now - lastProgress >= PROGRESS_INTERVAL_MS) {
                lastProgress = now
                update { copy(downloadedBytes = written) }
              }
            }
            output.flush()
          }
        }
      }
    } finally {
      if (activeCall === call) activeCall = null
    }
    update { copy(downloadedBytes = written) }
    return FetchResult(written, hex(digest.digest()))
  }

  // ---------------------------------------------------------------- 安装

  private fun install(): Snapshot {
    val release = currentRelease ?: throw UpdateFailure("请先检查更新")
    val file = File(updatesDirectory() ?: throw UpdateFailure("更新缓存目录不可用"), release.assetName)
    if (!file.isFile || file.length() <= 0L) throw UpdateFailure("安装包还没有下载完成，请先下载")
    if (release.size > 0 && file.length() != release.size) {
      throw UpdateFailure("安装包大小与 Release 不一致，请删除后重新下载")
    }
    // Android 8+：用户没授权「安装未知应用」时 ACTION_VIEW 会静默失败，必须先检测并引导。
    if (!activity.packageManager.canRequestPackageInstalls()) {
      update { copy(message = "等待允许「安装未知应用」", canInstall = true) }
      openUnknownSourcesSettings()
      throw UpdateFailure("请先允许「安装未知应用」，已为你打开设置页；授权后返回再点一次安装")
    }
    val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
    val intent = Intent(Intent.ACTION_VIEW)
      .setDataAndType(uri, "application/vnd.android.package-archive")
      .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    try {
      activity.startActivity(intent)
    } catch (error: ActivityNotFoundException) {
      throw UpdateFailure("系统没有可用的安装器（ActivityNotFoundException）")
    }
    return update { copy(message = "已调起系统安装器", canInstall = true, error = "") }
  }

  private fun openUnknownSourcesSettings() {
    val packageUri = Uri.parse("package:${activity.packageName}")
    try {
      activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, packageUri)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    } catch (_: Exception) {
      runCatching {
        activity.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, packageUri)
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      }
    }
  }

  // ---------------------------------------------------------------- 状态

  private fun markChecking(): Snapshot = update {
    copy(
      phase = PHASE_CHECKING,
      latestTag = "",
      latestVersion = "",
      publishedAt = "",
      notes = "",
      assetName = "",
      totalBytes = 0,
      downloadedBytes = 0,
      mirror = "",
      error = "",
      message = "",
      digestPresent = false,
      canInstall = false,
      file = ""
    )
  }

  private fun fail(message: String): Snapshot = update {
    copy(phase = PHASE_ERROR, error = message, message = "", mirror = "", downloadedBytes = 0)
  }

  private fun cancel() {
    if (snapshot.phase != PHASE_DOWNLOADING && snapshot.phase != PHASE_CHECKING) return
    cancelled.set(true)
    activeCall?.cancel()
    update { copy(message = "已取消，可重试", error = "", mirror = "", downloadedBytes = 0) }
  }

  private fun resetAfterCancel() {
    cancelled.set(false)
    val release = currentRelease
    updatesDirectory()?.listFiles()?.filter { it.name.endsWith(".part") }?.forEach { it.delete() }
    update {
      copy(
        phase = when {
          release == null -> PHASE_IDLE
          compareVersions(release.version, currentVersion) > 0 -> PHASE_AVAILABLE
          else -> PHASE_UP_TO_DATE
        },
        downloadedBytes = 0,
        mirror = "",
        error = "",
        message = "已取消下载，可重试",
        canInstall = false,
        file = ""
      )
    }
  }

  private fun stateJson(): String = synchronized(lock) {
    val value = snapshot
    JSONObject()
      .put("phase", value.phase)
      .put("currentVersion", value.currentVersion)
      .put("latestTag", value.latestTag)
      .put("latestVersion", value.latestVersion)
      .put("publishedAt", value.publishedAt)
      .put("notes", value.notes)
      .put("assetName", value.assetName)
      .put("totalBytes", value.totalBytes)
      .put("downloadedBytes", value.downloadedBytes)
      .put("percent", if (value.totalBytes > 0) {
        (value.downloadedBytes * 100.0 / value.totalBytes).coerceIn(0.0, 100.0)
      } else 0.0)
      .put("mirror", value.mirror)
      .put("error", value.error)
      .put("message", value.message)
      .put("digestPresent", value.digestPresent)
      .put("canInstall", value.canInstall)
      .put("file", value.file)
      .toString()
  }

  private fun update(block: Snapshot.() -> Snapshot): Snapshot = synchronized(lock) {
    val next = snapshot.block()
    snapshot = next
    next
  }

  private fun beginChain(): Boolean = synchronized(lock) {
    if (chainBusy) false else {
      chainBusy = true; true
    }
  }

  private fun endChain() = synchronized(lock) { chainBusy = false }

  private fun throwIfCancelled() {
    if (cancelled.get() || closed) throw UpdateCancelled()
  }

  // ---------------------------------------------------------------- 工具

  private fun updatesDirectory(): File? {
    val directory = File(context.cacheDir, UPDATES_DIRECTORY)
    if (!directory.exists() && !directory.mkdirs()) return null
    return if (directory.isDirectory) directory else null
  }

  private fun cleanStaleParts() {
    runCatching {
      updatesDirectory()?.listFiles()?.filter { it.name.endsWith(".part") }?.forEach { it.delete() }
    }
  }

  /** 版本号归一：去掉前导 v，只接受 数字(.数字)* 形式；返回 null 表示无法识别。 */
  private fun versionOf(tag: String): String? {
    val version = tag.trim().replaceFirst(Regex("^[vV]"), "")
    return if (VERSION_PATTERN.matches(version)) version else null
  }

  private fun compareVersions(left: String, right: String): Int {
    val a = left.split('.')
    val b = right.split('.')
    for (index in 0 until maxOf(a.size, b.size)) {
      val x = a.getOrNull(index)?.toIntOrNull() ?: 0
      val y = b.getOrNull(index)?.toIntOrNull() ?: 0
      if (x != y) return x.compareTo(y)
    }
    return 0
  }

  /** `sha256:<64 hex>` → 小写 hex；格式不对或缺失返回 ""（= 不信任、拒绝自动安装）。 */
  private fun normalizeDigest(raw: String): String {
    val value = raw.trim()
    val prefix = "sha256:"
    if (!value.startsWith(prefix, ignoreCase = true)) return ""
    val hex = value.substring(prefix.length).trim()
    return if (SHA256_PATTERN.matches(hex)) hex.lowercase() else ""
  }

  private fun sanitizeName(name: String): String {
    val cleaned = name.trim().replace(Regex("[^A-Za-z0-9._-]"), "_")
    return if (cleaned.length in 1..128 && cleaned.endsWith(".apk", ignoreCase = true)) cleaned else ""
  }

  private fun hex(bytes: ByteArray): String {
    val builder = StringBuilder(bytes.size * 2)
    for (byte in bytes) {
      val value = byte.toInt() and 0xFF
      builder.append(HEX[value ushr 4]).append(HEX[value and 0x0F])
    }
    return builder.toString()
  }

  private fun formatBytes(bytes: Long): String {
    if (bytes < 1024) return "$bytes B"
    val units = arrayOf("KB", "MB", "GB")
    var value = bytes.toDouble() / 1024.0
    var unit = 0
    while (value >= 1024.0 && unit < units.size - 1) {
      value /= 1024.0
      unit++
    }
    return String.format(java.util.Locale.US, "%.1f %s", value, units[unit])
  }

  private fun readable(error: Throwable): String {
    if (error is UpdateFailure) return error.message ?: "更新失败"
    var cause: Throwable? = error
    repeat(8) {
      val current = cause ?: return@repeat
      when (current) {
        is java.net.UnknownHostException -> return "无法解析更新服务器地址，请检查网络"
        is java.net.SocketTimeoutException -> return "网络超时，请检查网络后重试"
        is java.net.ConnectException -> return "无法连接更新服务器，请检查网络"
        is java.net.SocketException -> return "网络连接中断，请重试"
        is javax.net.ssl.SSLException -> return "HTTPS 安全连接失败，请检查系统时间与网络环境"
        is IOException -> if ((current.message ?: "").contains("timeout", ignoreCase = true)) return "网络超时，请检查网络后重试"
      }
      cause = current.cause
    }
    return error.message?.takeIf { it.isNotBlank() } ?: "更新失败（${error.javaClass.simpleName}）"
  }

  private fun trustedPage(): Boolean {
    val uri = Uri.parse(webView.url ?: return false)
    return uri.scheme == "http" && uri.host == "tauri.localhost" && (uri.port == -1 || uri.port == 80)
  }

  private fun reply(id: String, ok: Boolean, value: Any?) {
    if (closed) return
    val envelope = JSONObject().put("ok", ok)
      .put(if (ok) "result" else "error", value ?: JSONObject.NULL)
    // 注意：这里传的是 JSON 对象字面量（envelope.toString()），不是 JSON 字符串；
    // 如果对 toString() 再 JSONObject.quote，JS 侧只会拿到字符串，envelope.ok 永远是 undefined。
    val payload = envelope.toString().replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    val requestId = JSONObject.quote(id).replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    webView.post {
      if (!closed && trustedPage()) {
        webView.evaluateJavascript("window.__aUpdateReply && window.__aUpdateReply($requestId,$payload)", null)
      }
    }
  }

  override fun close() {
    closed = true
    cancelled.set(true)
    activeCall?.cancel()
    executor.shutdownNow()
  }

  private companion object {
    const val RELEASES_URL = "https://api.github.com/repos/tiny-andr/android-danmuku-video-player/releases/latest"
    const val USER_AGENT = "Bplayer-Android-Updater"
    const val UPDATES_DIRECTORY = "updates"
    const val CONNECT_TIMEOUT_MS = 10_000L
    /** 下载过程中 30 秒没有数据 → 换镜像。 */
    const val IDLE_TIMEOUT_MS = 30_000L
    /** 每个镜像的 Range 探测：6 秒内没有首字节 → 换镜像。 */
    const val PROBE_TIMEOUT_MS = 6_000L
    const val API_TIMEOUT_MS = 20_000L
    const val PROGRESS_INTERVAL_MS = 200L
    /** Release notes 正文上限：弹窗按纯文本展示，过长正文只截断不阻塞桥接。 */
    const val RELEASE_NOTES_LIMIT = 6000

    const val PHASE_IDLE = "idle"
    const val PHASE_CHECKING = "checking"
    const val PHASE_UP_TO_DATE = "up_to_date"
    const val PHASE_AVAILABLE = "available"
    const val PHASE_DOWNLOADING = "downloading"
    const val PHASE_DOWNLOADED = "downloaded"
    const val PHASE_ERROR = "error"

    val SHA256_PATTERN = Regex("^[0-9a-fA-F]{64}$")
    val VERSION_PATTERN = Regex("^\\d+(\\.\\d+)*$")
    val HEX = "0123456789abcdef".toCharArray()

    /** 固定顺序，不随机：直连 → ghfast.top → gh-proxy.com → ghproxy.net → ghproxy.site。 */
    val MIRRORS = listOf(
      Mirror("直连", ""),
      Mirror("ghfast.top", "https://ghfast.top/"),
      Mirror("gh-proxy.com", "https://gh-proxy.com/"),
      Mirror("ghproxy.net", "https://ghproxy.net/"),
      Mirror("ghproxy.site", "https://ghproxy.site/")
    )
  }
}
