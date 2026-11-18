# AGENTS.md

> **改完代码、验证通过后立刻维护本文件（AGENTS.md）——不要等提交。** 新增模块写进 §4「模块实现」，新踩的坑写进 §7「注意的坑」，行为有变就同步改已有描述。提交前再复核一遍，确保描述与最终代码一致。

本仓库是基于 Tauri 2 + WebView 的 Android 视频弹幕播放器。目标是播放本地与网络存储视频、自动加载同名弹幕与外挂字幕，并按手机习惯组织界面。

## 1. 改动范围

- 所有改动只允许落在当前项目目录内。
- 构建产物、依赖与调试文件均保留在当前项目目录内。

## 2. 目录

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

## 3. 架构要点

- **前端**：`index.html` 承载播放核心，`android-shell.js` 在它之前加载，负责手机布局与交互；不要重写播放器核心，优先复用现有 DOM/事件（如 `#btnOpenVideo`、`#btnAudioEntry`、`#btnBlockEntry`、`#settingsMask`、`#infobar` 的数值节点）。
- **选文件**：`window.__aInvoke` 拦截 `pick_video` / `pick_folder`，交由 `android-storage.js` 打开触摸文件浏览器。本地真实路径通过 asset 协议播放；`/@network/<id>/...` 虚拟路径通过原生网络桥与本机 Range 媒体代理播放。
- **Rust / audio commands**: Rust 只剩本地扫描与文本读取（`fs_stat` / `scan_folder` / `list_dir` / `scan_subtitles` / `pair_danmaku` / `read_text` / `read_bytes` / `pick_*` / `app_version` 及若干空实现桩）。**音轨探测、转码、内嵌字幕抽取、PGS 渲染全部随 0.2.0 下线**——libmpv 直接解码每一条音轨、libass 直接渲染每一条字幕轨（见 §4.9），`android-audio.js` 的 `probe()`/`select()` 在 mpv 模式下走 `track-list` + `setAid`。
- **原生桥**：`MainActivity.kt` 通过 `AndroidUI` 提供沉浸式、按视频尺寸选择方向、播放常亮、窗口亮度、媒体音量与退出能力。亮度只改当前窗口，退出播放恢复系统亮度；音量使用 Android 媒体音量，不用网页音量伪装。
  Native and top Back share `window.__aAndroidBack()`: touch-lock/resume decision, file-browser hierarchy, loading/pending-task cancellation, top overlay, playback origin, then app exit. Playback must restore its launch origin, not hard-code home or derive a directory from the media path. `__aAndroidBack()` 恒返回 true（退出应用是 JS 自己调 `AndroidUI.exitApp()`），所以原生侧 `dispatchBackToWeb()` 只把 "true" 当「网页接住了」：收到 null/false（页面没就绪 / 函数未定义）或 2 秒内回调始终不来时自行 `finish()` 兜底，否则冷启动白屏或页面 JS 异常时按返回键会完全没反应。
