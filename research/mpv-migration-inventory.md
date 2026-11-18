# WebView 补偿代码盘点 → libmpv 迁移删除 / 保留清单

> **性质**：只读盘点。本文件是唯一新增文件，未改动任何源码，未执行 git commit / push。
> **对象**：`H:\Project\android-danmuku-video-player`（Tauri 2 + Rust + Kotlin + WebView，`<video>` + MSE 播放）。
> **目的**：把"为了绕开 WebView/Chromium 限制而写的全部补偿代码"逐项定位、判定去留，供解码引擎换成 libmpv 时照单执行。

---

## 0. 口径与实测方法

### 0.1 行数口径

行数一律按任务要求用 PowerShell 实测：

```powershell
(Get-Content <file> | Measure-Object -Line).Lines    # 记为「实测行数」
(Get-Content <file>).Count                           # 记为「物理行数」
```

两者**不相等**：`Measure-Object -Line` **不计完全空的行**（纯空白行仍计入）。已用样本验证：内容为 `a` / 空行 / `b` / 三个空格 / `c` 的 5 行文件得到 `Line=4, Count=5`；内容只有一个空格的文件得到 `Line=1, Count=1`。本文表格同时给两个数：**判定"删多少行"时用物理行数**（因为删除是按行区间整段删的，空行跟着走），引用 AGENTS.md 里既有数字时按实测行数对齐。

### 0.2 限制编号

下文用 `W1..W11` 指代这些"WebView 做到不、所以要自己补"的具体限制：

| 编号 | 限制（WebView / Chromium / Android 侧的真实约束） |
|---|---|
| **W1** | `<video>` 解不了 DTS / DTS-HD / TrueHD / AC-3 / E-AC-3 / LPCM / AC-4 / DRA，只能解 AAC / MP3 / Opus / Vorbis / FLAC |
| **W2** | `<video>` 一次只播一条音轨，**无法切轨**；也没有"读出容器里有哪些轨"的能力 |
| **W3** | 系统音频焦点由 WebView/Chromium 进程持有，应用侧拿不到 `AudioFocusRequest`（这是 `PlaybackAudioFocus` 只敢叫"会话许可"的原因） |
| **W4** | MSE 只吃增量 `SourceBuffer`，没有"给个文件路径自己播"的接口 |
| **W5** | FFmpegKit 把 stdout 当日志接管，拿不到二进制管道 → 只能"写增长文件 + 别人读" |
| **W6** | Chromium 不认 PGS（蓝光位图字幕），一个字都画不出来 |
| **W7** | Chromium 只吃 WebVTT 纯文本，ASS/SSA 的样式、定位、特效全部丢弃（现状是"文本/时间兼容"，不是 libass） |
| **W8** | WebView 侧拿不到 MKV 内嵌字幕轨的字节，只能靠原生侧解析容器 |
| **W9** | Android 没有可挂载的 SMB/WebDAV/SFTP，网络字节只能过本机 NanoHTTPD 的 Range 代理；一次远端小读 = 一次 HTTP 往返 |
| **W10** | 跨域（`asset.localhost` ↔ `tauri.localhost`）媒体在 `createMediaElementSource` 里会被 Chromium 按规范静音，必须 `crossOrigin='anonymous'` 才有输出 |
| **W11** | `SourceBuffer` 有配额上限，长片必须定期 `remove()` 回收，且 `ended` 之后再 `remove` 抛 `InvalidStateError` |

### 0.3 结论标记

- **删除**：整文件/整区间随内核替换一起消失，无替代物。
- **改造**：功能要继续，但实现从"补偿 WebView"换成"用 libmpv 原生能力"，或语义要反转。
- **保留**：与解码内核无关，换 mpv 后照旧。

---

## 1. 完整清单

### 1.1 A 组：Kotlin 音轨转码链（`bplayer-android/src-tauri/gen/android/app/src/main/java/com/danmuku/bplayer/android/`）

整组的存在理由只有一条：**W1 + W2**。libmpv 自带 libavcodec 全解码器与原生轨切换，这 5 个文件全部失去存在依据。

| # | 文件 | 实测行数 | 物理行 | 一句话职责 | 绕开的限制 | 结论 |
|---|---|---|---|---|---|---|
| A1 | `AudioDecodeService.kt` | 873 | 936 | 独立进程 `:audio_transcode` 的 worker：ffprobe 探轨、5 段并行 AAC 编码、ADTS 帧级裁剪、concat 重封装成 `(音轨N).mka`、STREAM 边转边写 fMP4、512 MiB/超时/进程自杀 | W1 W2 W5 | **删除**（936 行全删） |
| A2 | `AudioWorkerClient.kt` | 156 | 165 | 主进程侧 Messenger 客户端：`bind` / `call(command,bundle,cancellation)` / `startStream` / `stopStream` / `close`，含 35 s 探测超时与 1860 s 转码超时 | W1（worker 必须隔离进程，否则 LMK 会连播放一起收掉） | **删除** |
| A3 | `AudioMedia.kt` | 218 | 236 | 缓存语义与字节源：`validCache()`（强制单条 AAC 2ch + 时长容差 + tags 指纹）、`checkSpace()`（2× 预留）、`offset()`/`tags()`、`AudioSourceAccess`（本地路径或网络源统一出 `input()` URL、`(音轨N).mka` 命名、原子 publish） | W1 W2 W9 | **删除**（注：`AudioCancellation` 实际定义在 A4，不在本文件） |
| A4 | `AudioCacheTransfer.kt` | 94 | 99 | `AudioCancellation`（取消回调 + 一次性 `commit`）、`AudioCacheNames.derive()`、`AudioCacheTransfer.copy/verifyVideo/strongEtag` | W1（远端缓存发布的独占/不覆盖） | **删除** |
| A5 | `AndroidAudioNative.kt` | 480 | 500 | JS 桥：11 个命令、单线程 `ThreadPoolExecutor(1,1)` 串行化、session/permit/job 三套墓碑、`StreamState`+`AudioBoxSplitter` 按 ISO-BMFF box 边界增量读增长文件、`setForeground` 后台停转码 | W1 W2 W4 W5 | **删除**（同时是"最危险耦合点"第 1 名，见 §2.2） |

**A1 内部可删区间的细分**（便于分批 revert）：

| 区间 | 内容 | 行数 |
|---|---|---|
| 27–175 | `AudioWorkerProtocol` / `AudioAssembling` / `AudioSegmentation` / `AudioWorkerLifecycle` / `AudioWorkerValidation` | 149 |
| 269–309 | `onCreate` 的 cache 清理 + FFmpegKit 全局配置 | 41 |
| 313–415 | 探测 / 计划 / 分片边界换算 | 103 |
| 420–453 | 单段整轨转码回退路径 | 34 |
| 458–531 | 分片并行编码与进度 | 74 |
| 536–622 | 拼接（帧级裁剪 + concat 重封装，含 `trimAdts`） | 87 |
| 624–667 | 重封装与产物校验 | 44 |
| 753–856 | **STREAM 流式转码**（`streamArgs` / `startStream` / `finishStream`） | 104 |
| 858–892 | `extractSubtitle`（网络源内嵌字幕 ffmpeg 兜底，与 §1.3 C9 同源） | 35 |

### 1.2 B 组：Rust 后端（`bplayer-android/src-tauri/src/`）

