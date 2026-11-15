# Bplayer 安卓化可行性研究

- 研究对象：`H:\Project\Bplayer`（Tauri 2 桌面版，v1.2.6）
- 研究方式：只读源码 + 只读 Tauri/Wry 依赖实现 + 真机探针 APK；**未修改 Bplayer 任何文件**
- 目标设备：荣耀 Magic V2（VER-AN10，Android 17 / API 37，WebView 151.0.7922.199，USB adb）
- 目标片源：`/sdcard/Download/异形 契约.Alien.Covenant.2017.BD1080P.X264.AAC...mp4`（6.56 GB，H.264/AAC）
- 当前状态：P0 真机探针、P1 空壳工程、P2 播放器前端 + 手机 UI 已完成；下一步 P3（mkv_sub / PGS / ffmpeg arm64）

---

## 0. 结论速览（已用真机探针验证，2026-11-16）

1. **A 路线（Tauri 2 Android 直移）成立**。荣耀 Magic V2 的系统 WebView 151 可以直接播放 MP4/H.264/AAC、MKV/H.264/AAC、MKV/HEVC Main10/AAC、4K HEVC Main10，甚至 30 GB 的 x265 10bit HDR + DTS-HD MA 片源（视频正常、HDR 不发黑不变色、0 掉帧）。桌面版“Chromium 只认默认音轨 / 需要隔离音轨”的判断在 Android 上同样成立。
2. **唯一被证伪的编解码项是 DTS/TrueHD/AC3/E-AC3**：`canPlayType` 返回空串，DTS 片源 `webkitAudioDecodedByteCount = 0`（视频照常渲染、完全无声）。这正是桌面版已有的“ffmpeg 抽默认音轨 → 外挂 AAC”方案要解决的场景，探针已验证该替代链路有效：外挂 AAC（`crossOrigin=anonymous` + WebAudio analyser）RMS = 0.01776，且视频帧继续前进。
3. **UI 层有三个 Android 特有的硬事实**，移植时必须改：
   - HTML5 `requestFullscreen()` 在 Wry 风格的 `onShowCustomView → onCustomViewHidden` 下**不可用**（`document.fullscreenElement` 仍是 true，但视口不扩大）；P2 改用「`.stage` fixed 铺满 + 原生 WindowInsetsController 隐藏系统栏」。
   - `requestPictureInPicture` 抛 `NotSupportedError`（`pipEnabled=false`），画中画按钮要隐藏。
   - `screen.orientation.lock()` 抛 `NotSupportedError`；方向只能靠 Activity 的 `requestedOrientation`（P2 固定横屏；P2.5 改为首页 `fullSensor`、仅播放页锁横屏）。
   - 另：折叠屏横屏 CSS 视口为 **931×415**，原 `isMobile = clientWidth < 768` 判定为 **false**；P2 改为 `pointer: coarse` 并重写启动页/播放页/文件浏览器，不复用桌面布局。
4. **存储模型可行**：`MANAGE_EXTERNAL_STORAGE` 经 `appops set --uid ... allow` 授予后，直接 `File` 访问 `/sdcard/Download` 读写、`read_dir`、`convertFileSrc` 都能用，不需要 SAF。侧载分发没有障碍。
5. **剩余工程风险不在播放，在构建与后端**：
   - `rfd` 在 Android 无实现、`autostart.rs` 是纯 Windows —— 必须做 `cfg` 隔离；
   - ffmpeg 需要 arm64 侧车（NDK 打包进 `nativeLibraryDir`）；
   - 本机尚未安装 Android NDK 和 Rust Android target，这是 P1 的第一件事；
   - Tauri asset 协议单次 Range 上限 1 MB，**已用真实 Tauri 工程复测**：35.5 GB HDR MKV 的 10/50/90% seek 为 715 / 726 / 247 ms，不构成问题。
6. **工作量预估**：环境 + 能播起来约 3–4 天；功能对齐（音轨/字幕/PGS/弹幕/播放列表）约 1–2 周。Media3 混合方案（B 路线）暂不需要，仅作为“未来要上架或要 PiP”时的升级项。

---

## 1. 项目现状解构

### 1.1 技术栈

| 层 | 内容 |
|---|---|
| 壳 | Tauri 2.12.5（`Cargo.lock`） |
| 前端 | 无构建链，`src/index.html` 单文件（2141 行），CSS/JS 内联；ES5 IIFE |
| 播放内核 | Artplayer 5.3.0（本地副本 `src/vendor/artplayer.js`） |
| 弹幕 | artplayer-plugin-danmuku 5.2.0（本地补丁版，`.orig.js` 保留原版） |
| 外挂音轨 | artplayer-plugin-audio-track 1.1.0（独立 `Audio` 元素跟视频时钟） |
| 后端 | Rust：命令薄封装 + ffmpeg 子进程 + 纯 Rust 的 MKV/PGS 解析 |
| 媒体 URL | Tauri asset 协议：`http://asset.localhost/...`（`convertFileSrc`） |

### 1.2 代码地图（只列与安卓化相关的）

| 文件 | 职责 | 平台耦合 |
|---|---|---|
| `src/index.html` | 播放器装配、弹幕、字幕菜单、音轨菜单、设置、拖放、进度胶囊 | 拖放、rfd、资源管理器、Windows 路径、桌面布局 |
| `src-tauri/src/lib.rs` | 命令注册、文件/目录扫描、同名弹幕配对、选文件、定位目录 | `rfd`、`explorer.exe`、`std::fs` 路径 |
| `src-tauri/src/mkv_probe.rs` | 解析 EBML Tracks，得到音轨/字幕轨 CodecID、TrackNumber、时长 | 纯 Rust，可移植 |
| `src-tauri/src/mkv_sub.rs` | 按 Cues 索引稀疏抽取文本字幕（核心性能点） | 纯 Rust，可移植 |
| `src-tauri/src/pgs_render.rs` | libpgs 解码 PGS → base64 PNG 事件表 | 纯 Rust + `File/Seek`，可移植 |
| `src-tauri/src/transcode.rs` | 音轨转 AAC、字幕抽取兜底、单任务状态机、Windows Job Object | 子进程、ffmpeg 定位、Job Object、写媒体同目录 |
| `src-tauri/src/autostart.rs` | 写 HKCU Run 键 | 纯 Windows，Android 必须移除/stub |

### 1.3 运行时链路