- **Navigation**: `android-navigation.js` owns registered layers; use open/close/clear rather than independent DOM toggles. `close()` 与 `clear()` 对栈内层都走 hide()+onClose()（clear 按出栈逆序补触发，否则 playlist 的 `playlistClosed()` 会被漏掉、folderOrigin 还原丢失）；不在栈里的层照旧一律 hide。 Information-card children restore their caller; direct controls return to playback. `AndroidFiles.takeSelection(path)` transfers a one-shot immutable browser snapshot; `restore(snapshot)` returns a picker promise. Episode changes retain the session origin; explicit folder lists retain their browser caller. See `research/navigation-return-rules.md`.
- **Sidecar selection**: Subtitle and danmaku pickers do not change the playback origin. Claim selection ownership only after a non-empty picker result; cancellation must preserve automatic loading. Valid manual choices invalidate older automatic results. Local and network text reads are bounded to 32 MiB. Stage a new subtitle track before replacing the current one, render cue text with textContent, and revoke tracks/Blob URLs on replacement or exit. ASS/SSA are text/time compatible only, not full styled libass rendering. Delay resets per video; style/language persist only through the explicit Save button.
- **Scope decisions**: PiP and hold-to-speed were declined. The subtitle batch adds no native media dependencies. After its commit, the user approved starting the Windows Bplayer audio-conversion port: convert only the selected unsupported audio track, keep the video unchanged and store the completed audio cache beside the video, including writable network sources. Background services remain deferred.
- **Subtitle layout**: Default to small (18 CSS px), no outline and the visible video picture's inside bottom, not the player window bottom. A below-picture option falls back inside when letterbox space is insufficient. Recompute from real video dimensions and contain/cover bounds on resize, fold, metadata, fit and control changes; persist position only through Save.
- **Audio conversion**: `AndroidAudioNative` serializes UUID session/permit/job tasks; a null jobId means session-wide cancellation, not the string `null`. Use job tombstones and source-configuration snapshots. The bound, non-exported `:audio_transcode` worker uses locked LGPL FFmpeg min plus its explicitly restored smart-exception dependency. Convert only selected audio to AAC-LC stereo 192k; final `Video (音轨N).mka` stays beside the source. Keep video audio isolated until its default track is known; stage/seek external audio before allowing sound. Never replace a source video or conflicting cache. Remote publication requires exclusive temporary creation and no-overwrite rename/MOVE; do not retry an ambiguous commit or reuse the playback connection pool. Private staging is capped at 512 MiB, cleaned on exit/replacement, and local disk preflight reserves two copies. See `research/audio-conversion.md`.
- **流式音轨（边转边播）**: 需要转换的音轨在整段落盘之前先走流式：worker 用 `STREAM` 命令把该轨单进程编成碎片化 MP4 写进 `cacheDir/stream/<jobId>.mp4`（`+frag_keyframe+empty_moov+default_base_moof`、1 秒一片、`-flush_packets 1`），主进程按 ISO-BMFF box 边界增量读、以 pull 方式交给前端 MediaSource 播放；首块约百毫秒级出声，不必等两分钟的整段转码。FFmpegKit 没有二进制 stdout（被日志接管），所以用增长文件代替管道；`SourceBuffer.timestampOffset` 已把这路流摆到视频时间轴，外挂元素的 offset 必须传 0。seek 到未缓冲位置、换轨、退出播放都要先停旧流（取消 ffmpeg + 删文件），一个 app 同时只允许一路；流式失败或 MSE 不可用时原样回落到整段转码。**停流是共享不变式，不是逐点纪律**：停流钩子挂在音频会话的 `resetTrack` 事件上（`select()` 的 cached / disabled / error 三个出口只 emit 它、根本不经过 `hooks.stream`），漏接一次旧 ffmpeg 就会在后台把整轨转完、增长文件写满整条 AAC；**eof 不代表可以不再重起**：整轨转完后 `trimStreamBuffer()` 已把播放头前 60 秒的缓冲 remove 掉，用户往回拖就是空洞，`scheduleStreamRestart()` 不能因为 `s.eof` 短路。详见 `research/audio-streaming.md`。
- **网络存储**：`AndroidNetwork` 提供异步请求和流式媒体 URL；连接凭据使用 Android Keystore 加密，网页只接收公开字段。SMB 仅启用 2.1/3.x，WebDAV 仅 HTTPS，SFTP 必须核对主机指纹；禁止跳过证书或指纹校验。详细结构见 `research/network-storage.md`。
- **方向策略**：Manifest 为 `user`。首页遵守系统旋转设置，禁止使用 `fullSensor` 绕过旋转锁。关闭系统自动旋转时播放保持当前方向；开启时，视频宽 > 高使用横屏，宽 ≤ 高使用竖屏。顶部“横屏／竖屏”是用户主动覆盖方向的入口，随控件显隐，不修改系统开关；退出或换片清除覆盖。等待真实视频尺寸后才选默认方向，退出播放恢复系统策略。
- **播放控制栏**：弹幕插件通过 `mount()` 固定到 `.mDanControls`，不要让窄屏自动把工具栏移到画面底边。顶部不再重复放弹幕开关；横竖屏的底部开关和设置均保留，控制区使用高不透明黑色背景。
- **播放会话**：**解码与发声都在本进程的 libmpv 里**（0.2.0 起）：mpv 把画面渲染到 WebView 底下的 `TextureView`，WebView 变透明只负责弹幕与控件。**字幕也归 mpv**：`sub-auto=fuzzy` 自动选容器 default 轨，libass 把文本字幕（含 ASS 样式）和 PGS 位图画在视频帧上，菜单切换走 `sid`、外挂走 `sub-add`——前端不再抽取 cue 文本。**音频焦点也由本进程持有**：`PlaybackAudioFocus.requestFocus()` 申请 `AudioFocusRequest`（`USAGE_MEDIA` / `CONTENT_TYPE_MOVIE`），`LOSS` 与 `LOSS_TRANSIENT` 一律暂停且**不自动恢复**（JS 侧 `pauseFor('focus-loss')`），`abandonFocus` / `onStop` / `close` 交还焦点。续播使用稳定文件路径记录，弹出继续/从头选择；触摸锁下只保留解锁入口，禁止亮度、音量和跳转手势。
- **libmpv 播放层**: `mpv/MPVView.kt` 持 `MPVLib` 并把 `Surface` 交给它，`mpv/AndroidMpv.kt` 是同步 `@JavascriptInterface` 桥（时间轴每帧要读，不能走请求/回复）。前端 `ui/android-native-timeline.js` 把 `<video>` 变成假视频（Artplayer 的 `option.proxy` 指向它），`ui/android-native-player.js` 负责 4Hz push 状态、打开/暂停/跳转转发、播放页透明与原生层显隐。详见 §4.9 与 §7 的前两条坑。
- **窗口适配**：按可用窗口而非设备型号识别大屏。宽度至少 720 CSS 像素时直出音轨、字幕、设置入口；宽且高至少 540 时首页与文件浏览双栏，短横屏仍紧凑布局。快捷按钮复用原入口的事件与可用性，不能复制两套轨道状态。
- **封面预览**：`AndroidThumbnails` 只接受稳定本地/网络路径，独立精确读取连接不复用媒体池；每任务最多请求 12 MiB，单次 64 KiB，启动后约 4 秒超时失败回占位，解码隔离在不可导出的 `:thumbnails` 服务。不得以无预算媒体 URL 或全文件扫描生成预览；最近播放只读私有封面缓存，不因打开首页连接 NAS。
- **Thumbnail fast paths**: Cache-only requests use a separate bounded local worker/queue, never the remote extraction queue. Decoder block fills remain within 64 KiB/read and 12 MiB/task. Playback frame capture must not open another video connection; validate JPEG size/dimensions before storing. Recent-history deletion removes only that history item, never its file, resume record or thumbnail. Hold-to-speed is explicitly excluded.
- **共享浏览**：新 SMB 来源共享名留空时使用 `scope=server`，路径为 `/@network/id/share/relative`；历史缺少 scope 的来源仍是绑定共享的 `scope=share`，禁止原 id 改 scope 重新解释续播路径。枚举可见不等于有目录读取权限，禁止降级 SMB1 或泄露密码。
- **播放常亮**：设置默认勾选，旧设置缺字段默认开启；原生窗口和 WebView 子视图常亮都受前台播放会话与用户选项约束，离开播放或后台释放，不修改系统熄屏时间。
- **安全区**：所有固定层用 `env(safe-area-inset-*)`，刘海/状态栏出现或沉浸式切换时自适应。
- **Mobile information actions**: The playback information card reuses desktop info nodes and provides audio, subtitle, manual danmaku, filtering and settings actions. Audio availability follows selectable tracks. Subtitle selection remains available during a valid playback session even when no automatic subtitle matched.

