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
    android-navigation.js Overlay stack, task invalidation and scroll anchors
    android-sidecars.js   Bounded text decoding, subtitle normalization and language preferences
    android-subtitle-view.js Atomic text-track loading, safe rendering and per-video timing
    android-audio.js      Owned native audio tasks and staged external-audio synchronization
    android-file-order.js 自然文件名、修改时间和类型排序
    android-thumbnails.js 可见项封面调度、取消与最近播放缓存读取
    android-gestures.js   播放区域亮度/媒体音量、双击跳转与触摸锁仲裁
    android-player-tools.js 续播、锁屏、适应/裁剪与原生音频会话接线
    android-resume-store.js 断点记录的本地/网络路径存储
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
- **Rust / audio commands**: Rust still provides local scanning and text reads. Android audio probe/prepare/start/cancel/cache listing now use `AndroidAudioNative` and `android-audio.js`; do not route them to the legacy Rust transcode stubs. Embedded subtitle extraction and PGS remain unimplemented.
- **原生桥**：`MainActivity.kt` 通过 `AndroidUI` 提供沉浸式、按视频尺寸选择方向、播放常亮、窗口亮度、媒体音量与退出能力。亮度只改当前窗口，退出播放恢复系统亮度；音量使用 Android 媒体音量，不用网页音量伪装。
  Native and top Back share `window.__aAndroidBack()`: touch-lock/resume decision, file-browser hierarchy, loading/pending-task cancellation, top overlay, playback origin, then app exit. Playback must restore its launch origin, not hard-code home or derive a directory from the media path.
