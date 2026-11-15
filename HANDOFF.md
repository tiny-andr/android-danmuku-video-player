# HANDOFF：Bplayer Android 移植

> 面向完全没有上下文的新会话或另一个 agent。读这一份即可接手。
> 最后更新：2026-11-16，对应仓库提交 `8e9c886`。

## 0. 一页速览

- **在做什么**：把 Windows 桌面版 **Bplayer**（Tauri 2 + WebView + Artplayer + 弹幕插件）移植到 Android。保留原有播放/弹幕/字幕逻辑，重做手机界面。
- **代码在哪**：`H:\Project\android-danmuku-video-player`（git 仓库，分支 `main`，无远程）。
- **原始项目**：`H:\Project\Bplayer`，**只读，绝对不能改**。
- **测试机**：荣耀 Magic V2（VER-AN10），Android 17 / API 37，arm64，8 GB；WebView 151.0.7922.199；横屏 CSS 视口约 **931×415**，DPR 2.55。
- **测试片**：`/sdcard/Download/异形 契约.Alien.Covenant.2017.BD1080P.X264.AAC.English.CHS-ENG.Mp4Ba.mp4`（6,558,821,553 字节，约 6.11 GB，H.264 + AAC 1080p）；同名弹幕 `...Mp4Ba.xml`（2.39 MB，23,159 条）。
- **当前状态**：P0/P1/P2/P2.5 已完成并在真机验证；**首页竖屏、播放页横屏、信息卡、音轨/字幕/屏蔽/设置入口、返回键链可用**。APK 已安装并可正常播放。
- **卡点**：P3 尚未开始。DTS/TrueHD/AC-3/EAC-3 等音轨在 WebView 里无声；ffmpeg 转码、内嵌字幕抽取、PGS 位图字幕仍是占位命令。设置里的「自动转换音轨/字幕」开关只保存，不会真正转码。
- **下一步**：先做 ffmpeg arm64 可执行性验证，再做音频转码；具体见第 8 节。

## 1. 硬约束（先读）

1. `H:\Project\Bplayer` **只读**。不要修改、格式化、删除、重命名其中任何文件；不要让构建/脚本把产物写进去。需要对照实现时只读查看（它自己的 `AGENTS.md` 也只读）。
2. 所有改动只允许落在 `H:\Project\android-danmuku-video-player`。
3. 不要重新 `tauri android init`。`src-tauri/gen/android` 里有手工改过的 `MainActivity.kt`、`AndroidManifest.xml`，重新初始化会覆盖它们。若必须重建，先备份并重新落回这些改动。
4. 不要为了省事把 Bplayer 的桌面 UI/交互整套重写。前端核心是拷贝，手机壳集中在 `android-shell.js`，优先复用原 DOM 与事件。

## 2. 阶段与完成度

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | Android WebView 能力探针（codec / asset / fullscreen / orientation / insets） | 完成，见 `research/android-port-research.md` |
| P1 | Tauri 2 Android 空壳、Gradle/NDK/JDK 工具链 | 完成 |
| P2 | 搬入 Bplayer 前端，Rust 文件/弹幕/字幕命令，手机界面第一版 | 完成 |
| P2.5 | 首页不强制横屏、播放页锁横屏、信息卡、功能入口、设置手机化 | 完成，已真机验证 |
| P3 | ffmpeg 转码、mkv_sub、PGS、后台服务、发布打包 | **未开始** |

### 真机已验证

- 异形契约 6.11 GB 正常播放，23,159 条弹幕自动加载，解析 271–293 ms。
- 竖屏首页 → 点最近播放 → 自动转横屏进入沉浸式播放 → 返回后恢复系统栏与竖屏（系统自动旋转开启时）。
- 顶部悬浮条随 Artplayer 控制栏显隐；弹幕开关、播放列表、信息卡、返回都可用。
- 信息卡展示：时长 2:02:03、1920×1080、6.11 GB、23,159 条、271 ms、当前进度；音轨/字幕按原逻辑无可用轨道时置灰。
- 文件夹 `Download` 扫描 10 集，抽屉换集直接进播放页；同源换集有兜底。
- 返回键优先级：设置 → 信息卡 → 浮窗 → 文件浏览器 → 播放列表 → 播放页 → 退出应用。
- 最近播放跨进程保留；`//sdcard` 与 `///sdcard` 已归一化去重。
- 首页右上角齿轮可打开设置；设置页已隐藏 Windows 专用的「开机自动启动」，并加注转码待接入。
- 弹幕屏蔽面板改为底部浮层，实测 `x=12, width=392, z-index=100050`；设置模态 `z-index=100070`。