| # | 文件 | 实测行数 | 物理行 | 一句话职责 | 绕开的限制 | 结论 |
|---|---|---|---|---|---|---|
| B1 | `mkv_sub.rs` | 940 | 1019 | 纯 std 解析 EBML：SeekHead→Cues→逐条 cue 用 `CueClusterPosition+CueRelativePosition` 稀疏 seek 抽内嵌文本字幕成 SRT，含 ASS 去标签 `strip_markup` 与 fail-closed 判定 | W8 | **删除**（libmpv 直接读容器内嵌轨，libass 直接渲染 ASS） |
| B2 | `http_range.rs` | 286 | 304 | `HttpRangeReader`：给 B1 当随机读源的 HTTP Range 实现，共用 `ureq::Agent`、4 路并发预取、96 MiB 预算按 `pos` 距离淘汰、只认 206 | W9（+W8） | **删除**（唯一消费者是 B1） |
| B3 | `pgs_render.rs` | 587 | 647 | libpgs 抽 PGS 显示集 → RLE 解码 → RGBA 合成 → 裁墨迹边界 → PNG base64 事件表；4 个命令 + 代际守卫 + 64 MB/48 MB 预算 | W6 | **删除**（libmpv 内置 libass 直接渲染 PGS 位图） |
| B4 | `mkv_probe.rs` | 341 | 373 | 纯 std 读 EBML `Tracks` / `Duration`，供开播前发现"内核解不了的音轨" | W2 | **删除 —— 且它已经是死代码**：前端 `android-storage.js:167` 对网络源直接返回 `{tracks:[],duration_us:null}` 空 stub，`index.html` 全文**从不** `invoke('probe_mkv_tracks')`（音轨探测已改走 A5 的 `audio_probe`） |
| B5 | `lib.rs`（部分） | 537 | 585 | 命令注册表 + 文件扫描/文本读取 | — | **改造**：删 B1–B4 的 `mod`（25–28 行里的四行）、`probe_mkv_tracks`（291–296）、`transcode_*` 三桩（410–430、474–484）、`extract_subtitle_text`（422–473）、`extract_subtitle_text_url`（485–513）、`pgs_*` 四命令（526–551）与对应的 `generate_handler!` 条目（562–581）。约 **155 行** |
| B6 | `blocking.rs` | 53 | 56 | `spawn_blocking` 薄壳，把阻塞 IO 挪出 Android 单线程 invoke 通道 | 与解码无关 | **保留**（换 mpv 后新增任何命令更需要它） |

**B5 补充事实**：`transcode_target`（410）/`transcode_audio_start`（415）在 `ui/` 下**零调用点**，是纯死桩；`transcode_audio_cancel` 仍有调用（`index.html:3036`），删命令时要同步删该行。`clean_sidecar_tmp`（521，桩）被 `index.html:3043` 调用，`sidecar_cache_files` 被 `android-storage.js:163–169` 调用 —— 这两个保留（或连同调用点一起清）。

### 1.3 C 组：前端

| # | 文件 / 区间 | 实测行数 | 物理行 | 一句话职责 | 绕开的限制 | 结论 |
|---|---|---|---|---|---|---|
| C1 | `ui/android-audio.js`（整文件） | 330 | 336 | 三层：`createTasks`（JS 侧请求-回复 + `__aAudioReply`/`__aAudioEvent` 全局）、`createSession`（会话/世代状态机 + `hooks.stream` 流式接管 + `codec()` 白名单判定 `needsConversion`）、`createTrack`（独立 `<audio>` 元素跟随视频时钟 + 25 ms/250 ms 两级对齐） | W1 W2 W4 | **删除**（336 行全删） |
| C2 | `ui/vendor/artplayer-plugin-audio-track.js` | 7 | 7 | 第三方 minified 插件：`new Audio` 跟随 `art.currentTime`（1.4 KB） | W2 | **删除 —— 且已经是死文件**：全仓库（排除 `node_modules`）除自身第 7 行外**零引用**，`index.html:569` 加载了它但没有任何 `artplayerPluginAudioTrack(...)` 调用；实际在用的是 C1 的 `createTrack`。删文件 + 删 `index.html:569` 的 `<script>` |
| C3 | `ui/index.html` 流式音轨 | — | 301 | `STREAM_*` 常量（1969–1977）、`streamSupported/Playhead/BufferedEnd/AheadFull`（1979–1998）、`trimStreamBuffer`（2006–2027）、`startStreamTicker`（2031–2038）、`stopStreamAudio`（2040–2058）、`startStreamAudio`（2060–2115）、`appendStreamChunk`（2117–2139）、`onStreamUpdateEnd`（2141–2151）、`pullStreamChunk`（2154–2197）、`bindStreamSeekWatch`（2201–2206）、`streamBufferedAt`（2208–2216）、`scheduleStreamRestart`（2224–2242）、`window.__bplayerStream`（2245–2265），区间 **1965–2265** | W1 W4 W5 W11 | **删除** |
| C4 | `ui/index.html` PGS 覆盖层 | — | 210 | `pgsIndexData/pgsTrackNo/pgsOwnerPath/pgsEl/pgsImg/pgsCache/pgsActiveIdx/pgsToken`（2616–2623）、`pgsHost`（2625）、`ensurePgsLayer`（2630）、`videoContentBox`（2651）、`layoutPgsImg`（2671）、`pgsEventAt`（2683）、`pgsTrimCache`（2698）、`pgsPump`（2706）、`attachPgsEvents`（2734）、`mountPgsSubtitle`（2755）、`unmountPgs`（2812），区间 **2613–2822** | W6 W7 | **删除** |
| C5 | `ui/index.html` 音轨会话钩子 | — | 94 | `ensureAudioSession()`（1782–1875）：`autoEnabled/cachedProbe/rememberProbe/stream/probing/probe/resetTrack/isolate/selecting/mount/ready/disabled/progress/assembling/error/idle` 17 个钩子全部为音轨转码链服务 | W1 W2 | **删除** |
| C6 | `ui/index.html` 音轨探测缓存 | — | 31 | `AUDIO_PROBE_CACHE_KEY` + `audioProbeCacheAll/readAudioProbeCache/writeAudioProbeCache`（1750–1780），只用于缓存 ffprobe 结果 | W2（省掉网络源一两秒） | **删除** |
| C7 | `ui/index.html` WebAudio 隔离 | — | 40 | `audioSplitter`（1928）+ `isolateVideoAudio()`（1930–1954）+ `releaseVideoAudio()`（1956–1963）：`createMediaElementSource` + `gain=0` 压掉 `<video>` 自己的声音，避免与外挂 AAC 双声 | W2 W10 | **删除**（libmpv 只有一路音频输出，不存在双声） |
| C8 | `ui/index.html` 音轨菜单 | — | 81 | `refreshAudioMenu`（2274–2308）、`renderAudioProbeRetry`（2310–2325）、`retryAudioProbe`（2327–2333）、`switchAudioTrack`（2335–2354） | W2 | **改造**：入口 `#btnAudioEntry`/`#audioTrackList` 保留，数据源从 `probeTracks`（ffprobe 结果）换成 mpv 的 `track-list`；"可转 AAC / 原生可播"文案与 `needsConversion` 判定整段作废 |
| C9 | `ui/index.html` 内嵌/网络字幕抽取 | — | 110 | `mountSubtitle()` 的 embedded/network 分支（2473–2510）、`extractNetworkSubtitle()`（2512–2577）：`subtitle_reader` → `extract_subtitle_text_url` → 稀疏抽取，失败回落 `network_subtitle`（ffmpeg 顺序抽） | W8 W9 | **删除**（`sub-add` / mpv 自身轨选择取代） |
| C10 | `ui/index.html` 二次封装字幕渲染 | — | 12 | `mountSubtitleText()`（2579–2590）：`toVtt()` → `subtitleView.load()` | W7 | **改造**：外挂字幕改 `sub-add`，本函数删除；`playlistIndex`/选片逻辑不动 |
| C11 | `ui/android-subtitle-view.js` | 153 | 157 | 自建字幕层：`placement()` 的 contain/cover 反算、`createObjectURL(Blob(text/vtt))` → `<track>` → 手动二分 cue → `container.textContent` 渲染 → `requestVideoFrameCallback` 驱动 | W7 | **删除**（libass 渲染，`sub-pos` 定位） |
| C12 | `ui/android-sidecars.js`（部分） | 238 | 263 | 其中 `parseTimed`（106–151）、`assText`（152–165）、`parseAss`（166–192）、`toVtt`（194–205）及 8 个配套小函数（`normalizeText`/`escapeVtt`/`milliseconds`/`timestamp`/`makeCue`/`cue`/`clockLike`/`classifyTiming`，32–105）只做"任意文本字幕 → WebVTT" | W7 | **改造**：删约 **160 行**；保留 `decode()`（GBK 回退探测）、`language()`/`stem()`/`pickSubtitle()`/`preferences()`（选片与排序仍要）、`entities()`（若字幕设置仍要预览） |
| C13 | `ui/index.html` 进度胶囊 | — | 124 | `audioPillJob`/`subPillKind`（2871–2872）、`audioPillState`（2879）、`fmtSpeed`/`fmtEta`/`audioPillText`/`subPillText`（2881–2907）、`syncPills`（2909）、`clearAudioPill`（2913）、`clearSubPill`（2920）、`hideAllPills`（2922）、`audioPillSample`（2929）、`updateAudioPill`（2945）、`showAudioAssembling`（2974）、`updateSubPill`（2983）、点击绑定（2990–2992），区间 **2869–2992** | W1（转码进度） | **删除**（含 DOM：`#pillStack`/`#pillAudio`/`#pillSub` 562–565、`pillEls` 591） |
| C14 | `ui/index.html` 杂项 | — | 6 | `audioStatus()`（1743–1746）、`handleAudioCodecs()`（1877–1881）、`cancelAudioWork()`（1883–1890）、`cancelSubtitleWork()` 的 pgs 分支（1900–1907）、`resetAudioSession`/`resetExternalAudio`（1912、2267） | W1 W6 | **删除**（`cancelSubtitleWork` 整函数可删，见 §3） |
| C15 | `ui/android-storage.js` | 702 | 704 | `invoke()` 的补偿分流 | W2 | **改造 1 行**：删 167 行的 `probe_mkv_tracks` 空 stub；163–169 的 `sidecar_cache_files` 分流（走 `audio_cache_files`）随 A5 删除 |