```
用户选文件/拖入
  → 真实路径 path
  → convertFileSrc(path) = http://asset.localhost/<encoded>
  → Artplayer <video crossOrigin=anonymous>
  → probe_mkv_tracks(path)         // 只看 MKV/WebM
  → classifyAudio → 死编码则：
       isolateVideoAudio()          // WebAudio gain=0，静音内核自己挑的轨
       transcode_audio_start(...)   // ffmpeg 抽出默认轨 → 同目录 (音轨N).mka
       audio-track 插件独立 Audio 跟时钟
  → scan_subtitles(path) + buildSubtitleMenu()
  → 内嵌文本字幕：mkv_sub 稀疏抽取 → 内存 SRT → blob URL → Artplayer
  → PGS：libpgs 解码 → 事件表 + 按需 PNG → 绝对定位覆盖层
  → pair_danmaku(path) / scan_folder(dir)
  → transcode://progress / done / error 事件驱动 UI
```

关键设计假设：**内核是 Chromium/WebView2，并且只用默认音轨**。桌面版已经踩过“Chromium 会挑第一条能解的轨”和“跨源媒体 WebAudio 抓出静音”两个坑（`index.html:1180-1210`、`index.html:721-729`）。Android WebView 也是 Chromium，这两个坑大概率同样存在，现有补丁可以沿用。

### 1.4 已有的移动化痕迹

- `src-tauri/Cargo.toml:7-9`：`crate-type = ["staticlib", "cdylib", "rlib"]`，这是 Tauri 移动端要求。
- `src-tauri/src/lib.rs:312`：`#[cfg_attr(mobile, tauri::mobile_entry_point)]`，入口已按移动端生成。
- `src/index.html:471`：`isMobile = clientWidth < 768`。
- `src/index.html:707-710`：移动端音量 1、关闭 `fullscreenWeb`、`autoOrientation`。
- 结论：项目从一开始就按“以后可能上移动端”搭的，不是硬改成移动端。
- **但真机实测发现该分支不会触发**：Magic V2 折叠屏横屏 CSS 视口为 931×415，`931 < 768` 为 false，`isMobile` 恒为 false。移植时断点应改为 `matchMedia('(pointer: coarse)')` 或 UA 判定，不能依赖宽度。

---

## 2. Tauri/Wry Android 能力基线（读依赖源码得到的事实）

这一节是判断“能不能直接移”的关键，均已核对本机 Cargo registry 里的 `tauri 2.12.5` / `wry 0.57.2` 源码。

| 能力 | Android 行为 | 对 Bplayer 的影响 |
|---|---|---|
| asset 协议 | `convertFileSrc` 返回 `http://asset.localhost/...`；请求走 `shouldInterceptRequest` → Rust `handleRequest` | 与桌面同一套 URL，前端 `mediaUrl()` 不用改 |
| Range / 拖动 | Rust 侧实现 206、`Content-Range`、`Accept-Ranges`，单次最多 1 MB；Wry Kotlin 侧还有 Chromium “跳过起点” bug 的包装 | 探针（16 MB 分片）已验证 30 GB 片可 seek；1 MB 分片的延迟待 P1 实测 |
| CORS | asset 响应带 `Access-Control-Allow-Origin: <window_origin>` | 真机已验证：跨源 `crossOrigin=anonymous` + WebAudio 不会变静音 |
| 路径模型 | asset 协议最终是 `tokio::fs::File::open(path)` | **只认真实文件路径，不认 `content://`**；SAF 选出来的 URI 不能直接喂给 `convertFileSrc` |
| 自动播放 | Wry `WebViewAttributes.autoplay` 默认 `true`；Android 设置 `setMediaPlaybackRequiresUserGesture(false)` | 真机静音自动播放 + 后续 `play()` 均已验证 |
| HTML5 全屏 | `RustWebChromeClient.onShowCustomView()` 里立刻 `callback.onCustomViewHidden()` | **原生全屏不工作**（真机已复现）；必须改 CSS 全屏 |
| 页面源 | 移动端页面源是 `tauri.localhost` | 与 `asset.localhost` 仍跨源，CORS 逻辑不变 |
| 文件权限 | asset 协议对 `/storage/emulated/0/Android/data/` 有专门错误提示，说明外部存储路径是预期用法 | `MANAGE_EXTERNAL_STORAGE` appop 授予后已验证可直读 `/sdcard` |

> 注：编解码能力已在 Magic V2 + WebView 151 上实测（见第 6 节）；换机型/换 WebView 版本需重测。

---

## 3. 平台耦合点清单（逐项改造）

### 3.1 会直接导致 Android 编译失败的点

| 位置 | 现状 | 问题 | 处理 |
|---|---|---|---|
| `src-tauri/Cargo.toml:18` | `rfd = "0.15"` | rfd 只有 Windows/macOS/Linux/WASM 后端，Android 下 `FilePickerDialogImpl` 没有实现，`pick_file()` 调用编译不过 | Android 构建时移除 rfd；桌面保留 `cfg(windows/desktop)` |
| `src-tauri/src/lib.rs:241-256` | `pick_video/pick_folder` 用 rfd 同步对话框 | 同上 | 改为自定义文件浏览器（Rust `read_dir`）或 `tauri-plugin-dialog`（返回 content URI，需再解析） |
| `src-tauri/src/lib.rs:10` + `autostart.rs` | `mod autostart;` 无条件声明；文件头 `#![cfg(windows)]`；`lib.rs:328-329` 无条件注册命令 | Android 上模块内容为空，命令符号不存在 | 用 `#[cfg(desktop)]` 条件编译；Android 提供 stub（`false`/`Ok(false)`）或直接删掉设置项 |
| `src-tauri/src/lib.rs:277` | `Command::new("explorer.exe")` | Android 不存在 | 替换为 `ACTION_VIEW`/分享，或删除入口 |

### 3.2 文件与存储模型

所有命令都假设“路径是真实文件系统路径”：

- `fs_stat`（`lib.rs:42-51`）
- `pair_danmaku`（`lib.rs:134-165`）
- `scan_folder`（`lib.rs:182-225`）
- `scan_subtitles`（`lib.rs:69-108`）
- `read_text` / `read_bytes`（`lib.rs:111-115`、`227-231`）
- `sidecar_cache_files`（`lib.rs:286-310`）
- ffmpeg 输出到视频同目录（`transcode.rs:140-160`）
- MKV/PGS 直接 `File::open` + `Seek`（`mkv_probe.rs:47`、`mkv_sub.rs:10`、`pgs_render.rs`）

Android 的现实：

1. **`/sdcard/Download/异形契约.mkv` 是视频媒体文件**，授予 `READ_MEDIA_VIDEO` 后通常可以通过真实路径读（FUSE 重定向）。
2. **但同目录的 `.xml/.json` 弹幕、`.srt/.ass` 字幕不是媒体文件**，Android 13+ 只给 `READ_MEDIA_*` 时读不到，目录枚举也拿不到它们。
3. 写入 `(音轨N).mka` 到 Download 目录，在 Android 11+ 也需要额外权限。
4. SAF 选目录/文件返回 `content://`，不是路径；asset 协议、`std::fs`、ffmpeg 都不直接认。