## 4. 模块实现

逐个模块记录：职责、对外接口、内部数据流、失败语义。**「为什么这么写」在 §7 注意的坑里**。

### 4.1 Rust 后端（现存 3 个 + 4 个已下线）

> **0.2.0 起下线**：`mkv_probe.rs` / `mkv_sub.rs` / `pgs_render.rs` / `http_range.rs` 以及它们
> 对应的 8 个命令（`probe_mkv_tracks`、`extract_subtitle_text`、`extract_subtitle_text_url`、
> `pgs_open`/`pgs_image`/`pgs_close`/`pgs_current`）已整体删除，`libpgs` / `png` / `ureq`
> 三个依赖同步移除。容器解析、文本字幕抽取和 PGS 解码现在都在 libmpv 里做，Rust 不再碰
> 媒体字节。源码留在 `tmp/parked-rust/` 备查，`lib.rs` 从 577 行降到 455 行。
> 下面这张表和两段细节保留下来，是为了解释「为什么曾经要这么写」。

大部分与桌面版同源（`H:\Project\Bplayer\src-tauri\src\`），这里只写**差异**。

| 文件 | 与桌面的关系 |
|---|---|
| `blocking.rs` | 完全相同：`spawn_blocking` 薄壳，命令 `async fn` + `*_impl` 同步本体 |
| `mkv_probe.rs` | 完全相同：纯 std 解析 EBML 的 Tracks / Duration |
| `mkv_sub.rs` | **同源 + 网络快路径**（见下） |
| `pgs_render.rs` | 同源，命令签名不同（见下） |
| `http_range.rs` | **Android 独有**：`HttpRangeReader` 把媒体代理当随机读源 |
| `lib.rs` | 命令集不同：多 `list_dir` / `extract_subtitle_text_url`；`reveal_path` / `autostart` / `transcode_*` 是**有意的空实现或桩**（Android 没这些能力，但前端仍会调用，不能删） |

**`mkv_sub.rs` 的网络快路径**（相对桌面多出来的部分）：

- `pub trait RandomRead: Read + Seek`，带 `fn prefetch(&mut self, ranges: &[(u64, u64)])` 默认空实现；`impl RandomRead for File {}` 让本地路径零改动。
- `sparse_extract_srt_reader<R: RandomRead>` 在拿到 Cues 后把所有 cue 要读的窗口一次性交给 `f.prefetch()`：每条 cue 一个 `[簇起点 + relative - 16, 2048)` 窗口（`PREFETCH_BLOCK_SLACK` / `PREFETCH_WINDOW`）。
- 逐 cue 解析走 `quick_block()`：不读簇头，在窗口里试 8 种簇元素头长度（`CDATA_MIN..=CDATA_MAX` = 5..=12）直接定位 block，时间戳用 `CueTime`；校验 track / rel_ts 范围 / 负载首字节可读。命中率 99.7%–99.9%，失败回退「读簇头 + 读块」的慢路径。
- 本地文件走默认空实现，行为与桌面版完全一致。

**`pgs_render.rs` 的命令差异**：`pgs_open(video_path, track)` → `PgsIndex`；`pgs_image(index)` → base64 PNG；`pgs_close()`；`pgs_current(t: f64) -> Option<u32>` —— 最后一个在桌面版是 `pgs_current() -> Option<(String, u32)>`（查文档归属），Android 改成**按播放时间点返回当前事件索引**，省一次前端二分。

**`lib.rs` 的 25 个命令**：`fs_stat` / `scan_folder` / `list_dir` / `scan_subtitles` / `pair_danmaku` / `read_text` / `read_bytes` / `probe_mkv_tracks` / `pick_video` / `pick_folder` / `reveal_path`(桩) / `get_autostart`(桩) / `set_autostart`(桩) / `sidecar_cache_files`(桩) / `app_version` / `transcode_target`(桩) / `transcode_audio_start`(桩) / `transcode_audio_cancel`(桩) / `extract_subtitle_text` / `extract_subtitle_text_url` / `clean_sidecar_tmp`(桩) / `pgs_open` / `pgs_image` / `pgs_close` / `pgs_current`。

**`http_range.rs`**（Android 独有的关键模块）：

- `HttpRangeReader::new(url, len)`：所有请求共用一个 `ureq::Agent`（连接复用），`BTreeMap<u64, Vec<u8>>` 存已取回的块。
- `read()` 循环读满（`Read` 允许短读，但 `mkv_sub` 假设一次读满）；`block` 大时（读头部 2 MiB / 读整个 Cues）**一次取够**，不按 32 KiB 分块。
- `prefetch()`：合并相邻窗口后 **4 路并发**（`PREFETCH_THREADS = 4`，实测饱和点）发出，失败的静默跳过、后续按需补读。
- 缓存预算收口在**唯一写入口 `insert()`**：同键覆盖先扣旧长度，超 `MAX_CACHE_BYTES`（96 MB）就淘汰**离当前 `pos` 最远**的块（`pos` 附近的块永远最后被删，正在读的位置不会被驱逐）。慢路径 `load()` 的按需读也走这里——只靠 `prefetch()` 里的预算管不住它，逐条 cue 每次垫 32 KiB，两千多条就能数倍越过上限，Android LMK 会直接收掉进程。
- `fetch_with()` 只接受 206；200 仅在 `start == 0` 时接受（RFC 7233 允许 Range 覆盖整个资源时回 200），其余 200 一律报错——上游忽略 Range 时把**文件头**当成偏移 `start` 处的数据会静默错位整条字幕抽取。

### 4.2 原生桥契约（JS ↔ Kotlin）

六个 `@JavascriptInterface`，全部在 `MainActivity.kt` 的 `setupWebView()` 里注册：

| JS 全局名 | Kotlin 实现 | 职责 |
|---|---|---|
| `AndroidUI` | `MainActivity` 内匿名对象 | 沉浸式、方向、亮度、音量、常亮、权限、`buildKind()` |
| `AndroidMpv` | `mpv/AndroidMpv` | libmpv 控制与状态（见 §4.9）。**同步返回**，不走下面的请求-回复协议 |
| `AndroidNetwork` | `AndroidNetwork` | 网络源 CRUD、浏览、文件系统命令、`mediaUrl()` |
| `AndroidThumbnails` | `AndroidThumbnails` | 封面请求 `request` / 结果回写 `store` / `cancel` |
| `AndroidPlaybackAudio` | `PlaybackAudioFocus` | 前台播放会话许可、耳机断开、后台暂停 |
| `AndroidUpdate` | `UpdateChecker` | 更新检查 / 下载 / 安装 + `state()` |

**异步请求-回复协议**（除 `AndroidUI` 外都走这套）：

```
JS:  bridge.request(id, command, JSON.stringify(args))
Kotlin: reply(id, ok, payloadJson)  ->  JS 侧按 id 找到 pending Promise 并 settle
```

- `id` 是 JS 生成的 UUID；`AndroidPlaybackAudio` 是同步布尔返回，不走这条链。
- **信任检查**：每个桥的 `request` 第一行都要求 `trustedPage()`（`http://tauri.localhost`），否则直接丢。
- **每条桥是单链**：有请求在跑时再发会被直接拒绝（前端也要自己挡，见 §7）。