### 1.4 D 组：桥、宿主与清单

| # | 位置 | 行数 | 职责 | 限制 | 结论 |
|---|---|---|---|---|---|
| D1 | `MainActivity.kt` 40 / 211–214 / 358 / 365 / 373 | ~18 | `audioNative` 字段、注册 `AndroidAudioNative`、`onStart/onStop` 的 `setForeground`、销毁时 `removeJavascriptInterface` | W1 W2 | **改造**：删这 5 处；`PlaybackAudioFocus` 的注册（219–221、357、364、380–382）**保留** |
| D2 | `AndroidManifest.xml` 45–48 | 4 | `<service android:name=".AudioDecodeService" android:exported="false" android:process=":audio_transcode" />` | W1（独立进程隔离） | **删除**（`:thumbnails` 服务 50–53 保留） |
| D3 | `PlaybackAudioFocus.kt` | 90 / 104 | 前台会话许可 + 耳机断开 + 后台暂停 | **W3** | **改造，不删**（语义反转，见 §5.1） |
| D4 | `gen/.../app/src/test/java/.../AudioCacheTransferTest.kt`、`AudioMediaTest.kt`、`AudioWorkerValidationTest.kt` | — | A 组的单元测试 | — | **删除**（随被测算代码一起消失） |
| D5 | `gen/.../app/src/test/java/.../PlaybackAudioFocusTest.kt` | — | D3 的测试 | — | **改造**（改成断言"真的申请/放弃了焦点"） |

---

## 2. 依赖图与枢纽

### 2.1 现状调用关系（→ 表示"依赖"，虚线表示调试/测试面）

```
                        ┌────────────────────────────── ui/index.html（播放核心） ──────────────────────────────┐
                        │  createPlayer:1037  audioTrack = AndroidAudioTrack.create(art)                          │
                        │  1782 ensureAudioSession()  ← 17 个 hooks                                              │
                        │  1805 probeTracks / 1806 probeDurationUs ←─ probe 回包                                   │
                        │  1965-2265 流式（MSE）      2613-2822 PGS 覆盖层      2869-2992 两颗胶囊                  │
                        └───────┬──────────────────────┬──────────────────────┬────────────────────────┬────────┘
                                │                      │                      │                        │
                 window.AndroidAudioTasks      window.__bplayerStream   window.__BplayerDesktop   window.AndroidPlayback
                 window.AndroidAudioSession    window.__bplayerAudio…          .pgs/.audioOutput     (= android-shell.js:1049)
                                │                      │                      │                        │
                                ▼                      ╎                      ╎                        ▼
                   ui/android-audio.js（C1）           ╎  真机 CDP 探针         ╎                android-shell.js
                    ├ createTasks ─────────────────────╎─── tmp/stream-probe/*.js ╎                （播放会话/返回键层级）
                    │      └─ environment.AndroidAudioNative.request(id,cmd,json)     ╎
                    ├ createSession（状态机 + 世代）   ╎                      ╎
                    └ createTrack（独立 <audio> 元素）  ╎                      ╎
                                │                      ╎                      ╎
                                ▼                      ╎                      ╎
                   Kotlin AndroidAudioNative.kt（A5）  ╎                      ╎
                    ├ reply → window.__aAudioReply      ╎                      ╎
                    ├ event → window.__aAudioEvent      ╎                      ╎
                    ├ AudioWorkerClient（A2）──Messenger──▶ AudioDecodeService（A1）
                    │                                          └ FFmpegKit（ffprobe / 分段编码 / trimAdts / concat / STREAM fMP4）
                    ├ AudioMedia.validCache / checkSpace / tags / offset（A3）
                    ├ AudioSourceAccess（A3:92-236）
                    │    ├ 本地：File
                    │    └ 网络：/@network/<id>/… ──▶ NetworkMediaServer（role=TRANSCODE）──▶ NetworkConnections ──▶ Smb/WebDav/Sftp
                    └ StreamState + AudioBoxSplitter（A5:269-365）──读──▶ cacheDir/stream/<id>.mp4

        Rust 侧（与 A 组平行、互不调用，但共用一条前端切片入口）：
          lib.rs:294 probe_mkv_tracks ──▶ mkv_probe.rs（B4，前端从不调用）
          lib.rs:431 extract_subtitle_text ──┐
          lib.rs:485 extract_subtitle_text_url ──┴──▶ mkv_sub.rs（B1）──▶ RandomRead ──▶ http_range.rs（B2）──HTTP Range──▶ NetworkMediaServer
          lib.rs:530-551 pgs_open/pgs_image/pgs_close/pgs_current ──▶ pgs_render.rs（B3）──读──▶ 本地 mkv / cacheDir/subtitles/*.mkv（由 A1:858 extractSubtitle 产出）

        D3 PlaybackAudioFocus.kt ◀── AndroidPlaybackAudio.requestFocus()/abandonFocus()
                                 ◀── android-player-tools.js:104-105, 262-273 ◀── window.AndroidPlaybackAudioEvent（D3:94）
```

### 2.2 三个"牵一发动全身"的枢纽

#### 枢纽 1（最危险）：`AndroidAudioNative` 的桥契约

跨 **4 层 + 1 个独立进程**：JS 全局名 → Kotlin `@JavascriptInterface` → Messenger 协议常量 → `:audio_transcode` 进程。