因此有三条可选策略：

| 策略 | 好处 | 代价 | 建议 |
|---|---|---|---|
| A. `MANAGE_EXTERNAL_STORAGE`（所有文件访问） | 现有 Rust 代码几乎全保留；同名弹幕自动配对、目录扫描、写缓存、ffmpeg 全部照旧；体验最接近桌面 | 需要用户在系统设置里授权；上架 Google Play 受限制；部分厂商 ROM 可能收紧 | **首版推荐（侧载/个人使用）** |
| B. SAF 目录树 + fd 抽象 | 合规、无需敏感权限 | `std::fs::File` 改成 fd/ContentResolver 抽象；ffmpeg 需 `/proc/self/fd/N` 或先转存；工作量大 | 若确定要上架再做 |
| C. 仅 MediaStore 媒体 + 应用私有缓存 | 权限最少 | 同名弹幕/字幕无法自动发现，核心卖点丢失 | 不推荐作为主方案 |

> 结论：首版按 A 做，但把“路径来源”收敛到一个接口（例如 `resolve_video_source()`），为以后换 SAF 留口子。

### 3.3 播放与渲染

| 点 | 现状 | Android 处理 |
|---|---|---|
| 视频 URL | `convertFileSrc`（`index.html:1098`） | 保留；确保 asset scope 覆盖 `/storage/**` 与应用私有目录 |
| 页面/素材跨源 | `asset.localhost` vs `tauri.localhost`；`crossOrigin` 在首次设 src 前设置（`index.html:721-729`） | 保留；不要在任何地方提前给 video 设 src |
| 全屏 | `fullscreen: true`、`fullscreenWeb: !isMobile`（`index.html:708-709`） | **手机上会走原生全屏并失败**；改为 `fullscreenWeb: true`（CSS 占满视口）或实现原生全屏；配合隐藏状态栏/导航栏 |
| 自动旋转 | `autoOrientation: true`（`index.html:710`） | `screen.orientation.lock` 在 WebView 里可能被拒绝；用 Tauri/Android 原生方向控制兜底 |
| 画中画 | `pip: true`（`index.html:714`） | Android WebView 的 PiP 支持不确定；建议移动端关闭，后续接原生 PiP |
| 触摸/键盘 | 多处 `keydown` Escape（`index.html:937、1081、1991`） | Android 返回键要接管：先关面板/退出全屏，再退应用 |
| 桌面布局 | 固定 1280×860、330px 侧栏、横向 toolbar、hover 效果 | 需要真正的移动端 CSS：安全区、底部面板、44px 触摸目标、横竖屏、折叠屏内外屏 |
| 拖放 | `onDragDropEvent`（`index.html:2042-2080`） | Android 无桌面拖放；保留代码无害，但入口要换成文件浏览器/SAF |
| 资源管理器定位 | `reveal_path`（`index.html:1975-1979`） | 改为“打开/分享缓存目录”，或删除按钮 |
| 开机自启 | 设置页（`index.html:1937-1939、1995-2004`） | Android 不建议做；移除该行，避免误导 |
| 字体 | `"Segoe UI", "Microsoft YaHei"`（`index.html:22`） | 回退到 `system-ui`（Android 的 Noto Sans CJK），显式补 fallback |
| 100vh | `.wrap { height: 100vh }` | WebView 全屏通常没问题，但折叠屏/分屏需用 `100dvh` + `env(safe-area-inset-*)` |

### 3.4 后端模块可移植性

| 模块 | 结论 | 备注 |
|---|---|---|
| `mkv_probe.rs` | 直接可移植 | 纯 `std::fs`，只读文件头 |
| `mkv_sub.rs` | 直接可移植 | 纯 `std::fs` + `Seek`，稀疏读 |
| `pgs_render.rs` | 直接可移植 | `libpgs 0.6` 纯 Rust；PNG 编码也纯 Rust；内存约 30 MB |
| `transcode.rs` | 需改 | ffmpeg 定位、Job Object、写同目录、Android 进程生命周期 |
| `autostart.rs` | 不可移植 | 桌面条件编译 + Android stub |
| `lib.rs` 文件命令 | 需权限/路径模型 | 见 3.2 |

### 3.5 依赖与打包

- `windows-sys` 已按 `cfg(windows)` 引入，Android 不会拉进来（`Cargo.toml:24-25`）。
- `tauri` 的 `protocol-asset` feature 已开（`Cargo.toml:15`），移动端 asset 协议可用。
- `bundle.targets = ["nsis"]`、`bundle.icon`、`windows` 配置只对桌面有意义；Android 需要 `tauri android init` 生成的 `gen/android` 工程与 Gradle 配置。
- `src-tauri/icons/android/` 已存在，说明图标资源已准备。

---

## 4. 三条路线对比

| 维度 | A. Tauri 2 Android 直移 | B. Tauri UI + 原生 Media3 播放面 | C. 全原生 Compose |
|---|---|---|---|
| 复用 | `index.html` + vendor + 全部 Rust 媒体模块 | 前端 UI/弹幕/字幕菜单可复用；播放面重写 | 几乎全部重写 |
| 播放兼容 | 取决于系统 WebView（MKV/HEVC/DTS 待测） | 最好：Media3 支持 MKV、音轨选择、FFmpeg 音频扩展、PGS 可接 | 同 B |
| 弹幕 | 原 Artplayer 插件直接跑 | 需要给插件做“虚拟 video”适配，或把弹幕渲染移出 | 自研弹幕引擎 |
| 全屏/PiP/方向 | 受 WebView 限制，需要绕 | 原生可控 | 原生可控 |
| 文件模型 | 直移时仍需处理 scoped storage | 同 A | 同 A |
| 工作量 | 1–2 周（不含 Media3 回退） | +2–3 周 | 1–2 个月 |
| 风险 | WebView 播放能力是单点 | 架构复杂、双渲染时钟同步 | 最大，但最可控 |

**推荐：A 先走，设置明确的“回退门”**：

- 探针通过（MKV + HEVC + 至少一条可解音轨能播、可 seek）→ 继续 A。
- 只有音频问题 → A + ffmpeg 侧车（已有设计）。
- MKV 容器或 HEVC 10-bit 不达标 → 直接转 B，不要花时间在 WebView 上做 remux 预处理（每次打开都转封装，体验不可接受）。

---

## 5. 推荐方案 A 的改造设计

### 5.1 工程与构建