### 证据截图

- `probe/m21.png` / `probe/m26.png`：竖屏首页。
- `probe/m22.png`：横屏沉浸式播放（2376×1060）。
- `probe/m23.png`：横屏控制栏 + 顶部悬浮条。
- `probe/m19.png`：信息卡。
- `probe/m20.png`：手机版设置页。
- 更早的探针与阶段截图在 `probe/`；仓库 gitignore 排除了 `probe/*.png`，这些图只在本机。

## 3. 关键文件与职责

```
bplayer-android/
  ui/
    index.html            Bplayer 前端拷贝 + 少量移动端接线（isMobile、Artplayer 选项、invoke 代理、文案）
    android-shell.js      手机壳（约 700 行）：启动页/文件浏览器/播放页顶栏/信息卡/方向与沉浸式桥/返回键
    vendor/               Artplayer、弹幕插件、音轨插件等
  src-tauri/
    src/lib.rs            Rust 命令；转码/PGS 等仍是桩
    tauri.conf.json       frontendDist=../ui；assetProtocol 放行 /sdcard /storage
    tauri                 无扩展名 Node shim，Gradle 调 Tauri CLI 用；不能删
    gen/android/app/src/main/AndroidManifest.xml
                          方向 fullSensor、权限、Activity 配置
    gen/android/app/src/main/java/com/danmuku/bplayer/android/MainActivity.kt
                          沉浸式 / 横屏锁 / 退出 / 返回键 JS 桥
  package.json            npm run android:build
  scripts/gen-icon.ps1    图标辅助
probe/
  cdp-eval.js             CDP 求值小工具（支持 CDP_PORT 环境变量，默认 9222）
  app/                    早期 WebView 能力探针 Android 工程（源码保留，build 已忽略）
research/
  android-port-research.md  能力调研、P0–P2.5 记录、风险与附录
AGENTS.md                 仓库级 agent 约定（构建/测试/坑位摘要）
HANDOFF.md                本文件
```

### 前端两个关键接线

- `window.__aInvoke` 拦截 `pick_video` / `pick_folder`，改为自绘文件浏览器；其他命令透传 `window.__TAURI__.core.invoke`。
- Tauri 的 `window.__TAURI__` 注入晚于 `android-shell.js` 执行，脚本里**不能在 IIFE 顶部读取**，必须在调用时取。

### 原生桥（`AndroidUI`）

`MainActivity.onWebViewCreate()` 注入：

- `setImmersive(bool)`：播放页隐藏/恢复系统栏（`WindowInsetsControllerCompat`）。
- `setLandscape(bool)`：播放页 `SCREEN_ORIENTATION_SENSOR_LANDSCAPE`；退出 `FULL_SENSOR`。
- `exitApp()`：返回键链最后一步才真正 `finish()`。

返回键通过 `OnBackPressedDispatcher` 执行 `window.__aAndroidBack()`；该函数返回 `true` 表示已消费。

## 4. 当前界面行为规格