- 命令名集合被写死在 `AndroidAudioNative.kt:47` 的 `setOf(...)`（11 个字符串），**改一个字就是"不支持或过大的音轨请求"**。
- 回包信封 `{ok, result|error}` 由 `AndroidAudioNative.kt:469-472` 定义，前端在 `android-audio.js:67-70` 解析；事件名白名单在 `android-audio.js:72`（`progress/assembling/done/error/cancelled`）。
- 全局钩子名 `window.__aAudioReply` / `window.__aAudioEvent` 由 **Kotlin 侧硬编码**（`AndroidAudioNative.kt:471`、`476`），JS 侧在 `android-audio.js:75` 挂载、`83-84` 卸载。
- 删它要同步动的位置（一处漏掉就是运行时静默失败，不是编译错）：
  1. `ui/android-audio.js` 全文（C1）
  2. `ui/index.html`：1782–1875、1883–1890、1965–2265、2274–2354、2515–2577、2775–2784、3036、3048、3107–3111
  3. `ui/android-storage.js:163–164`（`sidecar_cache_files` 分流到 `audio_cache_files`）
  4. `MainActivity.kt:40,211–214,358,365,373`
  5. `AndroidManifest.xml:45–48`
  6. `AudioWorkerClient.kt` / `AudioDecodeService.kt` / `AudioMedia.kt` / `AudioCacheTransfer.kt`
- **CSP / 信任检查也会静默吞掉请求**：`trustedPage()`（`AndroidAudioNative.kt:197-200`）要求 `http://tauri.localhost`，页面 origin 一变，所有回包直接消失。

#### 枢纽 2：调试与验收钩子（`__bplayerStream` / `__BplayerDesktop` / `__bplayerAudioProbeFailed`）

- `window.__bplayerStream`（`index.html:2245–2265`）是**真机验收的唯一观测窗**，`tmp/` 下 4 个探针脚本直接依赖它：`tmp/stream-probe/state.js:12`、`status-only.js:1`、`diag-tail.js:1`、`time-open.js:9`。AGENTS.md:284 更是把它写成验收判据（"`__bplayerStream()` 必须在切轨后变回 `null`"）。
- `window.__BplayerDesktop`（`index.html:3099–3133`）是调试面：`.pgs`（3120–3132，位图索引/命中/缓存）、`.audioOutput`（3109，读 `audioSplitter.gain`）、`.audioState`（3108）、`.selectAudio`（3110）、`.cancelAudio`（3111）。`tmp/work/pill-landscape-check.cjs:123` 直接读 `window.__BplayerDesktop.pgs.hasIndex`。
- `window.__bplayerAudioProbeFailed`（1804、1861、1921、2281）不只是调试：`refreshAudioMenu` 靠它把"探测失败可重试"入口画出来，**中间隔了一层 window 是因为探针会把函数抠出去在干净上下文里执行**（1814–1817 的注释明说）。
- 结论：删补偿逻辑 ≠ 删观测面。**要么同步改掉 `tmp/` 与 research 文档里的验证步骤，要么在 mpv 侧提供等价的 `__bplayerMpv()` 观测对象**，否则下次真机验收会照着文档调用一个已不存在的函数。

#### 枢纽 3：`AudioSourceAccess` + `NetworkMediaServer` 的参数化（网络源的唯一字节入口）

- `AudioSourceAccess`（`AudioMedia.kt:92–236`）是**本地路径与网络虚拟路径的唯一归一化点**，`input()` 有 4 个参数（`probing` / `prefetchBytes` / `workerThreads`）专为三种用途调参：播放默认 4 MiB 预读、`audio_probe` 用 32 MiB 读上限、字幕稀疏抽读取 16 KiB 预读 + 8 线程（`AndroidAudioNative.kt:171–175` 有实测注释：64 KiB 预读会把 65 秒拖成 82 秒）。
- `NetworkMediaServer`（`NetworkMediaServer.kt`）的 `maxReadBytes`/`bounded()`/`bytesRead`（41、50、128–143）与 `prefetchBytes`/`workerThreads`（44、48）**只**为上述三个用途存在。删音轨链后 `maxReadBytes` 与 `bounded()`（约 20 行）随之死亡。
- **隐蔽交叉点**：网络 PGS 轨走的是**音轨桥的命令**，不是 Rust 命令 —— `index.html:2775–2784` 用 `AndroidAudioTasks.request('network_subtitle', {format:'mkv', …})` 先把 PGS 轨复制成单轨 MKV，再交给 `pgs_open`。也就是说"删 PGS"和"删音轨桥"看似两条线，实际共用 `network_subtitle` 这一条命令；谁先删都会打断对方。

---

## 3. `ui/index.html` 前端耦合点（逐符号 + 行号）

只列**仅因补偿逻辑而存在**的符号。`#btnAudioEntry`、`#subtitlePanel`、播放器装配等 UI 骨架不在内。

### 3.1 流式音轨（C3）

| 符号 | 定义行 | 引用行 | 删除时同步改 |
|---|---|---|---|
| `STREAM_MIME` | 1969 | 1981、2086 | — |
| `STREAM_CHUNK_BYTES` | 1970 | 2161 | — |
| `STREAM_QUEUE_BYTES` | 1971 | 2157 | — |
| `STREAM_AHEAD_MAX` | 1976 | 1997 | — |
| `STREAM_KEEP_BACK` | 1977 | 2004、2016 | AGENTS.md:55、285 的整段说明 |
| `streamAudio` | 1972 | 2007、2034、2043–2045、2079、2103、2142、2155、2164、2184、2209、2225、2231、2234–2235、2246、2256 | — |
| `streamRestartTimer` / `streamTrimTimer` / `streamTick` | 1973–1975 | 2032–2044、2228–2230 | — |
| `streamSupported()` | 1979 | **1792**（`hooks.stream` 里）、2062 | `ensureAudioSession` 的 `stream:` 钩子（1788–1796） |
| `streamPlayhead()` | 1984 | 1997、2014 | — |
| `streamBufferedEnd()` | 1991 | 1997 | — |
| `streamAheadFull()` | 1996 | 2120、2158 | — |
| `trimStreamBuffer()` | 2006 | 2036、2147 | AGENTS.md:55、285 |
| `startStreamTicker()` | 2031 | 2080 | — |
| `stopStreamAudio()` | 2040 | **1791、1817、1885、1913、2063、2087、2236、2268、2343** | 6 个外部调用点全在别的补偿函数里（`hooks.stream`、`resetTrack`、`cancelAudioWork`、`resetAudioSession`、`scheduleStreamRestart`、`resetExternalAudio`、`switchAudioTrack`） |
| `startStreamAudio()` | 2060 | 1795、2238 | — |
| `appendStreamChunk()` | 2117 | 2035、2148、2180 | — |
| `onStreamUpdateEnd()` | 2141 | 2048、2093 | — |
| `pullStreamChunk()` | 2154 | 2096、2150、2181、2195 | — |
| `bindStreamSeekWatch()` | 2201 | 2109 | — |
| `streamBufferedAt()` | 2208 | 2227、2233 | — |
| `scheduleStreamRestart()` | 2224 | **2205**（`video.seeking` 监听） | AGENTS.md:55、285 |
| `window.__bplayerStream` | 2245 | `tmp/stream-probe/{state,status-only,diag-tail,time-open}.js`、AGENTS.md:284 | 枢纽 2 |

> **删除顺序警告**：`scheduleStreamRestart` 的 `seeking` 绑定是 2205 行，而 `bindStreamSeekWatch` 用的是 `v.__streamSeekBound` 幂等标记（2203–2204）。先删监听、后删函数会留下死代码而不会报错；反过来先删函数会立刻在 seek 时抛 `ReferenceError`。**先删 2205 那行，再删 1965–2265 整块。**