1. **不要在原仓库直接跑 `tauri android init`**（会写 `src-tauri/gen/android` 等文件，违反本次只读约束）。在 `H:\Project\android-danmuku-video-player` 新建工程，复制 `src/` 与 `src-tauri/src/` 作为移植起点，保留一份 `UPSTREAM.md` 记录来源与同步策略。
2. 环境：
   - Android SDK 已有：`C:\Android\Sdk`（platform 36、build-tools 35/36、JDK 21、Gradle 8.13、AGP 8.13 缓存）。
   - 缺 **NDK** 与 Rust Android target：`rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`；`sdkmanager "ndk;27.0.12077973"`（版本按 Tauri 要求）。
3. `tauri.conf.json`：
   - `identifier` 保持 `com.danmuku.video.player`；
   - `bundle.android.minSdkVersion` 建议 26（Magic V2 是 33/34，不影响）；
   - ABI 首版 `arm64-v8a`，需要旧机再加 `armeabi-v7a`；
   - asset scope 明确覆盖 `/storage/**`、`$EXTERNAL_STORAGE/**`、应用私有目录。
4. Manifest 权限：
   - `INTERNET`（本地回环/asset 协议需要）；
   - `READ_MEDIA_VIDEO`（Android 13+）；
   - `READ_EXTERNAL_STORAGE`（`maxSdkVersion=32`）；
   - `MANAGE_EXTERNAL_STORAGE`（首版 All-files 方案）；
   - `WAKE_LOCK`（播放时保持常亮）；
   - 若做后台转码：`FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_MEDIA_PLAYBACK`/`DATA_SYNC` + `POST_NOTIFICATIONS`。
5. 首启引导：检测 `Environment.isExternalStorageManager()`，未授权则跳 `Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION`，授权后重启文件扫描。

### 5.2 文件访问

- **首版**：All-files + 真实路径。把 `pick_video/pick_folder` 换成应用内文件浏览器：
  - Rust 新增 `list_dir(path)`（目录、视频、弹幕、字幕，排序，隐藏系统目录）；
  - 前端加一个模态浏览器：根目录 `/storage/emulated/0`，面包屑，点目录进入，点视频开播；
  - 保留“最近打开”列表（`localStorage`），减少每次翻目录。
- **缓存产物**：优先写视频同目录（与桌面一致）；若写失败，回退 `context.getExternalFilesDir(null)/BplayerCache/`，并在设置页显示真实路径。
- **以后上架**：把 `scan_folder/pair_danmaku/read_text/read_bytes/mkv_*` 的入口改成 `Source` 枚举（`Path(PathBuf)` / `Uri(String)`），URI 情况用 Kotlin 插件 `open_fd(uri) -> RawFd`，Rust `File::from_raw_fd`；ffmpeg 用 `/proc/self/fd/N` 或先转存小文件。第一版不要做。

### 5.3 播放链路

1. **URL**：`mediaUrl()` 继续 `convertFileSrc`；asset 协议已验证有 Range/CORS。
2. **自动播放**：Wry 默认关闭手势要求；仍要在 `desktopLoadVideo` 的异步链末尾保留 `art.play().catch()`，并准备“点一下画面继续”的兜底提示。
3. **全屏**：
   - 移动端把 Artplayer 配置改为 `fullscreen: false, fullscreenWeb: true`，用 CSS 全屏（容器 `position: fixed; inset: 0`）；
   - 进入全屏时调用原生方向锁定（横屏），退出恢复；
   - 如果必须原生全屏，需要在 Tauri Android 工程里自行实现 `onShowCustomView`（Wry 当前是取消的，不能靠配置解决）。
4. **画中画**：首版关闭 `pip`；后续接 Android PiP（`PictureInPictureParams`），需要原生插件。
5. **常亮**：播放中 `FLAG_KEEP_SCREEN_ON`（原生）或 `navigator.wakeLock`（WebView 支持度待测）。
6. **音频焦点**：来电/其他应用播放时暂停；用原生 `AudioManager` 监听，或在 JS 里监听 `visibilitychange` + `audiofocus` 插件。
7. **生命周期**：
   - `onPause` 暂停播放并取消转码（等价桌面 `Destroyed` 时杀 ffmpeg，`lib.rs:341-354`）；
   - `onResume` 恢复 UI 状态，不自动强播；
   - 屏幕旋转/折叠展开时重新计算 PGS 覆盖层（`videoContentBox` 目前假设容器铺满，`index.html:1672-1692`）。

### 5.4 编解码与 ffmpeg 侧车

1. **先测 WebView**（见第 6 节）。WebView 能解什么，决定 ffmpeg 要补什么。
2. **ffmpeg 打包**：
   - 使用 arm64 静态 ffmpeg，命名 `libffmpeg.so` 放入 `src-tauri/gen/android/app/src/main/jniLibs/arm64-v8a/`（必须以 `lib*.so` 命名，安装时才会解压到 `nativeLibraryDir`）；
   - `find_ffmpeg()` 改为：先 `nativeLibraryDir/libffmpeg.so`，再 PATH；路径通过 `ndk-context` + JNI 读取 `ApplicationInfo.nativeLibraryDir`；
   - Android 10+ 不允许从应用数据目录执行二进制，`nativeLibraryDir` 是可行位置；
   - 子进程生命周期：用 `std::os::unix::process::CommandExt::pre_exec` + `libc::prctl(PR_SET_PDEATHSIG, SIGKILL)` 替代 Windows Job Object；
   - 转码输出建议从 `.mka` 改为 **`.m4a`（AAC in MP4）**：WebView 对 MP4/AAC 的支持远好于 Matroska 音频；保留 `.mka` 作为兼容回退；
   - 继续 `-ac 2 -b:a 192k`：Android/WebView 对多声道 AAC 的支持同样不可靠；
   - 长任务放前台服务（通知栏进度），避免切后台被冻结/杀死；
   - 进度仍走 stdout `-progress pipe:1`，事件名不变。
3. **字幕/PGS**：
   - `mkv_sub`、`pgs_render` 直接复用；PGS 的 30 MB 内存与逐事件 PNG 在手机上可接受，但要测低端机/热稳定性；
   - PGS 覆盖层在 CSS 全屏、旋转、折叠屏切换后必须重新布局（现在是监听 `timeupdate/seeking/loadedmetadata/play`，`index.html:1739-1747`，没有 `resize`，需要补）。

### 5.5 Rust 命令逐项处置