### 4.3 音轨处理链（已下线）

> **0.2.0 起整条链下线**：libmpv 直接解码容器里的每一条音轨（DTS / TrueHD / AC-3 / E-AC-3…），
> 切换就是 `set aid <id>`，既不转码也不落盘。`AudioDecodeService` / `AudioWorkerClient` /
> `AudioMedia` / `AndroidAudioNative` 及 `:audio_transcode` 服务已移出编译
> （源码在 `tmp/parked-audio/`），前端 `android-audio.js` 的 `probe()` / `select()` 在
> `window.AndroidMpv` 存在时直接读 `track-list` 并 `setAid`，走不到下面的链路。
> 保留这段是为了解释历史上的缓存命名、指纹和远端发布语义；不要再往里加逻辑。

```
android-audio.js  ──(request)──▶  AndroidAudioNative  ──(Messenger)──▶  AudioDecodeService
      │                                  │                                   │
      │                                  └── AudioMedia / AudioSourceAccess │
      │                                                                      ├─ convert(): 分片并行 5 段（网络 3 段）→ assemble
      └── 挂载：<audio> 直连本地 mka 或 MSE 流（STREAM）                        ├─ STREAM: 边转边写 cacheDir/stream/<jobId>.mp4
                                                                              └─ 产物先 .tmp. 再原子 rename
```

**命令清单**（`AndroidAudioNative`）：

| 命令 | 说明 |
|---|---|
| `audio_probe` | ffprobe 轨道表 + 时长（走 worker） |
| `audio_prepare` | 校验缓存 / 算指纹 / 发 permit，返回 `{ jobId, target, cached, offset }` |
| `audio_start` | 起任务（分段转码 或 STREAM 流式） |
| `audio_cancel` | 取消；`jobId` 为 null 表示**会话级**取消 |
| `audio_cache_files` | 列已有音轨缓存 |
| `network_subtitle` | 网络源字幕的 ffmpeg 顺序抽取兜底 |
| `audio_stream_open` / `read` / `close` | 流式音轨：主进程按 ISO-BMFF box 边界增量读 worker 写的增长文件 |
| `subtitle_reader` / `subtitle_reader_close` | 建一个 64 KiB 预读的本机媒体代理 URL 给 Rust 稀疏抽取用 |

**模块分工**：