- **首页**：不锁方向，跟随系统。竖屏为品牌/两个大按钮在上、最近播放在下；横屏为左右两栏。右上角齿轮进设置。
- **按钮**：选择视频 / 选择文件夹，转发到隐藏的原 `#btnOpenVideo` / `#btnOpenFolder`。
- **最近播放**：localStorage `bplayer.android.recent.v1`，实际存 8 条、渲染 5 条；进入播放后记录。key `bplayer.android.lastDir` 记住文件浏览器目录。
- **播放**：点文件/最近/剧集后进入全屏舞台；隐藏系统栏；锁横屏；顶部悬浮条随 Artplayer 控制栏自动显隐。
- **顶栏**：返回、标题（去扩展名）、弹幕数量/解析耗时、弹幕开关、`i` 信息卡、播放列表。
- **信息卡**：读取原 `#infoDuration/#infoRes/#infoSize/#infoCount/#infoParse/#infoTime`；四个入口转发到 `#btnAudioEntry/#btnSubtitleEntry/#btnBlockEntry/#btnSettings`。音轨/字幕在无可用轨道时置灰（继承原逻辑）。
- **浮窗**：屏蔽/音轨/字幕/密度统一底部浮层，宽 `calc(100vw - 24px)`，带安全区；设置页全宽、可滚动。
- **文件浏览器**：自绘全屏面板，行高 52px，快捷路径 Download / 内部存储 / Movies / 存储根；只列目录与视频。
- **安全区**：所有固定层使用 `env(safe-area-inset-*)`；系统栏出现时约 39px，沉浸式时 0。

## 5. 构建、安装、启动

环境（本机已验证）：Windows、JDK 21、Android SDK 37（`platforms;android-37.0`、`build-tools;37.0.0`）、NDK `28.2.13676358`、Node 24、Rust `aarch64-linux-android` target。

```bash
cd H:/Project/android-danmuku-video-player/bplayer-android
npm install                       # 首次
npm run android:build             # debug，只出 aarch64

adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
adb shell am force-stop com.danmuku.bplayer.android
adb shell monkey -p com.danmuku.bplayer.android -c android.intent.category.LAUNCHER 1
```

- 包名：`com.danmuku.bplayer.android`
- APK：`bplayer-android/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`
- debug APK 约 131 MB，未压缩；release 还没做。
- 构建日志：`build-m*.log`（gitignore，不提交）。

### 无线 adb

```bash
adb pair 192.168.1.6:<pair-port> <pair-code>
adb connect 192.168.1.6:<debug-port>
adb devices
```

当前设备名可能显示为 `adb-AVNS023908001553-sMEtj8._adb-tls-connect._tcp`。端口/配对码会变，以手机「无线调试」页面为准。

## 6. 调试与快速回归

### CDP

```bash
PID=$(adb shell pidof com.danmuku.bplayer.android)
adb forward --remove-all
adb forward tcp:9223 localabstract:webview_devtools_remote_$PID
CDP_PORT=9223 node probe/cdp-eval.js "JSON.stringify({w:innerWidth,h:innerHeight})"
```

每次重装/重启 app，进程号都会变，必须重新 forward；旧的 9223 会 `ECONNREFUSED`。

常用检查：

```bash
# 首页/播放页状态
CDP_PORT=9223 node probe/cdp-eval.js "JSON.stringify({home:!document.getElementById('mHome').classList.contains('hide'),playing:document.body.classList.contains('m-playing'),w:innerWidth,h:innerHeight})"

# 打开最近播放（进入播放页，随后会转横屏）
CDP_PORT=9223 node probe/cdp-eval.js "document.querySelector('.mRecentRow').click(); 'ok'"

# 打开信息卡
CDP_PORT=9223 node probe/cdp-eval.js "document.getElementById('mInfoBtn').click(); document.getElementById('mInfo').hidden"

# 返回（播放页 → 首页）
CDP_PORT=9223 node probe/cdp-eval.js "window.__aAndroidBack()"

# 打开屏蔽面板并查看位置
CDP_PORT=9223 node probe/cdp-eval.js "(function(){document.getElementById('mActBlock').click();var p=document.getElementById('blockPanel');var r=p.getBoundingClientRect();return JSON.stringify({hidden:p.hidden,x:r.x,y:r.y,w:r.width,z:getComputedStyle(p).zIndex})})()"
```

### 截图（Git Bash 有坑）

```bash
adb shell screencap //sdcard/Download/x.png
adb pull //sdcard/Download/x.png probe/x.png
```

- 必须用 `//sdcard`，单斜杠会被 Git Bash 当成本机路径。
- 这台 Android 17 上 `screencap -p` 会打印用法，不要带 `-p`。
- 屏幕休眠时截出来是纯黑：先 `adb shell input keyevent 224` 再上滑解锁。
- 设备有多个 display 时会警告，默认捕获一般够用；竖屏截图应为 1060×2376，横屏播放应为 2376×1060。