| 命令 | 处置 |
|---|---|
| `fs_stat` | 保留（真实路径） |
| `pair_danmaku` | 保留 |
| `scan_folder` | 保留 |
| `read_text` / `read_bytes` | 保留 |
| `scan_subtitles` | 保留 |
| `probe_mkv_tracks` | 保留 |
| `transcode_target` | 保留；扩展名按平台改 `.m4a`/`.mka` |
| `transcode_audio_start` | 保留；换 ffmpeg 定位与子进程生命周期 |
| `extract_subtitle_text` | 保留 |
| `transcode_audio_cancel` | 保留 |
| `clean_sidecar_tmp` | 保留；若缓存改到应用目录，路径来源要跟着变 |
| `get_autostart` / `set_autostart` | Android 移除或 stub |
| `pgs_open` / `pgs_image` / `pgs_close` / `pgs_current` | 保留 |
| `pick_video` / `pick_folder` | 替换为 `list_dir` 浏览器或 dialog 插件 |
| `reveal_path` | 改为打开/分享缓存目录，或移除 |
| `sidecar_cache_files` | 保留；UI 文案改为“缓存管理器” |

### 5.6 前端改动清单

| 位置 | 改动 |
|---|---|
| `index.html:22` 字体 | 加 `system-ui, "Noto Sans CJK SC", sans-serif` |
| `index.html:39-43` `.wrap` | `height: 100dvh` + safe-area padding |
| `index.html:44-48` toolbar | 手机端两行/图标化；chips 可折叠 |
| `index.html:62-74` playlist | 手机端从右侧抽屉改为底部抽屉（或全屏列表） |
| `index.html:280-287` 滚动条 | 移动端隐藏 |
| `index.html:305-330` 占位层 | 文案从“拖入”改为“选择文件/文件夹” |
| `index.html:471` `isMobile` | 改为 `matchMedia` + `resize`/`orientationchange` 监听（折叠屏宽度会变） |
| `index.html:704-719` Artplayer | `fullscreen:false`、`fullscreenWeb:true`；**隐藏 pip**；全屏按钮改调 CSS 全屏（实测 HTML5 全屏被 Wry 取消） |
| `index.html:822-826` 占位点击 | 调 `openBrowser()`，不再 `pick_video` |
| `index.html:1095-1098` 路径函数 | Android 路径统一 `/`；保留兼容即可 |
| `index.html:1920-1927` 打开按钮 | 换成文件浏览器 |
| `index.html:1931-2004` 设置页 | 移除“开机自启”；“打开位置”改为缓存管理器；文案去 Windows 化 |
| `index.html:2042-2080` 拖放 | Android 不触发；保留作为桌面/模拟器能力 |
| `index.html:2082-2118` 事件 | 保留；转码事件名不变 |
| 全局 | 返回键：关面板 → 退全屏 → 退应用；`Escape` 逻辑复用 |
| 全局 | 触摸目标 ≥ 44px；hover 样式在触屏上会导致“粘住”，用 `@media (hover: hover)` 包住 |

### 5.7 安全与发布

- asset 协议只绑定本应用进程，不监听外网；若后续改本地 HTTP 服务，必须只绑 `127.0.0.1` 且带随机 token。
- All-files 权限只用于本地播放器，不上传、不联网；但 Play Store 审核会卡，侧载/企业分发没问题。
- ffmpeg 二进制会显著增大包体（约 20–40 MB/ABI），首版只打 `arm64-v8a`。
- 可加 `video/*` 的 `VIEW` intent filter，让文件管理器“用 Bplayer 打开”。

---

## 6. 真机验证（已执行）

### 6.1 设备基线

| 项 | 实测值 |
|---|---|
| 型号 / 品牌 | VER-AN10 / HONOR（Magic V2） |
| 系统 | Android 17，API 37 |
| CPU ABI | arm64-v8a，8 核 |
| 内存上限 | `navigator.deviceMemory = 8` |
| WebView | 151.0.7922.199（UA：`Chrome/151.0.7922.199 Mobile Safari/537.36`） |
| 屏幕 | 物理 2376×1060，408 dpi；横屏 CSS 视口 931×415，DPR 2.55 |
| 显示特性 | 系统 config 带 `hdr widecg`（HDR 广色域屏） |
| adb | USB + 无线均已连通；荣耀 logcat 只输出一条加密 `(HKS)`，诊断信息改为写文件 |

> 荣耀/Android 17 的一个坑：`adb logcat` 拿不到普通日志，`dumpsys dropbox --print data_app_crash` 仍可用；探针因此把日志写到 `/sdcard/Download/bplayer-probe.log`。移植版也应保留“文件日志”能力，而不是只依赖 logcat。

### 6.2 片源与弹幕基线

| 项 | 实测值 |
|---|---|
| 目标视频 | `/sdcard/Download/异形 契约.Alien.Covenant.2017.BD1080P.X264.AAC.English.CHS-ENG.Mp4Ba.mp4` |
| 大小 | 6,558,821,553 B（6.56 GB） |
| 容器/编码 | MP4 / H.264 + AAC（文件名可判定，且 WebView 直接可播） |
| 同名弹幕 | `.xml`，2,390,747 B，解析出 23,159 条（B 站格式） |
| 弹幕加载性能 | `fetch` 56 ms + 正则解析 9 ms（总 < 100 ms） |

### 6.3 探针工程（`probe/`，不碰 Bplayer）

纯 Java + 系统 WebView，不依赖 AndroidX/Kotlin，包名 `com.bplayer.probe`：

- 两个只绑 `127.0.0.1` 的 HTTP 服务：`8765` 页面、`8766` 媒体，**故意跨源**，模拟 Tauri 的 `tauri.localhost` 页面 + `asset.localhost` 媒体；
- 媒体端点实现 206 / `Content-Range` / `Accept-Ranges` / 回显 `Origin` / `Access-Control-Expose-Headers`，单次最大 16 MB；
- 页面 `<video crossOrigin="anonymous">`，静音自动播放后取消静音，接 `createMediaElementSource` + analyser 测 RMS，canvas 取平均亮度判断“是不是黑屏”；
- `onShowCustomView` 立即 `onCustomViewHidden()`，精确复刻 Wry 的 Android 行为；
- `ProbeLog` 写 `/sdcard/Download/bplayer-probe.log`；CDP（`adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>`）实时驱动/取证。

运行产物：`probe/run13-hdr.png`（HDR 播放截图）、`probe/device-probe.log`（完整日志）。

### 6.4 WebView 能力矩阵（实测）