### 3.2 PGS 覆盖层（C4）

| 符号 | 定义行 | 引用行 | 删除时同步改 |
|---|---|---|---|
| `pgsIndexData` | 2616 | 2672–2676、2684、2707、2723、2787–2802、3122–3128 | `__BplayerDesktop.pgs` (3120–3132) |
| `pgsCache` | 2621 | 2714、2726–2727、2795、2816、3126 | 同上 |
| `pgsToken` | 2623 | 2722–2724、2768、2806、2813 | `cancelSubtitleWork` 1901 |
| `pgsActiveIdx` | 2622 | 2710–2712、2728、2762、2796、2817 | 同上 |
| `pgsPump()` | 2706 | **2738–2741、2748、2763、2802** | 4 个 `video` 事件监听 + 1 个 ResizeObserver + 2 处手动调用 |
| `pgsEventAt()` | 2683 | 2708、3128 | — |
| `layoutPgsImg()` | 2671 | 2709 | — |
| `videoContentBox()` | 2651 | 2673 | 与 `android-subtitle-view.js` 的 `placement()` 是同一套数学（C11 也删） |
| `ensurePgsLayer()` | 2630 | 2761、2799 | — |
| `attachPgsEvents()` | 2734 | **2800**（只有这一处调用） | — |
| `mountPgsSubtitle()` | 2755 | **2470**（`mountSubtitle` 的 bitmap 分支） | `mountSubtitle` 2468–2471 |
| `unmountPgs()` | 2812 | **2471、2830** | `mountSubtitle` 的 `unmountPgs()` 调用 + `unmountSubtitle` |
| `'pgs:'` 菜单条目 | 2394–2400 | `refreshSubtitleMenu` 2457 | 字幕菜单的 `kind:'bitmap'` 分支整体删 |
| 调试面 `.pgs` | 3120–3132 | `tmp/work/pill-landscape-check.cjs:123` | 枢纽 2 |

### 3.3 音轨会话与隔离（C5/C7）

| 符号 | 定义行 | 引用行 | 删除时同步改 |
|---|---|---|---|
| `audioSession` / `ensureAudioSession()` | 1782 | 1880、2332、2353、1914、3107、3110 | `cancelAudioWork`(1884)、`resetAudioSession`(1914)、`switchAudioTrack`(2353)、`retryAudioProbe`(2332)、`__BplayerDesktop.selectAudio`(3110) |
| `audioSplitter` | 1928 | 1934–1936、1957–1960、3109 | `__BplayerDesktop.audioOutput` 的 `isolated` 字段 |
| `isolateVideoAudio()` | 1930 | **1800、1824** | `probing` 钩子（1800）、`mount` 钩子（1824） |
| `releaseVideoAudio()` | 1956 | **1809、1860、1916、2269、2345** | `probe` 钩子、`error` 钩子、`resetAudioSession`、`resetExternalAudio`、`switchAudioTrack` |
| `audioTrack` | 1037 | 1817、1823、1826、2101、2254、2270、3114 | `art.on('destroy')` 1038–1041；`android-audio.js` 整个 `createTrack` |
| `audioProbeInFlight` | 1798 | 1854、1921 | `error` 钩子里的"探测失败"分支 1852–1867 |
| `window.__bplayerAudioProbeFailed` | 1804 | 1861、1921、**2281** | `refreshAudioMenu` 的首个分支（2281）→ 删后 2282 的 `btn.hidden=true` 变成唯一出口 |
| `probeTracks` | 1539 | 1805–1812、1916、**2276–2294**、2336–2342 | `refreshAudioMenu` 整个数据源 |
| `probeDurationUs` | 1540 | 1806、1916、2071、2491、2568、3023 | 5 处 |
| `externalOrdinal` | 1538 | 1830、1916、2271、**2294**、2346、2352 | `refreshAudioMenu` 的 `current` 高亮判定 |
| `resetAudioSession()` | 1912 | 2997、3107 | — |
| `resetExternalAudio()` | 2267 | **3041**（开片流程） | — |
| `handleAudioCodecs()` | 1877 | **3048**（开片流程） | 开片流程里这一行删掉后，音轨入口要改由 mpv `track-list` 事件驱动 |
| `cancelAudioWork()` | 1883 | 2990、2992、3111 | 胶囊点击 + `#audioCancel` 按钮（DOM 458） |
| `cancelSubtitleWork()` | 1897 | 2991 | 剥掉 pgs 分支（1900–1902）后整个函数可删（`subExtractToken` 也随之无主） |
| `audioStatus()` | 1743 | 1799、1800、1812、1821、1825、1832、1840、1847、1863、1868、1888、1922、2349 | 19 处文案全是转码链状态；`#audioStatus`(456)、`#audioCancel`(458) 一起删 |
| `fullCacheActive` | 1541 | **只在 3024 赋值，零读者** | 已是死变量，可先删 |

### 3.4 胶囊与 DOM（C13）

| 符号 | 定义行 | 引用行 / DOM |
|---|---|---|
| `pillEls` | 591 | 2910–2911、2968、2979、2985、2990–2991；DOM `#pillStack`/`#pillAudio`/`#pillSub` = **562–565** |
| `audioPillJob` / `subPillKind` | 2871 / 2872 | 2910–2911、2914、2920、2949、2976、2984 |
| `audioPillState` | 2879 | 2893、2915–2917、2930、2948、2975 |
| `audioPillText()` / `subPillText()` | 2892 / 2905 | 2968、2979、2985 |
| `fmtSpeed()` / `fmtEta()` | 2881 / 2888 | 2901、2903 |
| `audioPillSample()` | 2929 | 2954 |
| `updateAudioPill()` | 2945 | **1846**（`progress` 钩子） |
| `showAudioAssembling()` | 2974 | **1850**（`assembling` 钩子） |
| `clearAudioPill()` | 2913 | 1831、1853、1872、1887、2347、2919(内部) |
| `updateSubPill()` | 2983 | 2484、2524、2770 |
| `clearSubPill()` | 2920 | 1908、2498、2505、2538、2558、2790、2807 |
| `hideAllPills()` | 2922 | 1919 |
| `PILL_SPEED_SMOOTH` / `PILL_ETA_SMOOTH` / `PILL_RATE_SAMPLES` | 2877–2878（+ 上文） | 2935、2943、2963 |

### 3.5 字幕管线（C9/C10/C11）

| 符号 | 定义行 | 引用行 | 删除时同步改 |
|---|---|---|---|
| `mountSubtitle()` embedded/network 分支 | 2473–2510 | `refreshSubtitleMenu` 2462、`autoMountSubtitle` 2850 附近 | 保留 `s.kind==='ext'` 分支（改 `sub-add`） |
| `extractNetworkSubtitle()` | 2515 | **2475** | 与枢纽 3 的 `network_subtitle` 共用 |
| `subtitle_reader` / `subtitle_reader_close` | 2533、2562 | — | A5 的两条命令 + Rust `extract_subtitle_text_url` |
| `mountSubtitleText()` | 2579 | 2501、2540 | 改 `sub-add` 后删除 |
| `subtitleView` | 1549 | 1572、1596–1598、1615、2826、3114 | `android-subtitle-view.js` 整个（C11） |
| `ensureSubtitleView()` | 1594 | 2581 | — |
| `applySubtitleStyle()` | 1604 | 1599、1627、1632、2587 | 改成写 mpv 选项（`sub-font-size`/`sub-color`/`sub-border-size`/`sub-pos`/`sub-delay`） |
| `#subtitleDelay` 输入 | 1630–1633 | — | → `sub-delay` |
| `subExtractToken` | 1548 | 2480、2492、2504、2518、2536、2543、2551、2557、2564 | — |
| `pendingSub` / `transcodeVideo` / `transcodeOrdinal` | 1545、1535、1535 | 2481–2507、2521–2558、2842 | — |
| `@font/@outline/@position` 设置面板 | 1618–1634 | 3152 附近 | 保留 UI，改落点 |