### 方向测试

```bash
adb shell wm user-rotation lock 1     # 锁横屏
adb shell wm user-rotation lock 0     # 锁竖屏
adb shell wm user-rotation free       # 恢复
adb shell settings put system accelerometer_rotation 1
```

测完一定恢复自动旋转，否则会误判首页方向。

## 7. 卡点与已知限制

### 真正的技术卡点

1. **WebView 音轨解码**：DTS、TrueHD、AC-3、E-AC-3、AC-4 等无法解码，表现为有画面无声。桌面版靠 ffmpeg 转 AAC，Android 还没有 ffmpeg。
2. **ffmpeg 如何随 APK 运行**：Android 10+ 不允许随意执行应用数据目录里的二进制。需要把静态 arm64 ffmpeg 以 `lib*.so` 形式放进 `jniLibs` / `nativeLibraryDir` 再执行。这一点**尚未验证**，是 P3 第一优先级 spike。
3. **内嵌字幕**：`extract_subtitle_text` 仍是桩；MKV 内嵌 SRT/ASS 不能抽出来。外挂字幕扫描已实现。
4. **PGS 位图字幕**：`pgs_*` 仍是桩，无法解码叠加。
5. **MKV 外挂音轨**：`transcode_audio_start` 只返回错误；音频轨切换菜单只在检测到“死编码音轨”时出现。

### 已确认的能力边界

- WebView 可播：MP4 H.264/AAC；MKV H.264/HEVC Main10、4K、HDR 的视频部分。
- WebView 不可播：MSE + MKV；HTML5 `requestFullscreen()` 在 Wry 的 `onShowCustomView/onCustomViewHidden` 链路下会被取消；`screen.orientation.lock()` 抛 `NotSupportedError`；PiP 不可用。
- asset 协议：页面 `http://tauri.localhost`，媒体 `http://asset.localhost`；Range 上限约 1 MB；跨域媒体需要 `crossOrigin="anonymous"`。
- 折叠屏展开/合拢未专门验证；横屏 CSS 视口 931×415，宽度大于 768，所以原 `isMobile` 判定失效，已改成 `pointer: coarse` / 宽度判断。

### 产品/交互上的遗留

- 播放页锁横屏是当前策略；如果产品希望播放也跟随传感器，需要删除 `setLandscape(true/false)` 调用，并处理竖屏下弹幕字号溢出（当前竖屏播放弹幕会横向溢出）。
- 信息卡只在打开/标题变化时刷新，打开期间“当前进度”可能不实时；可接 `timeupdate`。
- 设置页两个「打开位置」按钮在 Android 会调用 `reveal_path` 桩并报错，建议隐藏。
- 单音轨 AAC 文件没有音轨按钮（原逻辑只有死编码才显示），若产品要求“永远可见”需要改 `refreshAudioMenu`。
- 没有填充/裁剪切换，超宽片上下留黑。
- 文件浏览器不能单独选弹幕/字幕，依赖同目录自动配对。
- 自动转换开关不会转码，只是保存偏好（设置页已注明）。

## 8. 下一步计划（按优先级）

### P3-1 ffmpeg 可行性 spike（最优先，先验证再写业务）

目标：在真机上执行随 APK 分发的静态 arm64 ffmpeg，打印 `-version`。

建议做法：

1. 取静态 arm64 ffmpeg（或 ffmpeg-kit 的 binary），命名成 `libffmpeg.so`。
2. 放入 `src-tauri/gen/android/app/src/main/jniLibs/arm64-v8a/`（当前该目录被 gitignore）。
3. Kotlin/Rust 用 `applicationInfo.nativeLibraryDir + "/libffmpeg.so"` 作为可执行路径，`ProcessBuilder(... "-version")`。
4. 若系统拒绝执行（`EACCES`/`EPERM`），再评估 `android:extractNativeLibs`、打包方式或改用 MediaCodec/ExoPlayer 方案。

验收：真机 log 能拿到 ffmpeg 版本字符串；能对 `test-h264-dts.mkv` 转出可播 AAC。

### P3-2 音频转码