- `AudioDecodeService.kt`（873 行）—— 独立进程 `:audio_transcode` 的 worker。负责 ffprobe、分段转码、拼接、STREAM 流式写文件、大小上限监控（512 MiB）、超时。**不导出**，主进程只能过 Messenger 说话。
- `AudioWorkerClient.kt` —— 主进程侧的 Messenger 客户端：`bind` / `call(command, bundle, cancellation)` / `close`。
- `AudioMedia.kt` —— 缓存语义：`validCache()`（严格要求**单条 AAC 2ch** + 时长误差 + tags 指纹）、`checkSpace()`（估算 + 2× 预留）、`AudioSourceAccess`（本地路径或网络字节源，统一出 `input()` URL）。
- `AudioCacheTransfer.kt` —— 远端缓存发布：临时文件 + 精确 rename，绝不覆盖已有文件。
- `android-audio.js`（330 行）—— 前端状态机：会话/世代、隔离原音轨、切轨、流式 MSE、缓存命中。

**关键数据**：mka 命名 `{stem} (音轨N).mka`（N 1-based），落**视频同目录**；私有 staging 在 `cacheDir/audio-transcode/`，上限 512 MiB，退出/换片清理。

### 4.4 网络存储（9 个 Kotlin）

```
android-storage.js ─▶ AndroidNetwork ─▶ NetworkConnections ─▶ Smb/WebDav/SftpNetworkRemote
                            │                    │
                            └─ mediaUrl() ─▶ NetworkMediaServer（本机 NanoHTTPD Range 代理）─▶ NetworkRemote.open()
```

**数据模型与路径**（`NetworkModels.kt`）：

- `NetworkSource { id, protocol("smb"/"webdav"/"sftp"), host, port, share, root, scope, username, domain, secretRef }` —— **密码从不进网页**，`NetworkSourceStore` 用 Android Keystore 加密，网页只拿得到公开字段。
- `NetworkPaths.parse("/@network/<id>/<relative>")` → `{ id, virtual, relative }`，是前端虚拟路径与原生相对路径之间的唯一转换点。
- SMB 新来源共享名留空时 `scope = "server"`（路径 `/@network/id/share/relative`）；历史来源缺 scope 仍是 `scope = "share"`，**禁止用原 id 改 scope 重新解释续播路径**。

**连接池与读写**（`NetworkRemote.kt`）：

- `interface NetworkRemote { list / stat / open(relative, start, length, total, prefetchBytes) / readAtExact / publishAudioCache }`。
- `PositionedNetworkStream`：NanoHTTPD 每次只读 16 KiB，这里按 `prefetchBytes`（默认 4 MiB、字幕读取器 16 KiB）放大远端读，否则局域网吞吐被锁在个位数 MB/s。
- `NetworkRole` 四态：`METADATA` / `MEDIA` / `THUMBNAIL` / `TRANSCODE` —— 不同角色走**不同连接**，互不堵。
- `NetworkConnections`：按 `Key(id, role, share)` 分槽，每槽一个常驻 remote + `ReentrantLock.tryLock(3s)`（拿不到就报「此网络连接仍在处理请求」）。`watch()` 包住读流：瞬时错误（断连/超时）时失效该连接并让下次重连。
- `isTransientNetworkFailure()` / `safeNetworkError()`：把 smbj 的 `SMBApiException`、sshj 的 `SFTPException` 等翻译成用户能看懂的中文（含 SMB 状态码对照表）。

**三种协议实现**：

| 文件 | 要点 |
|---|---|
| `SmbNetworkRemote.kt` | smbj，只启用 SMB 2.1/3.x + 签名；复用 `mediaFile` / `exactFile` 句柄省 CREATE 往返；`checked()` 逐段检查路径，禁止重解析点/符号链接 |
| `WebDavNetworkRemote.kt` | 仅 HTTPS；发布用条件 PUT `If-None-Match: *` + `MOVE`；不接受重定向或无条件覆盖 |
| `SftpNetworkRemote.kt` | sshj；必须核对主机指纹，禁止跳过 |

**本机媒体代理**（`NetworkMediaServer.kt`）：

- NanoHTTPD 绑 `127.0.0.1` 随机端口，URL 里带 32 字节随机 token（Base64），并校验 `Origin: http://tauri.localhost` 与 `Host`。
- 只处理 `GET` / `HEAD` / `OPTIONS`，解析 `Range` 后转成 `NetworkRemote.open()`，响应带 `Content-Range` / `Accept-Ranges`。
- `BoundedRunner`：**固定线程数**的 `ThreadPoolExecutor` + `SynchronousQueue`（满了直接拒绝，不排队）。默认 8 线程；字幕读取器专用实例用更大池。

**JS 桥**（`AndroidNetwork.kt`）14 个命令：`network_sources` / `network_save` / `network_remove` / `network_test` / `network_smb_shares` / `network_discover_smb` / `network_permission` / `fs_stat` / `list_dir` / `scan_folder` / `scan_subtitles` / `pair_danmaku` / `read_text` / `read_bytes`，外加同步 `mediaUrl(path)`。

### 4.5 缩略图（4 个 Kotlin + 1 个 JS）

- `ThumbnailCore.kt` —— 解码核心：从视频块取帧、校验 JPEG 尺寸后存缓存。
- `ThumbnailDecodeService.kt` —— 独立进程 `:thumbnails`，解码与主进程隔离（防大图 OOM 拖死播放）。
- `NetworkThumbnailSources.kt` —— 网络源的独立精确读取（**不复用媒体池**）。
- `AndroidThumbnails.kt` —— JS 桥：`request(id, command, args)` 发任务、`store(id, args)` 回写结果、`cancel(id)` 取消。
- `android-thumbnails.js` —— 可见项调度：只对当前视口附近请求、滚动/离开即取消、最近播放优先读私有封面缓存。
- **预算硬约束**：每任务最多 12 MiB、单次读 64 KiB、启动后约 4 秒超时失败回占位；不因打开首页连 NAS。