### 3.6 媒体元素与跨域（W10）

| 符号 | 行 | 说明 |
|---|---|---|
| `vEl.crossOrigin = 'anonymous'` | **1033** | 只为 `createMediaElementSource` 能抓到声音（1025–1030 注释是实测记录）。删 C7 后这行**是否保留**取决于 mpv 渲染方式：若 mpv 输出到独立 SurfaceView/TextureView，`<video>` 元素整个消失，1032–1033 一起删 |
| `artvideo` 事件监听 `seeking` | 2205 | 随 C3 删 |
| `video.requestVideoFrameCallback` | `android-subtitle-view.js:87、92` | 随 C11 删 |

---

## 4. 可删除量级

口径：**物理行数**（删除按整行区间走，含空行）。"部分删"列给出的是按上文行号区间算出的精确值或标明估算。

| 文件 | 实测行数 | 物理行 | 可删 | 占比 | 依据 |
|---|---|---|---|---|---|
| `AudioDecodeService.kt` | 873 | 936 | **936** | 100% | A1 |
| `AndroidAudioNative.kt` | 480 | 500 | **500** | 100% | A5 |
| `AudioMedia.kt` | 218 | 236 | **236** | 100% | A3 |
| `AudioWorkerClient.kt` | 156 | 165 | **165** | 100% | A2 |
| `AudioCacheTransfer.kt` | 94 | 99 | **99** | 100% | A4 |
| `mkv_sub.rs` | 940 | 1019 | **1019** | 100% | B1 |
| `pgs_render.rs` | 587 | 647 | **647** | 100% | B3 |
| `mkv_probe.rs` | 341 | 373 | **373** | 100% | B4（已是死代码） |
| `http_range.rs` | 286 | 304 | **304** | 100% | B2 |
| `ui/android-audio.js` | 330 | 336 | **336** | 100% | C1 |
| `ui/android-subtitle-view.js` | 153 | 157 | **157** | 100% | C11 |
| `ui/vendor/artplayer-plugin-audio-track.js` | 7 | 7 | **7** | 100% | C2（已是死文件） |
| `ui/index.html` | 3449 | 3668 | **≈1000** | ≈27% | C3 301 + C4 210 + C5 94 + C13 124 + C6 31 + C7 40 + C8 81 + C9 110 + C10 12 + C14 6 + DOM 17 ≈ 1026，扣掉约 25 行"必须改写而非纯删"（`refreshSubtitleMenu` 的 bitmap 分支、`mountSubtitle` 的 ext 分支） |
| `lib.rs` | 537 | 585 | **≈155** | ≈26% | B5 |
| `ui/android-sidecars.js` | 238 | 263 | **≈160** | ≈61% | C12 |
| `MainActivity.kt` | 369 | 401 | **≈18** | ≈4.5% | D1 |
| `AndroidManifest.xml` | 60 | 65 | **4** | — | D2（45–48） |
| `ui/android-storage.js` | 702 | 704 | **1** | — | C15（167 行） |
| **合计** | **12 个整文件 + 6 个部分文件** | — | **≈6117** | — | — |

### 4.1 总账

- **可删 ≈ 6,100 行**（整文件 4,779 行 + 部分文件 ≈1,338 行）。
- 基线：上述 40 个源文件（`app/src/main/**/*.kt` 27 个 + `src-tauri/src/*.rs` 6 个 + `ui/*.js` 6 个 + `ui/index.html`）合计 **16,171 物理行**。
- 占比 **≈37.8%**。
- 按语言拆分：Kotlin ≈1,954（含 MainActivity 18）、Rust ≈2,498、前端 ≈1,661、Manifest 4。
- **不产生新代码的净删除**约 5,500 行；剩下约 600 行需要换成 mpv 侧实现（音轨菜单数据源、字幕设置映射、焦点申请）。

### 4.2 删完还剩什么（同样重要）

删掉 6,100 行后，`app/src/main/**/*.kt` 还剩 20 个文件，全部是**与播放内核无关**的三条线：网络存储（9 个）、缩略图（4 个）、宿主与更新（`MainActivity` / `PlaybackAudioFocus` / `UpdateChecker` / 生成的 7 个）。Rust 侧只剩 `lib.rs` + `blocking.rs`。

---

## 5. 不能删的东西

### 5.1 `PlaybackAudioFocus.kt` —— 要**反转语义**，不是删除

**为什么不能删**：
1. 桥名是既有契约：`window.AndroidPlaybackAudio.requestFocus()` / `.abandonFocus()`，调用点在 `android-player-tools.js:104–105、262–273`，不是补偿代码而是播放会话的一部分。
2. 它真正提供的能力与解码器无关且仍然必需：`ACTION_AUDIO_BECOMING_NOISY` 耳机断开 → `headphones-disconnected`（`PlaybackAudioFocus.kt:60–66`）→ `window.AndroidPlaybackAudioEvent(reason)`（94）→ `android-player-tools.js:282` 的 `pauseFor`。
3. `PlaybackSessionState` 的世代号（`begin/interrupt/abandon/valid`，15–50）是"暂停后不自动恢复"的实现基础，AGENTS.md:59 明确要求这条行为。

**为什么必须改**：类注释（52 行）与 `requestFocus` 注释（75 行）写着"Chromium 是唯一的系统音频焦点所有者"。换成 libmpv 后，声音由**本进程**解码输出，WebView 不再持有焦点，`AUDIOFOCUS_LOSS` 也不会再有 Chromium 替我们处理。**必须真的调 `AudioManager.requestAudioFocus(AudioFocusRequest)`，并在 `LOSS`/`LOSS_TRANSIENT` 时暂停**，否则：
- 来电/其他 App 播音乐时，本机会和对方同时出声；
- 系统媒体键、蓝牙耳机断开后的播放控制全部失效。

**具体改法**：`requestFocus()`（77）内部改成 `audioManager.requestAudioFocus(request)` 并返回是否 `GRANTED`；`abandonFocus()`（81）改成 `abandonAudioFocusRequest`；`onStop`（85–87）保留后台暂停但要走 `abandon` 而非仅 `state.background()`。`PlaybackAudioFocusTest.kt` 同步改成断言"请求/放弃真的发生"。

### 5.2 `NetworkMediaServer.kt` —— 保留（libmpv 照样走它）

- 网络源在 Android 上没有可挂载路径（W9），libmpv 也读不了 SMB/WebDAV/SFTP 的 pd 接口，仍然只能拿 `http://127.0.0.1:<port>/<token>/<b64>` 这种本机 URL。`mediaUrl()`（61–66）、Range 解析（`NetworkByteRange` 13–34）、Origin/Host 校验（72–73）、CORS 头（174–183）、token 校验（51–52、75）全部照旧需要。
- **但要削掉约 20 行**：`maxReadBytes`（41）、`bytesRead`（50）、`bounded()`（128–143）只为 `audio_probe` 的"32 MiB 读上限"存在，随 A 组一起死亡。
- `mime()`（185–194）里的 `mka`→`audio/x-matroska`、`m4a`→`audio/mp4` 两个分支也随外挂音轨消失而无用（可留，无害）。
- 与它配套的 `NetworkConnections` / `NetworkRemote` / `SmbNetworkRemote` / `WebDavNetworkRemote` / `SftpNetworkRemote` / `NetworkModels` / `NetworkDiscovery` / `AndroidNetwork.kt`（14 个命令 + `mediaUrl`）**整条保留**。