- 实现 `transcode_audio_start` / `transcode_audio_cancel` / 进度回传；产物先落 app 缓存或同目录临时文件。
- 接回原逻辑的 `audio-track` 插件（`vendor/artplayer-plugin-audio-track.js`）。
- 打开 `optAutoAudio` 时，开片探测到死编码音轨自动转；关闭时在音轨菜单手动点选才转。
- 注意息屏/后台保活：已有 `WAKE_LOCK`，长时间转码需要前台服务（P3-4）。

测试片（都在 `/sdcard/Download`）：

- `test-h264-dts.mkv`（18 MB）
- `test-h264-eac3.mkv`（17 MB）
- `test-aac.m4a`（324 KB，对照）
- `test-hevc10-4k-aac.mkv`（12.6 MB，4K 性能）
- `pan-real-6s.mkv`（25 MB，真实片源片段）

### P3-3 字幕

- 实现 `extract_subtitle_text`：优先读 MKV Cues 索引，没有索引才顺序扫描；输出只进内存，不写文件（沿用桌面策略）。
- 验证内外挂 SRT/ASS/SSA/VTT 自动挂载与切换。
- PGS：解码 RLE 位图 → 按时间戳叠加 Canvas/图片层；需要新测试片。

### P3-4 后台与保活

- 转码/抽取长任务用前台服务 + 通知，避免切后台被杀。
- 区分“播放中保持屏幕常亮”和“后台转码”。

### P3-5 手机 UI 收尾

- 折叠屏展开/合拢、竖屏/横屏切换回归。
- 视产品决定是否保留播放页锁横屏；若要自由旋转，修竖屏弹幕字号/溢出。
- 信息卡进度实时刷新；隐藏 Android 上无意义的“打开位置”。
- 可选：填充/裁剪、手动选字幕/弹幕、播放速度。

### P3-6 发布

- release 构建：LTO、strip、只保留 arm64，目标把 131 MB 压下来。
- 签名、版本号、升级安装验证。
- 目前没有远程仓库；如需发布再决定托管位置。

### 战略备选

如果 ffmpeg 侧车在 Android 17 上无法稳定执行，备选是原生 Media3/ExoPlayer 播放视频 + 保留 WebView 只做弹幕/控制层，或整体原生重写。代价大，先不要跳这条路，先把 ffmpeg spike 做完再决策。

## 9. 踩过的坑（不要再踩）