### 4.6 更新检查（`UpdateChecker.kt`，737 行）

- 数据源：`https://api.github.com/repos/tiny-andr/android-danmuku-video-player/releases/latest`，只认 `draft=false / prerelease=false`，tag 解析成版本号比大小。
- **按构建类型分轨**：debug 包只匹配文件名 `contains("debug")` 的 APK，release 包反之（两个包签名/包名不同，跨轨装不上）。改名不影响这条逻辑。
- 命令：`check` / `download` / `cancel` / `install` / `state`（只读快照，不联网）/ `download_for_test`（仅 debug 构建）。
- 下载支持镜像回退（`ghfast.top`、`gh-proxy.com`、`ghproxy.net`、`ghproxy.site`），校验官方 `digest` 后安装。
- 超时：`API_TIMEOUT_MS` 20 s；下载 `CONNECT_TIMEOUT_MS` 10 s / `IDLE_TIMEOUT_MS` 30 s。
- **启动时静默检查**：`index.html` 在页面初始化完 900 ms 后调一次 `startUpdateCheck(true)` —— 失败不打扰，有新版本才弹确认框，**不自动下载**。

### 4.7 宿主与播放会话

- `MainActivity.kt`（342 行）—— 宿主 + `AndroidUI` 桥。`setupWebView()` 注册全部 6 个 JS 接口。
  - **方向策略** `applyPlaybackOrientation()`：`home` → `USER`；用户手动覆盖 → `LANDSCAPE` / `PORTRAIT`；系统自动旋转关 → `LOCKED`；否则按画面形状 `USER_LANDSCAPE` / `USER_PORTRAIT`。
  - **软横屏（大屏兜底）**：Android 16+ 在 `sw >= 600dp` 的屏幕上**直接丢弃** `setRequestedOrientation`（`targetSdk` 降到 35 也照样丢，实测 ColorOS 不按 targetSdk 判断），平板上的「横屏」按钮因此无效。前端 `__softLandscape(on)` 兜底：`video-rotate=90` 让 mpv 先转画面再按新宽高 contain（宽度自然铺满），弹幕层加 CSS `rotate(90deg)` 跟随，控制条与顶栏保持竖持布局——**触摸坐标不用重映射**，Chromium 自己处理 CSS transform 的命中测试。按钮逻辑：先请求系统旋转，1.2s 后窗口仍是竖的才落到软横屏，所以手机上行为完全不变。见 §7 的软横屏三条坑。
  - **沉浸式**：`WindowInsetsControllerCompat.hide(systemBars)` + 旧 `systemUiVisibility` 全屏位（任务栏仍按导航栏缩窗口时补这一层）。
  - **存储权限**：`hasAllFilesAccess()` / `requestAllFilesAccess()`，没有 `MANAGE_EXTERNAL_STORAGE` 时浏览器是空白目录，必须先引导。
  - **构建戳**：`buildKind()` 返回 `"debug MMdd-HHmm"` / `"MMdd-HHmm"`（`BuildConfig.BUILD_STAMP`，两个包同一次构建用同一个值）。
- `PlaybackAudioFocus.kt` —— 前台会话许可 + **系统音频焦点** + 耳机断开 + 后台暂停。`requestFocus()` 申请 `AudioFocusRequest`（`USAGE_MEDIA` / `CONTENT_TYPE_MOVIE`，`GAIN`），`LOSS`/`LOSS_TRANSIENT` 走 `notify(session, "focus-loss")` → JS `pauseFor` 暂停且不自动恢复；`abandonFocus`/`onStop`/`close` 都会 `abandonAudioFocusRequest`。真机核对方式：`adb shell dumpsys audio | grep -A2 'audio focus'`，栈顶应是本应用且 `gain: GAIN`。
- `android-shell.js`（1093 行）—— 手机壳：启动页、播放页顶栏、信息卡、版本行、`__aAndroidBack()` 返回键分层决策。
- `android-gestures.js` —— 播放区亮度/媒体音量手势、双击跳转、触摸锁仲裁。
- `android-player-tools.js` —— 续播弹层、锁屏、适应/裁剪、原生音频会话接线。

### 4.8 前端其余模块

| 文件 | 职责 |
|---|---|
| `index.html`（约 3100 行） | 播放核心：Artplayer 装配、B 站弹幕、字幕菜单、音轨菜单、网络源适配。0.2.0 起解码/音轨/字幕都交给 libmpv，MSE 流式与 PGS 贴图层已删除 |
| `android-storage.js`（702 行） | 触摸文件浏览器 + 网络连接表单；拦截 `window.__aInvoke` 的 `pick_video` / `pick_folder` |
| `android-sidecars.js` | 有界文本解码（32 MiB 上限）、字幕规范化、语言偏好排序 |
| `android-subtitle-view.js` | 字幕轨原子加载（先 stage 再替换）、`textContent` 安全渲染、每片重置延时 |
| `android-navigation.js` | Overlay 栈：注册/打开/关闭/清理；返回键层级与滚动锚点 |
| `android-resume-store.js` | 断点记录 `bplayer.android.resume.v1`（本地/网络路径分存） |
| `android-file-order.js` | 自然文件名 / 修改时间 / 类型排序 |