- **Navigation**: `android-navigation.js` owns registered layers; use open/close/clear rather than independent DOM toggles. Information-card children restore their caller; direct controls return to playback. `AndroidFiles.takeSelection(path)` transfers a one-shot immutable browser snapshot; `restore(snapshot)` returns a picker promise. Episode changes retain the session origin; explicit folder lists retain their browser caller. See `research/navigation-return-rules.md`.
- **Sidecar selection**: Subtitle and danmaku pickers do not change the playback origin. Claim selection ownership only after a non-empty picker result; cancellation must preserve automatic loading. Valid manual choices invalidate older automatic results. Local and network text reads are bounded to 32 MiB. Stage a new subtitle track before replacing the current one, render cue text with textContent, and revoke tracks/Blob URLs on replacement or exit. ASS/SSA are text/time compatible only, not full styled libass rendering. Delay resets per video; style/language persist only through the explicit Save button.
- **Scope decisions**: PiP and hold-to-speed were declined. The subtitle batch adds no native media dependencies. After its commit, the user approved starting the Windows Bplayer audio-conversion port: convert only the selected unsupported audio track, keep the video unchanged and store the completed audio cache beside the video, including writable network sources. Background services remain deferred.
- **Subtitle layout**: Default to small (18 CSS px), no outline and the visible video picture's inside bottom, not the player window bottom. A below-picture option falls back inside when letterbox space is insufficient. Recompute from real video dimensions and contain/cover bounds on resize, fold, metadata, fit and control changes; persist position only through Save.
- **Audio conversion**: `AndroidAudioNative` serializes UUID session/permit/job tasks; a null jobId means session-wide cancellation, not the string `null`. Use job tombstones and source-configuration snapshots. The bound, non-exported `:audio_transcode` worker uses locked LGPL FFmpeg min plus its explicitly restored smart-exception dependency. Convert only selected audio to AAC-LC stereo 192k; final `Video (音轨N).mka` stays beside the source. Keep video audio isolated until its default track is known; stage/seek external audio before allowing sound. Never replace a source video or conflicting cache. Remote publication requires exclusive temporary creation and no-overwrite rename/MOVE; do not retry an ambiguous commit or reuse the playback connection pool. Private staging is capped at 512 MiB, cleaned on exit/replacement, and local disk preflight reserves two copies. See `research/audio-conversion.md`.
- **流式音轨（边转边播）**: 需要转换的音轨在整段落盘之前先走流式：worker 用 `STREAM` 命令把该轨单进程编成碎片化 MP4 写进 `cacheDir/stream/<jobId>.mp4`（`+frag_keyframe+empty_moov+default_base_moof`、1 秒一片、`-flush_packets 1`），主进程按 ISO-BMFF box 边界增量读、以 pull 方式交给前端 MediaSource 播放；首块约百毫秒级出声，不必等两分钟的整段转码。FFmpegKit 没有二进制 stdout（被日志接管），所以用增长文件代替管道；`SourceBuffer.timestampOffset` 已把这路流摆到视频时间轴，外挂元素的 offset 必须传 0。seek 到未缓冲位置、换轨、退出播放都要先停旧流（取消 ffmpeg + 删文件），一个 app 同时只允许一路；流式失败或 MSE 不可用时原样回落到整段转码。详见 `research/audio-streaming.md`。
- **网络存储**：`AndroidNetwork` 提供异步请求和流式媒体 URL；连接凭据使用 Android Keystore 加密，网页只接收公开字段。SMB 仅启用 2.1/3.x，WebDAV 仅 HTTPS，SFTP 必须核对主机指纹；禁止跳过证书或指纹校验。详细结构见 `research/network-storage.md`。
- **方向策略**：Manifest 为 `user`。首页遵守系统旋转设置，禁止使用 `fullSensor` 绕过旋转锁。关闭系统自动旋转时播放保持当前方向；开启时，视频宽 > 高使用横屏，宽 ≤ 高使用竖屏。顶部“横屏／竖屏”是用户主动覆盖方向的入口，随控件显隐，不修改系统开关；退出或换片清除覆盖。等待真实视频尺寸后才选默认方向，退出播放恢复系统策略。
- **播放控制栏**：弹幕插件通过 `mount()` 固定到 `.mDanControls`，不要让窄屏自动把工具栏移到画面底边。顶部不再重复放弹幕开关；横竖屏的底部开关和设置均保留，控制区使用高不透明黑色背景。
- **播放会话**：系统音频焦点由 WebView/Chromium 唯一持有，禁止另起原生 `AudioFocusRequest` 与自身抢占。`AndroidPlaybackAudio` 只管理前台会话许可、耳机断开与后台暂停；中断后不自动恢复。续播使用稳定文件路径记录，弹出继续/从头选择；触摸锁下只保留解锁入口，禁止亮度、音量和跳转手势。
- **窗口适配**：按可用窗口而非设备型号识别大屏。宽度至少 720 CSS 像素时直出音轨、字幕、设置入口；宽且高至少 540 时首页与文件浏览双栏，短横屏仍紧凑布局。快捷按钮复用原入口的事件与可用性，不能复制两套轨道状态。
- **封面预览**：`AndroidThumbnails` 只接受稳定本地/网络路径，独立精确读取连接不复用媒体池；每任务最多请求 12 MiB，单次 64 KiB，启动后约 4 秒超时失败回占位，解码隔离在不可导出的 `:thumbnails` 服务。不得以无预算媒体 URL 或全文件扫描生成预览；最近播放只读私有封面缓存，不因打开首页连接 NAS。
- **Thumbnail fast paths**: Cache-only requests use a separate bounded local worker/queue, never the remote extraction queue. Decoder block fills remain within 64 KiB/read and 12 MiB/task. Playback frame capture must not open another video connection; validate JPEG size/dimensions before storing. Recent-history deletion removes only that history item, never its file, resume record or thumbnail. Hold-to-speed is explicitly excluded.
- **共享浏览**：新 SMB 来源共享名留空时使用 `scope=server`，路径为 `/@network/id/share/relative`；历史缺少 scope 的来源仍是绑定共享的 `scope=share`，禁止原 id 改 scope 重新解释续播路径。枚举可见不等于有目录读取权限，禁止降级 SMB1 或泄露密码。
- **播放常亮**：设置默认勾选，旧设置缺字段默认开启；原生窗口和 WebView 子视图常亮都受前台播放会话与用户选项约束，离开播放或后台释放，不修改系统熄屏时间。
- **安全区**：所有固定层用 `env(safe-area-inset-*)`，刘海/状态栏出现或沉浸式切换时自适应。
- **Mobile information actions**: The playback information card reuses desktop info nodes and provides audio, subtitle, manual danmaku, filtering and settings actions. Audio availability follows selectable tracks. Subtitle selection remains available during a valid playback session even when no automatic subtitle matched.

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