| 现象 | 根因 | 解决 |
|---|---|---|
| 手机壳脚本完全不执行 | `window.__TAURI__` 在脚本执行后才注入，IIFE 顶部读取直接异常 | 调用时再取；用 `window.__aInvoke` 代理并改 index.html 两处 invoke |
| 播放列表抽屉永远展开、关不掉 | `.wrap > *` 的 `rise` 动画 `fill-mode: both` 结束帧是 identity `transform`，覆盖了 `translateX(105%)` | `.playlist:not(.open){transform:translateX(110%)!important}`，`.open{transform:none!important}` |
| 播放器无法真正全屏，fixed 区域偏移 | `.stage` 同样带 identity `transform`，成为 fixed 后代的包含块 | 全屏规则落在 `.stage`：`position:fixed; inset:0; transform:none!important; animation:none!important` |
| 选完文件浏览器遮罩不消失 | 作者 CSS `#aFileMask{display:flex}` 优先级高于 UA 的 `[hidden]{display:none}` | 增加 `#aFileMask[hidden]{display:none!important}` |
| 原生 `set_fullscreen` 无效 | Tauri/Wry Android 侧是 no-op；HTML5 fullscreen 被 `onCustomViewHidden` 取消 | 放弃系统 fullscreen，改用 fixed 舞台 + `AndroidUI.setImmersive()` |
| 想用 `screen.orientation.lock()` 锁方向 | Android WebView 抛 `NotSupportedError` | 用 Activity `requestedOrientation`，通过 JS 桥调用 |
| 首页一进来就是横屏（用户投诉） | Manifest `android:screenOrientation="sensorLandscape"` | 改 `fullSensor`；只有播放页用原生桥锁 `SENSOR_LANDSCAPE` |
| 竖屏首页没有“最近播放” | `@media (max-width:680px)` 隐藏了 `.mRight`，竖屏媒体查询只改了 flex，没有恢复 `display` | 竖屏规则显式 `display:flex` |
| 竖屏播放弹幕横向溢出 | 弹幕插件字号按横屏设计，竖屏视口太窄 | 当前靠播放页锁横屏规避；若解锁需按视口缩字号 |
| 点同一文件的最近播放/换集不进播放页 | 同 URL 不触发 `loadedmetadata`，play 也可能被拦 | 代理点击 `.pl-item` 后主动 `enterPlaying()` + `art.play()` |
| 最近播放出现重复条目 | 路径有 `//sdcard` 与 `///sdcard` 两种 | `normPath` 统一斜杠、去重、读时重写 |
| 状态栏压住页面/退出播放后错位 | 固定 padding 无法适应系统栏显隐 | 全部用 `env(safe-area-inset-*)`；沉浸式由原生控制 |
| 桌面浮窗在手机上被视频盖住 | `.block-panel` z-index 70，舞台 99990 | 手机壳统一改 z-index 100050、底部浮层；设置 100070 |
| 设置页在手机上像桌面弹窗 | 460px 固定宽、Windows 文案 | 全宽模态、隐藏开机自启、加 Android 转码说明 |
| 截图拉不下来/路径错误 | Git Bash 把 `/sdcard` 转成本机路径 | 用 `//sdcard/...` |
| 截图纯黑 | 屏幕休眠（`mWakefulness=Dozing`） | `input keyevent 224` + 上滑解锁 |
| CDP `ECONNREFUSED` | 重装后 pid 变了，forward 指向旧进程 | 重新 `pidof` + `adb forward` |
| 测试时首页方向判断错乱 | 手动锁了 `user_rotation` 或关了自动旋转 | 测完 `wm user-rotation free`、`accelerometer_rotation=1` |
| Gradle 构建报找不到 tauri | Tauri CLI 需要无扩展名的 `src-tauri/tauri` shim | 保留该文件，内容转发到 `@tauri-apps/cli/tauri.js` |
| 仓库里混入几百 MB 构建产物 | probe/Gradle/target 默认会被 add | `.gitignore` 排除 `node_modules`、`target`、`gen/android/**/build`、`jniLibs`、`probe/*.png`、`*.log` |
| git commit 报身份缺失 | 本机没配全局 user.name/email | 不改全局配置，提交时用 `git -c user.name=... -c user.email=... commit` |

## 10. 仓库状态

- 分支 `main`，没有远程。
- 提交（最新在上）：
  - `8e9c886` 首页增加设置入口
  - `837b999` 补充竖屏首页、信息卡与播放方向策略记录
  - `ee41163` 初始化 Bplayer Android 移植
- 工作区干净。
- 提交身份是临时 `Administrator <administrator@localhost>`，通过 `-c` 传入，没有写入 git config。
- `.gitignore` 已排除：`node_modules`、`src-tauri/target`、Gradle `build/`、`local.properties`、`jniLibs`、`*.log`、`probe/*.png`、`probe` 构建目录。

## 11. 待决策

1. 播放页是否继续强制横屏？当前是强制。用户只明确反对“首页替用户决定方向”。
2. 是否接受 ffmpeg 侧车方案，还是尽早转 Media3/ExoPlayer？建议先做 P3-1 spike。
3. 音轨/字幕入口是否要“永远可见”，还是沿用桌面“有可选项才显示”。
4. 是否需要手动选择同目录弹幕/字幕文件；当前只自动配对。
5. 折叠屏适配优先级；当前只验证了外屏竖屏与横屏播放。

## 12. 新会话启动清单

1. 读本文件 + `AGENTS.md`；确认 Bplayer 只读。
2. `adb devices`，确认设备在线；不在线先无线配对。
3. `cd bplayer-android && npm run android:build`，安装并启动。
4. 用 CDP 检查首页状态；点最近播放确认能转横屏播放、弹幕加载。
5. 若继续 P3，先做第 8 节 P3-1 的 ffmpeg 执行 spike，**不要先写转码业务**。
6. 每次重装后重新 `adb forward`；每次方向测试后恢复自动旋转。
7. 提交前 `git status`，确认没有构建产物；只提交源码、配置、文档。