### 4.9 libmpv 播放层（0.2.0 起）

| 文件 | 职责 |
|---|---|
| `mpv/MPVView.kt` | `TextureView` 子类，持 `MPVLib`。`initialize()` 建实例并在 `init()` 前设 option（`vo=gpu`、`gpu-context=android`、`hwdec=mediacodec`、`osd-level=0`、`sub-auto=fuzzy`）；`onSurfaceTextureAvailable` 里 `attachSurface` + 重开 VO。**必须是 TextureView，不能是 SurfaceView**（见 §7 第一条） |
| `mpv/AndroidMpv.kt` | 同步 `@JavascriptInterface` 桥。`open/timePos/duration/paused/eof/play/pause/seekTo/setRate/setVolume/setMute` + `tracks()`（mpv 的 `track-list` JSON 原样透传）+ `setAid/setSid/addSub/addAudio/setSubDelay/setSubScale` + `debug()`（`vo` / `vo-configured` / `hwdec-current` / `surfaceCreates` / `attaches` / `attachValid`，真机排查专用） |
| `ui/android-native-timeline.js` | 假视频垫片：用一个不加载媒体的 `<video>` 承载 DOM 与事件，`defineProperty` 覆盖 12 个属性 + 4 个方法，provider 从桥取值。seek 期间按「目标 + 陈旧帧」状态机丢弃迟到帧 |
| `ui/android-native-player.js` | 接线层：4Hz push 状态、`open()/close()`、`__mpvFileLoaded` / `__mpvEndFile` 回调、播放页 `body.aplaying` 与 `AndroidUI.setVideoVisible` 联动 |

命令通道统一走 `MPVLib.command(arrayOf(...))`：切轨 `set aid|sid <id>`（`no` = 关）、跳转 `seek <秒> absolute`、外挂轨 `sub-add` / `audio-add`。

**音轨菜单**：`android-audio.js` 的 `probe()` 在 `window.AndroidMpv` 存在时直接读 `tracks()`，`select()` 直接 `setAid`——不跑 ffprobe、不转码、不建缓存。旧的 `AndroidAudioNative` 转码链整体移出编译（源码在 `tmp/parked-audio/`）。

## 5. 构建与安装

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

## 6. 已验证 / 已知限制

已验证：异形契约（6.11 GB MP4，1920×1080）播放；23,159 条 B 站弹幕 271–293 ms 解析；竖屏首页与横屏播放切换；沉浸式；文件夹 10 集连播；同源换集；返回键层级；最近播放去重；信息卡与设置页手机布局。

Audio conversion now works through the Android native bridge: local DTS/TrueHD/AC-3 fixtures and a real SMB same-directory write/cache-reuse path were verified. Streaming audio (fragmented MP4 + MediaSource) is verified on local DTS/DTS-HD fixtures and a real SMB AC-3 source, including seek restart, track switching and exit cleanup. Embedded text subtitle extraction is verified on local and NAS sources; remote sparse read measured ~17 s for a 843-cue track on a 7.5 GB title (details in research/subtitle-timing-calibration.md). PGS bitmap subtitles are verified via libpgs. AC-4/DRA are not certified; unsupported converters fail explicitly. WebDAV/SFTP publishing code is compiled and covered by shared transfer tests but has not been certified against a live server. Read-only sources or servers missing safe conditional publication/mtime fail without overwriting files. The source fingerprint is bounded, not a full cryptographic file scan.

## 7. 注意的坑