**改完代码给人验收时，debug 和 release 必须一起构建、一起装。** 只更 debug 会让正式包停在旧代码上，
同一台手机里两个包行为不一致，验收的人无法判断改动到底生效没有。两个包用同一个构建戳：

```powershell
$env:BPLAYER_BUILD_STAMP = Get-Date -Format 'MMdd-HHmm'
npm run android:build                          # arm64 debug
npm run android:build:release                  # arm64 release，同一时间戳
adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
```

首页版本行显示构建戳（debug 为 `v0.1.4 · debug 1118-0952`，release 为 `v0.1.4 · 1118-0952`）。
两包戳相同 = 同一次代码；手机上戳比刚构建的旧 = 包没装上。

产物：`bplayer-android/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`（构建产物与 `node_modules`、`target`、Gradle `build/` 均已 gitignore）。

## 已验证 / 已知限制

已验证：异形契约（6.11 GB MP4，1920×1080）播放；23,159 条 B 站弹幕 271–293 ms 解析；竖屏首页与横屏播放切换；沉浸式；文件夹 10 集连播；同源换集；返回键层级；最近播放去重；信息卡与设置页手机布局。

Audio conversion now works through the Android native bridge: local DTS/TrueHD/AC-3 fixtures and a real SMB same-directory write/cache-reuse path were verified. Streaming audio (fragmented MP4 + MediaSource) is verified on local DTS/DTS-HD fixtures and a real SMB AC-3 source, including seek restart, track switching and exit cleanup. Embedded text subtitle extraction and PGS remain unimplemented. AC-4/DRA are not certified; unsupported converters fail explicitly. WebDAV/SFTP publishing code is compiled and covered by shared transfer tests but has not been certified against a live server. Read-only sources or servers missing safe conditional publication/mtime fail without overwriting files. The source fingerprint is bounded, not a full cryptographic file scan.

## 注意的坑

- `.stage` 等元素带 `animation-fill-mode: both` 的 identity `transform` 会形成 containing block，fixed 后代无法全屏；全屏规则必须落在 `.stage` 上并清 `transform/animation`。
- 原 CSS `#aFileMask{display:flex}` 会压过 `[hidden]`，需要 `#aFileMask[hidden]{display:none!important}`。
- 播放列表曾因同样的 animation transform 永远展开，必须用 `!important` 压回 `translateX`。
- 弹幕/字幕/音轨浮窗在桌面是 `position:fixed; right:16px; bottom:64px`，手机上统一改成底部面板，z-index 必须高于全屏舞台。
- WebView 中 `crossOrigin` 媒体与 asset 协议有关；Range 上限约 1 MB。
- 上传 APK 到 GitHub Release：debug 包必须排在正式包**下面**，但 GitHub 的资产列表**按文件名排序、不是上传顺序**（上传先后对显示毫无影响）。`Bplayer-Android-0.1.4-debug.apk` 与 `Bplayer-Android-0.1.4.apk` 在第 21 个字符处是 `-`(0x2D) vs `.`(0x2E)，`-` 更小，所以 debug 会永远顶在最上面、用户一眼点错（debug 包带 `.debug` 包名、与正式包不覆盖安装、体积大一倍）。修法是把版本号后移：debug 命名成 `Bplayer-Android-debug-<ver>.apk`，正式包是 `Bplayer-Android-<ver>.apk`，这样 `0`(0x30) < `d`(0x64)，正式包才排前面。`UpdateChecker` 用 `contains("debug")` 区分轨道，改名不影响自动更新。
