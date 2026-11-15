# AGENTS.md

本仓库是基于 Tauri 2 + WebView 的 Android 视频弹幕播放器。目标是播放本地与网络存储视频、自动加载同名弹幕与外挂字幕，并按手机习惯组织界面。

## 改动范围

- 所有改动只允许落在当前项目目录内。
- 构建产物、依赖与调试文件均保留在当前项目目录内。

## 目录

```
bplayer-android/
  ui/                     前端与移动端交互
    index.html            主界面与播放逻辑
    android-shell.js      手机壳：启动页、播放页顶栏、信息卡、方向/沉浸式桥
    android-storage.js    文件浏览器、网络连接表单、存储命令路由
    vendor/               Artplayer、弹幕插件等
  src-tauri/
    src/lib.rs            Rust 命令（扫描目录、配对弹幕、读字幕、探测 MKV 音轨等）
    tauri.conf.json       frontendDist=../ui，assetProtocol 放行 /sdcard /storage
    tauri                 无扩展名 Node shim（Gradle 的 rust 任务需要）
    gen/android/          Tauri 生成的 Android 工程（MainActivity.kt、Manifest 在此）
  scripts/                构建辅助脚本
  package.json            `npm run android:build`
probe/
  cdp-eval.js             CDP 求值小工具（调试 WebView 用）
research/
  android-port-research.md  移植调研、设备能力、阶段记录
```

## 架构要点

- **前端**：`index.html` 承载播放核心，`android-shell.js` 在它之前加载，负责手机布局与交互；不要重写播放器核心，优先复用现有 DOM/事件（如 `#btnOpenVideo`、`#btnAudioEntry`、`#btnBlockEntry`、`#settingsMask`、`#infobar` 的数值节点）。
- **选文件**：`window.__aInvoke` 拦截 `pick_video` / `pick_folder`，交由 `android-storage.js` 打开触摸文件浏览器。本地真实路径通过 asset 协议播放；`/@network/<id>/...` 虚拟路径通过原生网络桥与本机 Range 媒体代理播放。
- **Rust 命令**：`fs_stat`、`pair_danmaku`、`scan_folder`、`read_text`、`read_bytes`、`scan_subtitles`、`probe_mkv_tracks`、`sidecar_cache_files`、`list_dir` 已实现；`pick_*`、`reveal_path`、开机启动、ffmpeg 转码、PGS 相关仍是占位。
- **原生桥**：`MainActivity.kt` 通过 `addJavascriptInterface(..., "AndroidUI")` 暴露三个能力：
  - `setImmersive(bool)`：播放页隐藏/恢复系统栏；
  - `setLandscape(bool)`：仅播放页锁横屏，退出回 `FULL_SENSOR`；
  - `exitApp()`：返回键链走到最后才退出。
  返回键由 `OnBackPressedDispatcher` 转给 `window.__aAndroidBack()`，优先级：设置/信息卡/浮窗 → 文件浏览器 → 播放列表 → 播放页 → 退出应用。
- **网络存储**：`AndroidNetwork` 提供异步请求和流式媒体 URL；连接凭据使用 Android Keystore 加密，网页只接收公开字段。SMB 仅启用 2.1/3.x，WebDAV 仅 HTTPS，SFTP 必须核对主机指纹；禁止跳过证书或指纹校验。详细结构见 `research/network-storage.md`。
- **方向策略**：Manifest 为 `fullSensor`。**首页绝不强制横屏**（用户明确要求）；进入播放才锁横屏，退出立即恢复跟随系统。竖屏首页用 `@media (orientation:portrait)` 改成上下布局。
- **安全区**：所有固定层用 `env(safe-area-inset-*)`，刘海/状态栏出现或沉浸式切换时自适应。
- **移动端信息入口**：桌面底部信息条在手机上收进播放页顶栏的 `i` 信息卡（数据仍读 `#infoDuration` 等节点），卡内同时提供音轨、字幕、弹幕屏蔽、设置入口。音轨/字幕按钮沿用原逻辑的可用性：没有可选轨道时置灰。

## 构建与安装

环境（本机已验证）：Windows、JDK 21、Android SDK 37、NDK `28.2.13676358`、Node 24、Rust arm64 target。`src-tauri/tauri` shim 必须存在，否则 Gradle 调用 Tauri CLI 会失败。

```bash
cd bplayer-android
npm install                      # 首次
npm run android:build            # 只出 arm64 debug APK
adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
adb shell am force-stop com.danmuku.bplayer.android
adb shell monkey -p com.danmuku.bplayer.android -c android.intent.category.LAUNCHER 1
```

产物：`bplayer-android/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`（构建产物与 `node_modules`、`target`、Gradle `build/` 均已 gitignore）。

## 已验证 / 已知限制

已验证：异形契约（6.11 GB MP4，1920×1080）播放；23,159 条 B 站弹幕 271–293 ms 解析；竖屏首页与横屏播放切换；沉浸式；文件夹 10 集连播；同源换集；返回键层级；最近播放去重；信息卡与设置页手机布局。

限制（P3 起）：DTS/TrueHD/AC-3 等 WebView 无法解码，ffmpeg 转码未接入；内嵌文本字幕抽取、PGS 位图字幕未实现；`自动转换音轨/字幕` 开关目前只持久化设置，不会真正转码（设置页已注明）；MKV 外挂音轨/PGS 仍为占位命令。

## 注意的坑

- `.stage` 等元素带 `animation-fill-mode: both` 的 identity `transform` 会形成 containing block，fixed 后代无法全屏；全屏规则必须落在 `.stage` 上并清 `transform/animation`。
- 原 CSS `#aFileMask{display:flex}` 会压过 `[hidden]`，需要 `#aFileMask[hidden]{display:none!important}`。
- 播放列表曾因同样的 animation transform 永远展开，必须用 `!important` 压回 `translateX`。
- 弹幕/字幕/音轨浮窗在桌面是 `position:fixed; right:16px; bottom:64px`，手机上统一改成底部面板，z-index 必须高于全屏舞台。
- WebView 中 `crossOrigin` 媒体与 asset 协议有关；Range 上限约 1 MB。