- **`SurfaceView` 在 Tauri 里永远显示不出来，必须用 `TextureView`**（2026-11-18 实测，代价是五轮排查）。现象极具误导性：mpv 报 `vo=gpu configured=yes`、`attaches=2 attachValid=true`、`hwdec=mediacodec`、`android-surface-size` 正确，屏幕却全黑。根因是 Tauri 的 WebView 走自己的 `SurfaceControl` 合成层，那一层恒定压在 `SurfaceView` 的 media sublayer 之上，页面透明与否都挡。`setZOrderMediaOverlay(true)` 和 `setLayerType(LAYER_TYPE_HARDWARE)` 都无效；`setZOrderOnTop(true)` 能出画面但会把弹幕整个盖住。换成 `TextureView`（普通 View，走常规合成顺序，加在 content 的 index 0）才通。**另外 `TextureView.setBackgroundColor()` 会抛 `UnsupportedOperationException`**，别拿它做诊断填充。
- **假 video 的方法必须可写**：垫片的 `define()` 只设了 `configurable`，Artplayer 在某些路径上会给 `$video.play` 重新赋值，报 `Cannot assign to read only property 'play'`。`define()` 里要补 `writable: true`。
- **`currentTime` 变量不在 `setVideoFromUrl` 的作用域里**：想给 mpv 传路径只能在调用点（`loadVideoSource`）拿 `path` 自己算——本地路径原样传，`/@network/...` 必须先转成 `mediaUrl(path)`（`asset://` 是 WebView 私有协议，mpv 读不到）。
- **mpv 加载完再 `play()` 会让播放器停在 0**：`loadfile` 之后、文件就绪之前落下的 `pause=false` 会被后续状态覆盖，表现为「加载完了但停在 0 秒」，30 秒后 `android-shell.js` 的加载看门狗弹"连接或缓冲超时"。要在 `open()` 里**先** `bridge.play()` 再等加载。
- **垫片在暂停态不发 `timeupdate`**（弹幕循环要停），但进度条和时间显示只认这个事件；暂停中拖动进度条必须由接线层补发一次 `emitTimeupdate()`，否则 UI 停在旧秒数。
- **`sub-pos` 的百分比基准是「视频画面」，不是窗口**：竖屏 letterbox 时按窗口高度折算（例如算出 62）会把字幕摆到画面中间；`100` 本身就是画面底边。老版 `AndroidSubtitleView.placement()` 那套「先算 contain 后的画面矩形、再定位」的换算在 mpv 这边不适用，直接用默认 100。
- **软横屏只能让 mpv 转画面，不要让 View 转**：`TextureView.rotation + scaleX/scaleY` 会把画面缩成竖长条，`Matrix.postRotate + postScale` 会缩成方块——两者都是「先把画面 contain 进竖窗口的位图，再旋转那张图」，比例已经丢了。`video-rotate=90` 是 mpv 先转画面再按新宽高 contain，宽度自然铺满。
- **`setRequestedOrientation` 在 `sw>=600dp` 上被系统硬丢**：Android 16 官方文档写的是「以 API 36 为目标平台的应用」，但实测 ColorOS 对 `targetSdk=35` 的应用照样忽略（`h1318dp` + `ROTATION_0` 纹丝不动），把 Manifest 的 `screenOrientation` 删成 `unspecified` 也没用。别在这条路上继续试，直接走软横屏。
- 这台设备（荣耀 VER-AN10）的 **logcat 全程被厂商加密**，`adb logcat` 读不到任何应用日志。排查只能靠：把状态暴露成 `@JavascriptInterface` 方法用 CDP 读，或 `Thread.setDefaultUncaughtExceptionHandler` 把堆栈写到 `getExternalFilesDir()/crash.txt` 再 `adb shell cat`。
- `.stage` 等元素带 `animation-fill-mode: both` 的 identity `transform` 会形成 containing block，fixed 后代无法全屏；全屏规则必须落在 `.stage` 上并清 `transform/animation`。
- 原 CSS `#aFileMask{display:flex}` 会压过 `[hidden]`，需要 `#aFileMask[hidden]{display:none!important}`。
- 播放列表曾因同样的 animation transform 永远展开，必须用 `!important` 压回 `translateX`。
- 弹幕/字幕/音轨浮窗在桌面是 `position:fixed; right:16px; bottom:64px`，手机上统一改成底部面板，z-index 必须高于全屏舞台。
- WebView 中 `crossOrigin` 媒体与 asset 协议有关；Range 上限约 1 MB。
- 音轨「停流」只写在 `hooks.stream` 里是不够的：`select()` 命中缓存（cached）、自动转换已关闭（disabled）、prepare 抛错（error）三个出口都不经过 `hooks.stream`，所以停流必须接到音频会话的 `resetTrack` 事件上。实测（真机、debug 包）：流式在播时切轨，修的正是这条钩子——`__bplayerStream()` 必须在切轨后变回 `null`，否则旧 ffmpeg 会继续把整轨转完。
- 流式转完后 `s.eof = true`，此时 `MediaSource.readyState` 已是 `ended`，`trimStreamBuffer()` 直接返回 false（`SourceBuffer.remove` 在 ended 后会抛 InvalidStateError）——也就是说 **eof 之后不会再回收任何缓冲**，而被回收掉的播放头前 60 秒永远补不回来。往回拖必须重起一路流，`scheduleStreamRestart()` 里那行 `s.eof` 短路就是「转完再看片头 = 永久静音且无提示」的根因。
- 手机上的 ffmpeg 只有 **约 2x 实时**（真机实测：600 秒 AC3 片转 AAC，一分钟只推进约 130 秒音频），比桌面慢一个量级。这意味着：整段转码回退路径在一集 45 分钟片子上要跑 20 分钟以上；验证 eof 相关逻辑时不要按桌面速度估时间，几百秒的测试片就要等一两分钟。
- 无线调试的 `5555` 端口会随手机休眠掉线（表现为 `adb: device not found`，`adb shell` 静默返回空）。探针脚本不要硬编码 `-s 192.168.1.6:5555`，应遍历 `adb devices` 里处于 `device` 状态的通道逐个试 `pidof`，用能跑通的那条。
- WebView 的 devtools socket 只有 **debug 包**才有（形如 `@webview_devtools_remote_<pid>`）；release 包只剩一个不可连的 `@chrome_devtools_remote`。所以 CDP 真机验证一律装 debug 包，release 包只做功能抽查。
- 上传 APK 到 GitHub Release：debug 包必须排在正式包**下面**，但 GitHub 的资产列表**按文件名排序、不是上传顺序**（上传先后对显示毫无影响）。`Bplayer-Android-0.1.4-debug.apk` 与 `Bplayer-Android-0.1.4.apk` 在第 21 个字符处是 `-`(0x2D) vs `.`(0x2E)，`-` 更小，所以 debug 会永远顶在最上面、用户一眼点错（debug 包带 `.debug` 包名、与正式包不覆盖安装、体积大一倍）。修法是把版本号后移：debug 命名成 `Bplayer-Android-debug-<ver>.apk`，正式包是 `Bplayer-Android-<ver>.apk`，这样 `0`(0x30) < `d`(0x64)，正式包才排前面。`UpdateChecker` 用 `contains("debug")` 区分轨道，改名不影响自动更新。