### 5.3 缩略图链 —— 与播放无关，整条保留

`ThumbnailCore.kt`(196) / `ThumbnailDecodeService.kt`(146) / `AndroidThumbnails.kt`(327) / `NetworkThumbnailSources.kt`(51) / `ui/android-thumbnails.js`(200) + `AndroidManifest.xml:50–53` 的 `:thumbnails` 服务。

理由：用的是 `MediaMetadataRetriever`，与被替换的解码内核**完全独立**；换成 libmpv 后如果反过来想用 mpv 抓帧，那是**新增**能力，不是"删除清单"的一部分。AGENTS.md:61–62、200–207、275 的约束（12 MiB/任务、64 KiB/次、4 s 超时、不复用媒体池）继续有效。

### 5.4 其余保留项

| 项 | 位置 | 理由 |
|---|---|---|
| `blocking.rs` | 53 / 56 行 | invoke 串行通道的通用解药（`blocking.rs:1–30` 记录了 wry 单线程派发器的实测数据）；换 mpv 后新增命令更需要它 |
| `#btnAudioEntry` / `audioPanel` 入口 | `index.html:419、449–458` | 入口本身还要用，只是列表数据源换成 mpv `track-list`；`android-shell.js:683、710–716、1063` 的转发**不要动** |
| `android-shell.js` / `android-navigation.js` / `android-storage.js` / `android-gestures.js` / `android-resume-store.js` / `android-file-order.js` | — | UI 壳、返回键层级、断点续播、手势仲裁，与内核无关 |
| `android-sidecars.js` 的 `decode`/`language`/`stem`/`pickSubtitle`/`preferences` | 12–31、207–260 | 选片排序与 GBK 回退仍是产品需求；只有 `toVtt`/`parse*` 会消失 |
| `art.url` / `mediaUrl()` / asset 协议 | `index.html:1034`、`android-storage.js:175–181` | libmpv 也要区分本地路径与 `/@network/` 虚拟路径，改造而非删 |
| `clean_sidecar_tmp` 桩 + 调用点 | `lib.rs:521`、`index.html:3043` | 删命令就要同步删调用，二者只能一起动 |
| `UpdateChecker.kt`、`MainActivity` 的方向/沉浸式/权限/构建戳 | — | 与播放内核无关 |

---

## 6. AGENTS.md 需要改的条目

AGENTS.md 现在的行数：实测 226 / 物理 289。以下行号均已用 `Select-String` 定位确认。头部第 3 行的维护规则（"行为有变就同步改已有描述"）意味着**这次是整节重写，不是打补丁**。

### 6.1 会直接变成"错的"（必须改，否则误导后人）

| AGENTS.md 行 | 现在的说法 | 换 libmpv 后为什么错 | 建议改法 |
|---|---|---|---|
| **59** | 「系统音频焦点由 WebView/Chromium 唯一持有，禁止另起原生 `AudioFocusRequest` 与自身抢占。」 | 内核换成 libmpv 后声音由本进程输出，Chromium 不再持有焦点；继续遵守这条会**主动放弃焦点管理**，导致来电/其他 App 播放时双声、蓝牙断开不暂停 | 「音频焦点由本进程在播放开始时用 `AudioManager.requestAudioFocus(AudioFocusRequest)` 申请，暂停/退出/换片时 `abandon`；`AUDIOFOCUS_LOSS` 与 `LOSS_TRANSIENT` 必须暂停且不自动恢复。**『WebView 唯一持有焦点』是 `<video>` 时代的前提，已随内核替换失效。**」 |
| **225** | 「`PlaybackAudioFocus.kt` —— 只做前台会话许可 + 耳机断开 + 后台暂停，**不申请 `AudioFocusRequest`**（系统音频焦点由 WebView/Chromium 唯一持有）」 | 同 59，且这是模块级说明，比 59 更具体、更容易被照抄 | 「`PlaybackAudioFocus.kt` —— 申请/放弃系统焦点（`AudioFocusRequest`）+ 耳机断开（`AUDIO_BECOMING_NOISY`）+ 后台暂停。桥名 `requestFocus()/abandonFocus()` 保留，但内部语义是真正的焦点请求；`PlaybackSessionState` 的世代号仍是『中断后不自动恢复』的实现基础。」 |
| **47** | 「…Embedded text subtitle extraction is implemented for both local and network sources (see §4.1 / §4.3); **PGS bitmap rendering is implemented too (§4.1)**.」 | `pgs_*` 四命令、`pgs_render.rs`、`extract_subtitle_text*` 全部删除；字幕改由 libmpv+libass 渲染 | 删掉这两句，改为：「Rust 只保留目录扫描、文本读取与 `list_dir`；内嵌字幕、位图字幕、ASS 样式渲染全部交给 libmpv（libass），不再有 `pgs_*` / `extract_subtitle_text*` 命令。」 |
| **51** | 「…**ASS/SSA are text/time compatible only, not full styled libass rendering.**…」 | libmpv 内置 libass，**ASS/SSA 的完整样式、定位、特效都能渲染**；这句会让人以为仍然做不到 | 「ASS/SSA 由 libass 完整渲染（字体、定位、特效、卡拉 OK）；外挂字幕直接 `sub-add` 交给 mpv，不再做 ASS→VTT 降级转换。」 |
| **53** | 「Subtitle layout: Default to small (18 CSS px)… Recompute from real video dimensions and contain/cover bounds on resize, fold, metadata, fit and control changes…」 | 现在的位置/字号是 **CSS + `android-subtitle-view.js` 的 contain/cover 反算**算出来的；libass 渲染后这整套数学失效 | 「Subtitle layout: 字号/颜色/描边/位置/延时映射到 mpv 选项（`sub-font-size`、`sub-color`、`sub-border-size`、`sub-pos`、`sub-delay`），由 libass 按视频真实尺寸自行排版；删除 contain/cover 反算与 ResizeObserver 重排。仍只通过 Save 持久化。」 |
| **55** | 整段「**流式音轨（边转边播）**：…（约 300 字，含 `STREAM` 命令、`+frag_keyframe+empty_moov+default_base_moof`、`trimStreamBuffer`、`scheduleStreamRestart`、停流不变式、eof 短路） | 整条链（A1 STREAM / A5 切块器 / C3 前端状态机 / C13 胶囊）全部删除，这段 300+ 字会变成**无处可对的传说**，且它自己写明了"停流是共享不变式，不是逐点纪律"这种只能靠代码验证的断言 | **整段删除**，替换为一句：「**音轨**：libmpv 直接解码 DTS/TrueHD/AC-3/E-AC-3/LPCM/AC-4/DRA 与任意容器内轨，无需转码、无需流式、无需外挂 `<audio>`。原 ffmpeg 转码/MSE 流式链已移除（见 `research/mpv-migration-inventory.md`）。」 |
| **54** | 整段「**Audio conversion**：`AndroidAudioNative` serializes UUID session/permit/job tasks…（约 400 字）」 | A1–A5 全删，这条描述的是完全不存在的模块 | 同上，整段删除。若产品仍要"把不兼容音轨转成 AAC 存到视频同目录"，那要**重新设计**（不再是补偿，而是可选的归档功能），届时重写本段 |
| **284** | 「音轨「停流」只写在 `hooks.stream` 里是不够的…**`__bplayerStream()` 必须在切轨后变回 `null`**，否则旧 ffmpeg 会继续把整轨转完。」 | 没有 `hooks.stream`、没有旧 ffmpeg、没有 `__bplayerStream()` | **删除**。若保留一个 mpv 观测钩子，改写成对新钩子的要求 |
| **285** | 「流式转完后 `s.eof = true`…**`scheduleStreamRestart()` 里那行 `s.eof` 短路就是「转完再看片头 = 永久静音且无提示」的根因。**」 | 函数已不存在 | **删除**（这条坑随 W11 + MSE 一起消失） |
| **286** | 「手机上的 ffmpeg 只有 **约 2x 实时**…整段转码回退路径在一集 45 分钟片子上要跑 20 分钟以上…」 | 不再转码；这条实测数据的意义只剩"历史记录" | **删除**，或移到一个"历史决策"附录（若还想保留 2x 实时这个校准事实） |