| 能力 | 结果 | 说明 |
|---|---|---|
| MP4 H.264 + AAC | 可播 | 6.56 GB 目标片正常，seek 50%/10%/90% 均成功 |
| MKV H.264 + AAC | 可播 | `test-h264-aac.mkv` |
| MKV HEVC Main10 + AAC | 可播 | `test-hevc10-aac.mkv`，非黑屏 |
| MKV 4K HEVC Main10 + AAC | 可播 | `test-hevc10-4k-aac.mkv` |
| MKV HEVC 10bit HDR + DTS-HD MA + PGS | **视频可播、音频无声** | 真实 4K 片 `pan-real-6s.mkv`，3840×2076，luma 25.6；`webkitAudioDecodedByteCount=0` |
| 30 GB x265 10bit HDR 全片 | 视频可播 | Pan's Labyrinth 完整片头，3840×2076，0 dropped frames，luma 40.4 |
| AC-3 / E-AC-3 | 不支持 | `canPlayType` 返回空串，MSE 也不支持 |
| MKV + MSE | 不支持 | `MediaSource.isTypeSupported('video/x-matroska...') = false`；说明 MKV 只能走 `<video src>` 直接播放，不能拼 fMP4 流 |
| WebAudio + CORS | 可用 | 跨源 `crossOrigin=anonymous` + ACAO 后 analyser RMS 正常，不会变静音 |
| 外挂 AAC 音轨 | 可用 | 独立 `Audio` 播 `.m4a`，RMS 0.01776，与视频同步推进 |
| HTML5 全屏 | **不可用** | `requestFullscreen()` 触发 `onShowCustomView` 后立刻被取消；`document.fullscreenElement` 仍为 true 但视口不扩大 |
| PiP | 不可用 | `pipEnabled=false`，`requestPictureInPicture` 抛 `NotSupportedError` |
| 方向锁 | 不可用 | `screen.orientation.lock()` 抛 `NotSupportedError` |
| WakeLock | 可用 | `navigator.wakeLock.request('screen')` 成功 |
| 直接文件访问 | 可用 | `MANAGE_EXTERNAL_STORAGE` appop allow 后 `/sdcard` 读写、`read_dir` 正常 |

### 6.5 大文件 seek 记录与一个无效结论

- 16 MB 分片下，Pan's Labyrinth 30 GB 文件 seek 到 **714 s（已下载区间内）** 成功，耗时 4.0 s；小样本 MKV seek 在 62–453 ms。
- seek 到 3574 s / 6434 s 会超时，原因是该文件当时**仍在下载**（30.2 → 30.5 GB 持续增长），目标区间在本地文件里还不存在。这是数据不完整，不是 WebView 缺陷；等下载完成需复测一次收尾。
- 探针用的是 16 MB 分片，Tauri 的真实 asset 协议是 1 MB。1 MB 在 6.56 GB MP4 上已验证 seek 正常，但 30 GB MKV 的首次定位耗时需要在 P1 的真实 Tauri 工程里再测（这是目前唯一未闭环的播放相关项）。

### 6.6 P0 判定

| 判定项 | 结论 |
|---|---|
| MKV 容器 | 通过（直接 `<video>`，不能走 MSE） |
| HEVC 10-bit / 4K / HDR | 通过（硬解，颜色正常，0 掉帧） |
| 音频死编码 | 确认 DTS/AC3/EAC3 无声 → 必须外挂 AAC（桌面方案直接复用） |
| CORS / WebAudio 隔离 | 通过 |
| 存储 | 通过（All-files 可行） |
| 全屏 / PiP / 方向 | 全屏与 PiP 不可用，方向锁不可用；改 CSS 全屏 + 固定横屏 |
| 结论 | **A 路线成立**，不需要 Media3 混合；风险转移到构建链、ffmpeg 侧车与触摸 UI |

### 6.7 P1：真实 Tauri Android 工程复测

工程：`bplayer-android/`（本工作区，未触碰 Bplayer）。Tauri 2.12.5 + Gradle 9.6.1 + AGP 9.3.1 + NDK 28.2 + compileSdk 37 + minSdk 26，只打 arm64。debug APK 131 MB（含符号，release 会小很多）。

| 项 | 结果 |
|---|---|
| 构建链 | Rust 交叉编译 1 分 11 秒；Gradle 出 universal debug APK |
| Rust 命令 | `stat_file` / `probe_file` / `scan_dir` 直读 `/sdcard/Download`（24 个文件）正常 |
| asset URL | `http://asset.localhost/%2Fsdcard%2FDownload%2F...`（整段 URL 编码），页面源 `http://tauri.localhost/`，跨源保持 |
| MP4 6.56 GB | metadata 250 ms；seek 179 / 397 / 478 ms；RMS 0.02383；仅 1 丢帧 |
| Pan 35.5 GB MKV | 3840×2076，DTS 无声（ad=0），seek 715 / 726 / 247 ms，0–3 丢帧，HDR 颜色正常 |
| 4K HEVC 测试片 | 3840×2160，AAC 有声（RMS 0.088），141 帧仅 1 丢帧 |
| CSS 全屏 | 可用，视频铺满 931×415；系统状态栏/手势条仍在（需原生沉浸式再处理） |
| 结论 | **P1 通过，A 路线无阻塞**，可以进入 P2 搬播放器前端 |

踩坑记录（后续移植必须处理）：

1. Tauri 生成的 Gradle 任务会执行 `node tauri android android-studio-script`，工作目录是 `src-tauri`。若本工程没有可解析的 `tauri`，构建会报 `Cannot find module ...\src-tauri\tauri`。解决：项目本地安装 `@tauri-apps/cli`，并在 `src-tauri/tauri` 放一个转发脚本（`bplayer-android/src-tauri/tauri`）。
2. Tauri 2.12 模板要求 compileSdk/targetSdk 37，本机 SDK 需装 `platforms;android-37.0` + `build-tools;37.0.0`（`android-36` 不够）。
3. debug 构建默认不压缩，APK 131 MB；侧载可接受，release 要开 LTO/strip 并只保留 arm64。
4. 页面顶部工具栏被状态栏压住：Tauri 页面默认没有 safe-area 处理，P4 需要 `viewport-fit=cover` + `env(safe-area-inset-*)` 或原生沉浸式。

### 6.8 P2：前端搬入 + 手机界面重排

工程内 `ui/` 直接复制 Bplayer 的 `index.html` 与 `vendor/`（只读拷贝，不改 Bplayer），用 `ui/android-shell.js` 做 Android 壳，Rust 侧补齐 `fs_stat`/`pair_danmaku`/`scan_folder`/`scan_subtitles`/`probe_mkv_tracks`/`read_text`/`read_bytes`/`sidecar_cache_files`/`list_dir`，转码与 PGS 暂留桩。

**6.8.1 界面**