### 6.2 会变成"数字/结构不对"（建议同步改）

| AGENTS.md 行 | 现在 | 应改为 |
|---|---|---|
| **5** | 「本仓库是基于 **Tauri 2 + WebView** 的 Android 视频弹幕播放器」 | 「基于 **Tauri 2 + libmpv + WebView（仅 UI）** 的 Android 视频弹幕播放器」 |
| **22–23**（目录表） | `android-subtitle-view.js  Atomic text-track loading…` / `android-audio.js  Owned native audio tasks…` | 两行删除（文件已删）；`android-sidecars.js` 的职责描述去掉"subtitle normalization"里的格式转换部分 |
| **31** | `src/lib.rs  Rust 命令（扫描目录、配对弹幕、读字幕、**探测 MKV 音轨**等）` | 去掉"探测 MKV 音轨"与"读字幕"（`extract_subtitle_text*` 已删） |
| **72** | `### 4.1 Rust 后端（7 个）` | `### 4.1 Rust 后端（2 个）`：`blocking.rs` + `lib.rs` |
| **76–83**（§4.1 表格） | 7 行，含 `mkv_probe.rs` / `mkv_sub.rs` / `pgs_render.rs` / `http_range.rs` | 只留 `blocking.rs`、`lib.rs` 两行 |
| **85–90**（mkv_sub 网络快路径） | 整节 | **删除** |
| **92**（pgs_render 命令差异） | 整段 | **删除** |
| **94** | 「`lib.rs` 的 **25 个命令**：…」 | 删掉 `probe_mkv_tracks` / `transcode_target` / `transcode_audio_start` / `transcode_audio_cancel` / `extract_subtitle_text` / `extract_subtitle_text_url` / `pgs_open` / `pgs_image` / `pgs_close` / `pgs_current` 共 10 条 → 约 15 个命令 |
| **96–102**（`http_range.rs` 5 条要点） | 整节 | **删除** |
| **106** | 「**六个** `@JavascriptInterface`」 | 「**五个**」（`AudioDecodeService` 桥随 A5 删除） |
| **110–111**（桥表） | 含 `AndroidAudioNative` 行 | 删该行 |
| **126** | 「**每条桥是单链**：有请求在跑时再发会被直接拒绝（前端也要自己挡，见 §7）」 | 删掉音轨相关举例；改为「`AndroidNetwork`/`AndroidThumbnails`/`AndroidUpdate` 仍是单链」 |
| **128–160**（§4.3 音轨处理链整节） | 含 ASCII 图（131–137）、命令表（141–150）、模块分工（154–158）、关键数据（160） | **整节删除**（连同小节标题 `### 4.3 音轨处理链`）；`### 4.4` 起后续小节编号顺移 |
| **154** | 「`AudioDecodeService.kt`（**873 行**）」 | 文件已删 |
| **158** | 「`android-audio.js`（**330 行**）」 | 文件已删（且实测 330 行本来是对的，删了就不需要维护） |
| **220** | 「`MainActivity.kt`（**342 行**）—— …`setupWebView()` 注册全部 **6** 个 JS 接口」 | 实测已是 369 行（`Measure-Object -Line`）/ 401 物理行，"342"已过期；改为「注册 **5** 个 JS 接口」 |
| **234** | 「`index.html`（**3436 行**） | 播放核心：…**MSE 流式音轨**、网络源适配」 | 实测 3449（`Measure-Object`）/ 3668 物理行；改「≈2,450 行」（删掉 ≈1000 行后），去掉"MSE 流式音轨" |
| **275** | 「Streaming audio (fragmented MP4 + MediaSource) is verified…**PGS bitmap subtitles are verified via libpgs**.」 | 两条能力已移除；PGS 改由 libass 渲染，验收项要换成"libass 渲染 PGS/ASS 正确" |
| **283** | 「WebView 中 `crossOrigin` 媒体与 asset 协议有关；**Range 上限约 1 MB**。」 | 换成 libmpv 后视频不再经 `<video>`，`crossOrigin` 这条坑（W10）只在"残留 WebAudio"时成立；Range 上限也不再约束播放（mpv 自己发 Range）。建议改写为「网络源订阅式读取仍走本机 Range 代理；`<video>` 时代的 crossOrigin/1 MB 上限已不适用于 libmpv 播放路径」 |
| **52** | 「…After its commit, the user approved starting the Windows Bplayer audio-conversion port…」 | 该决策随内核替换撤销，应标注「已撤销（libmpv 迁移）」 |

### 6.3 不需要改但容易被误改的

- **25–26 行的 §4.2 异步请求-回复协议**本身没错，只是桥的数量从 6 变 5；`trustedPage()` 信任检查（`http://tauri.localhost`）在 mpv 方案下仍需要（`AndroidNetwork` 等桥还在）。
- **§4.4 网络存储（162–198）**、**§4.5 缩略图（200–207）**、**§4.6 更新检查（209–216）** 全部保持原样 —— 这是本次迁移**不动**的三块。
- **§7 的 279–283（CSS containing block）、287（无线调试 5555）、288（devtools socket）、289（GitHub Release 排序）** 与内核无关，保留。

---

## 7. 建议的执行顺序（降低"半删"风险）

1. **先删前端流式态**（C3 + C13 的音频部分 + `__bplayerStream`），因为它是唯一能在后台持续消耗 CPU/磁盘的东西；同时把 `tmp/stream-probe/*.js` 标记为失效。
2. **再删 PGS 与字幕抽取**（C4 + C9/C10 + B1/B2/B3 + `network_subtitle`/`subtitle_reader`），注意枢纽 3 的交叉点：网络 PGS 走的是音轨桥。
3. **然后删音轨桥**（C1 + A1–A5 + D1/D2 + C5/C6/C7/C8），这一步会一次性清掉 ≈4,400 行，也是唯一的"编译期全红"步骤。
4. **最后反转 `PlaybackAudioFocus`**（D3 + D5），并同步重写 AGENTS.md 的 §3（5 条）、§4.1–§4.3、§7（3 条）。
5. 每一步都单独可编译、可在真机上验证；**不要**把 1–3 合成一次提交，否则出问题时无法判断是"哪个补偿链"在起作用。

---

## 附录 A：判定速查

| 现象 | 补偿代码 | 换 libmpv 后 |
|---|---|---|
| 影片有声音但只有一条轨，切轨要等两分钟 | A1–A5 + C1 + C3 | mpv 原生 `track-list` 秒切 |
| 播《潘神》这类全 PGS 片子要等 10 秒解析 | B3 + C4 | libass 直接渲染，零等待 |
| ASS 字幕只剩白字，样式全丢 | `android-sidecars.js:toVtt` + C11 | libass 完整还原 |
| 接电话时播放器还在响 | `PlaybackAudioFocus` 只发会话许可（W3） | 真的申请焦点后自动暂停 |
| 网络源字幕抽 17 秒 | B1 + B2 | mpv 自己读，与播放同步 |
| 长片播到 2 小时静音 | C3 的 `trimStreamBuffer`（W11） | 不存在（mpv 自己管缓冲） |