| 页面 | 设计 |
|---|---|
| 启动页 | 品牌区 + 两个 66px 主按钮（选择视频 / 选择文件夹）+ 右侧「最近播放」（localStorage，最多 5 条，路径归一化去重） |
| 播放页 | 视频 fixed 铺满，原生沉浸式隐藏状态栏/导航栏；顶部悬浮条：返回、标题（去扩展名）、弹幕数、弹幕开关、信息卡、播放列表；随 Artplayer 控制栏自动显隐 |
| 文件浏览器 | 全屏深色面板，52px 行高，快捷路径（Download / 内部存储 / Movies / 存储根） |
| 播放列表 | 右侧 340px 抽屉，条目 44px，点击换集后自动进播放页并收起 |
| 安全区 | 统一 `env(safe-area-inset-*)`；播放时 insets 由 39px 变 0，退出播放恢复，不写死 |

**6.8.2 真机结果（VER-AN10，931×415 CSS 视口）**

| 项 | 结果 |
|---|---|
| 启动页 | 正常，状态栏让位；最近播放跨进程保留 |
| 异形契约 MP4 6.56 GB | 点选后自动播放，23,159 条同名弹幕自动加载（277–295 ms） |
| 沉浸式 | `AndroidUI.setImmersive(true)` 生效，状态栏/手势条隐藏，insets→0；返回启动页后恢复 |
| 顶部悬浮条 | 随控制栏显隐；标题/弹幕数实时更新；弹幕开关注入插件 `hide()/show()` |
| 文件夹流程 | Download 扫描 10 集，抽屉换集后直接进播放页 |
| 返回键 | 文件浏览器 → 播放列表 → 播放页 → 启动页 → 退出应用，逐级消费 |
| 最近播放 | 第二次进入同一文件也能进播放页（同 URL 不触发 loadedmetadata，另有兜底） |

**6.8.3 新增实现**

- `MainActivity.kt`：`onWebViewCreate` 注入 `AndroidUI.setImmersive/exitApp`；`OnBackPressedDispatcher` 把返回键交给 `window.__aAndroidBack`；`onWindowFocusChanged` 重新收紧沉浸式。
- `android-shell.js` 拦截 `pick_video/pick_folder`；`initDesktop` 改为优先取 `window.__aInvoke`（Tauri 注入晚于脚本执行，不能提前读 `__TAURI__`）。
- 修正 Bplayer 桌面版遗留：`.playlist` 是 `.wrap` 子元素，被 `rise` 动画的 `transform:none` 填充帧覆盖，抽屉永远展开；移动壳用 `!important` 压回。`.stage` 同理会成为 fixed 后代的包含块，播放全屏必须落在 `.stage` 并清掉 transform。
- Artplayer `fullscreen/fullscreenWeb/autoOrientation/pip` 全关；`isMobile` 改为 `pointer: coarse` 或宽度 < 768。

**6.8.4 P2.5 手机界面第二轮**

- 方向：Manifest 改 `fullSensor`，新增 `AndroidUI.setLandscape(bool)`（`requestedOrientation`），仅播放页锁横屏、退出立即恢复跟随系统；竖屏首页用 `@media (orientation:portrait)` 改成品牌/按钮在上、最近播放在下。
- 信息条：桌面底部 `#infobar` 收进播放页顶栏的 `i` 信息卡，读取原 `#infoDuration/#infoRes/#infoSize/#infoCount/#infoParse/#infoTime`，卡内提供「音轨 / 字幕 / 弹幕屏蔽 / 设置」四个入口，转发到原 `#btnAudioEntry/#btnSubtitleEntry/#btnBlockEntry/#btnSettings`；无轨道时按钮置灰。
- 浮窗：屏蔽/音轨/字幕/密度面板统一改底部浮层（12px 边距 + 安全区，z-index 100050），设置页改全宽模态（100070），返回键优先关闭。
- 设置页隐藏 Windows 专用的「开机自动启动」，加注「转码待后续版本接入」；`optAutoAudio/optAutoSubtitle` 开关可见并可持久化，但 P3 前不会真正转码。

**6.8.5 P2 未做**

- 文件浏览器只列目录与视频，不单独选弹幕/字幕（依赖同目录自动配对）
- 无「填充/裁剪」切换，超宽片源上下留黑
- 首页不再强制横屏（P2.5 已改为 `fullSensor`，播放页才锁横屏）
- 转码、PGS、mkv_sub 仍是桩，遇到 DTS/位图字幕会提示待 P3

### 6.9 尚未验证（进入 P3）

- [ ] `mkv_probe` / `mkv_sub` / `pgs_render` 交叉编译到 arm64 后，真实片源上的轨表、稀疏字幕、PGS PNG
- [ ] ffmpeg arm64 侧车能否在 `nativeLibraryDir` 执行、转码性能与前台服务保活
- [ ] 23k 弹幕 + 4K 解码同时运行的帧率/发热
- [ ] 折叠屏展开/合拢、竖屏旋转时的布局与 PGS 对齐

---

## 7. 里程碑与工作量

| 阶段 | 内容 | 产出 | 预估 | 状态 |
|---|---|---|---|---|
| P0 | 真机探针（本文第 6 节） | 能力报告 + 路线判定 | 0.5–1 天 | **已完成**：A 路线成立 |
| P1 | 新工程 + NDK/target + Tauri Android 跑通空白页 | 可安装 APK | 1 天 | **已完成**：空壳 APK + asset 播放验证 |
| P2 | 文件浏览器 + All-files + asset 播放测试片 | 手机上能播目标片 | 1–2 天 | **已完成**：异形契约 6.56 GB + 23k 弹幕 |
| P3 | Rust 后端条件编译、ffmpeg arm64、音轨转码、字幕/PGS | 功能对齐桌面 | 3–5 天 | |
| P4 | 移动 UI、CSS 全屏/固定横屏/返回键/生命周期/折叠屏 | 可用性达标 | 2–3 天 | **大部分提前完成**：启动页/播放页/文件浏览器/沉浸式/返回键；剩折叠屏与填充模式 |
| P5 | 长片稳定性、性能、打包签名 | 可分发 APK | 1–2 天 | |
| 合计 | | | **8–14 天**（不含 Media3 回退） | |

Media3 混合方案（B 路线）在 P0 后被排除，仅当后续要求“上架/画中画/原生 HDR 元数据直通”时再评估，成本 +2–3 周。

---

## 8. 风险登记

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| WebView 不支持 MKV 容器 | **已排除** | — | 实测直接 `<video>` 可播（不能走 MSE） |
| HEVC 10-bit / 4K / HDR 发黑 | **已排除** | — | 实测硬解、0 掉帧、颜色正常 |
| DTS/TrueHD/AC3 无声 | **已确认（100%）** | 需外挂音轨 | 桌面方案直接复用；P3 打包 arm64 ffmpeg，转 AAC |
| Tauri asset 1 MB Range 在大 MKV 上拖动慢 | 中 | 体验差 | P1 用真实工程复测；必要时在 Rust 侧调大 Range 上限 |
| 触摸 UI 与 `isMobile` 判定 | **已解决** | — | 壳层改为 `pointer: coarse`，并重写启动页/播放页/文件浏览器；P4 只剩折叠屏适配 |
| HTML5 全屏 / PiP 不可用 | **已解决** | — | 播放页 `.stage` fixed 铺满 + 原生沉浸式（`AndroidUI.setImmersive`）；PiP 关闭 |
| 方向锁不可用 | **已绕过** | — | 首页 `fullSensor` 跟随系统；播放页经 `AndroidUI.setLandscape` 锁 `SENSOR_LANDSCAPE`，退出恢复 |
| NDK / Rust Android target 缺失 | **当前事实** | P1 无法开始 | 安装 NDK 27 + `rustup target add aarch64-linux-android` |
| ffmpeg 无法执行 | 中 | 音轨/字幕兜底失效 | jniLibs 打包；前台服务保活；备选 Media3 FFmpeg 扩展 |
| 折叠屏/旋转导致 PGS 错位 | 中 | 字幕错位 | 监听 resize/orientation，重算覆盖层布局 |
| 后台被杀/转码中断 | 中 | 长片转码失败 | 前台服务 + 断点/重试 |
| 4K HEVC 发热/掉帧（长片 + 弹幕） | 中 | 体验差 | 硬解已确认；长片压测；监测 dropped frames |
| 弹幕性能（23k 条） | 低 | 掉帧 | 解析已验证 < 100 ms；播放期压测 |
| 上架合规（All-files） | 高（若上架） | 被拒 | 侧载/自用；或改 SAF（+3–5 天） |

---

## 9. 需要确认的产品决策

1. **分发方式**：只侧载/自用，还是要上架？决定 All-files 还是 SAF（工作量差 3–5 天）。
2. **目标片源范围**：是否必须原样支持 4K HEVC 10-bit、DTS-HD/TrueHD 原轨、PGS？还是可以接受“首次打开转码/转封装”？
3. **最低 Android 版本**：建议 26+；Magic V2 本身 33/34。
4. **代码共享方式**：Bplayer 不能改，安卓版只能是新仓库/副本；后续桌面端更新如何同步（手动 cherry-pick，还是把 `src/index.html` 抽成共享包）？
5. **ABI**：首版只打 `arm64-v8a` 是否可以？

---

## 附录 A：只读核查证据索引

- 构建/配置：`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`、`src-tauri/capabilities/default.json`、`src-tauri/src/main.rs`
- 后端命令：`src-tauri/src/lib.rs:42-51、69-108、111-115、134-165、182-225、241-256、261-282、286-310、312-356`
- 转码：`src-tauri/src/transcode.rs:25-31、36-84、140-160、173-190、213-241、329-434`
- 自启动：`src-tauri/src/autostart.rs:5-70`
- 前端：`src/index.html:22、39-48、62-74、471、697-751、760-780、822-826、1090-1098、1126-1134、1180-1210、1299-1348、1442-1613、1636-1801、1811-1827、1846-1899、1920-2004、2042-2118`
- Tauri/Wry 源码事实：`tauri 2.12.5` `protocol/asset.rs`（CORS、206、1 MB 分片）、`webview/mod.rs:2697`（Android asset URL）、`wry 0.57.2` `src/android/main_pipe.rs:211`（自动播放）、`src/android/kotlin/RustWebViewClient.kt`（Range 包装）、`src/android/kotlin/RustWebChromeClient.kt:46`（全屏取消）

## 附录 B：P0 真机结果（已填）

- [x] 设备：VER-AN10 / Android 17 (API 37) / WebView 151.0.7922.199 / arm64 / 8 核 8 GB
- [x] 异形契约：MP4 6.56 GB，H.264 + AAC；同名 XML 2.39 MB、23,159 条弹幕
- [x] MKV：H.264、HEVC Main10、4K HEVC、10bit HDR + DTS-HD MA 均能出画面
- [x] 音频：DTS 完全无声；外挂 AAC + WebAudio 正常（RMS 0.01776）
- [x] seek：6.56 GB MP4 正常；30 GB MKV 已下载区间内 714 s 成功（4.0 s）
- [x] 全屏：不可用；PiP：不可用；方向锁：不可用；WakeLock：可用
- [x] 存储：All-files 直读 `/sdcard/Download` 正常
- [x] 路线判定：**A（Tauri Android 直移）**；Media3 混合暂不需要
- [x] 35.5 GB MKV 完成后补测：Tauri 内 10/50/90% seek 715 / 726 / 247 ms
- [x] Tauri asset 1 MB Range 真实拖动延迟：已测，无阻塞
- [x] P1 空壳工程构建、安装、Rust 命令、asset 播放全部通过
- [x] P2 真实前端：启动页/文件浏览器/播放页/沉浸式/返回键/最近播放全部通过
- [x] P2 异形契约：自动配对 23,159 条弹幕，播放 + 顶部悬浮条 + 沉浸式截图留档

## 附录 C：探针文件索引

| 文件 | 说明 |
|---|---|
| `probe/app/src/main/java/com/bplayer/probe/MainActivity.java` | WebView 宿主、权限、全屏取消、JS 桥 |
| `probe/app/src/main/java/com/bplayer/probe/ProbeServer.java` | 跨源 Range/CORS 模拟服务 |
| `probe/app/src/main/java/com/bplayer/probe/ProbeLog.java` | 文件日志（荣耀 logcat 不可用） |
| `probe/app/src/main/assets/probe.html` | 播放/seek/音频/全屏/弹幕解析测试页 |
| `probe/device-probe.log` | 真机完整日志（能力矩阵、seek、音频） |
| `probe/run13-hdr.png` | 30 GB HDR 片源播放截图 |
| `bplayer-android/` | Tauri Android 工程（Bplayer 前端副本 + 手机壳 + Rust 命令） |
| `bplayer-android/ui/android-shell.js` | 手机启动页、顶部悬浮条、文件浏览器、最近播放、沉浸式/返回键桥 |
| `bplayer-android/ui/index.html` | Bplayer 前端副本（仅改动移动适配与文案） |
| `probe/tauri1.png` / `tauri-pan.png` / `tauri-cssfs.png` | P1 空壳、35 GB HDR 播放、CSS 全屏截图 |
| `probe/m6.png` / `m8.png` / `m10.png` | P2 启动页、沉浸式播放（弹幕）、返回启动页 |
