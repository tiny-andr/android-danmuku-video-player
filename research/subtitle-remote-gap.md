# 网络源内嵌字幕抽取：安卓与桌面的差异（交接）

## 现象

NAS 上同一部片（`The.Boy.and.the.Heron.2023.BluRay.2160p.Dovi.HDR.x265.DD.5.1.5Audio-MTeam.mkv`，
7.56 GB）的内嵌 SRT：

- 桌面版：点一下几秒出字幕。
- 安卓：`⏳ 字幕抽取中…` 一直挂着，最终超时（worker 侧 15 分钟上限），一条也没抽出来。

安卓本地文件走的是和桌面完全相同的稀疏抽取，所以问题只出在**网络源**。

## 两边全流程对比

| 环节 | 桌面 | 安卓（本地文件） | 安卓（网络源） |
|---|---|---|---|
| 解析实现 | `mkv_sub::sparse_extract_srt` | **同一份代码**（`lib.rs::extract_subtitle_text`） | ~~无~~ → 本轮补了同一份代码走 HTTP |
| 字节来源 | `std::fs::File`，路径是 OS 挂载的 SMB | `std::fs::File`（/sdcard） | 原来：ffmpeg 顺序读本机媒体代理；本轮：`http_range::HttpRangeReader` |
| 读取模式 | 按 Cues 跳读（每条字幕一次小读） | 同左 | 同左（本轮）／原来顺序读整片 |
| 实测耗时 | 几秒 | 秒级（毫秒级的 /sdcard seek） | 原来 ~40 分钟；本轮 ~5–10 分钟 |

关键：桌面端能"秒出"，靠的是 **OS 挂载的 SMB + 稀疏读**；安卓没有可挂载的 SMB，
所有网络字节都必须经本机 NanoHTTPD 代理，**每次小读都是一个 HTTP 请求 + 一次 SMB 往返**。

## 根因量化（真机实测）

1. 原路径（ffmpeg 顺序抽取）：
   - `-map 0:s:N -c:s srt` 必须 demux 整片，7.56 GB / 3.1 MB/s ≈ **40 分钟**；
   - 前端给 worker 的超时是 15 分钟，必然失败；
   - 抽取期间还把音轨流式播放的 SMB 带宽挤没（`stream-read-fail TimeoutError`）。
2. 稀疏路径（本轮）：
   - Cues 索引 + 每条字幕一次小读，约 1500 次请求；
   - 单次请求（32 KiB 块 + 64 KiB 预读）实测 **150–250 ms** → 4–8 分钟；
   - 已确认链路正确：能读到 Cues、能按 `CueClusterPosition + CueRelativePosition` 定位簇和字幕块，
     只是慢，不会报错（5 分钟时仍在跑）。

## 本轮已落地的改动（都在工作区，未提交）

| 位置 | 内容 |
|---|---|
| `src-tauri/src/mkv_sub.rs` | `locate_cues` / `read_cues` 泛型化为 `R: Read + Seek`；新增 `sparse_extract_srt_reader`，原 `sparse_extract_srt(path)` 变成薄包装 |
| `src-tauri/src/http_range.rs`（新） | `HttpRangeReader`：按 `Range: bytes=a-b` 随机读，32 KiB 块缓存，`read` 循环读满（对 `mkv_sub` 里"一次 read 就当读满"的假设让步） |
| `src-tauri/src/lib.rs` | 新命令 `extract_subtitle_text_url(url, size, subs, durationUs)`，与本地版共用解析 |
| `Cargo.toml` | 加 `ureq`（`default-features = false`，只走明文 127.0.0.1） |
| `AndroidAudioNative.kt` | 新命令 `subtitle_reader` / `subtitle_reader_close`：建一个 64 KiB 预读的媒体代理 URL 并持有到抽取结束 |
| `NetworkRemote.kt` 等 | `open(...)` 增加 `prefetchBytes` 参数（默认 4 MiB）；字幕读取器用 64 KiB，避免"每读 32 KiB 白拉 4 MiB" |
| `ui/index.html` | 网络源内嵌字幕：先走 Rust 稀疏抽取（只抽点中的那条轨），失败才回落 ffmpeg 顺序抽取 |

已验证：JS/Rust/Kotlin 全部编译通过，APK 已装到 HONOR VER-AN10 上跑通链路（无异常、无崩溃）。

## 卡点

**安卓 SMB 单次读的固定开销 ~100–200 ms**（smbj + NanoHTTPD + 每请求一次 SMB2 READ），
而稀疏抽取天然是"几千次小读"。桌面没有这个开销（OS 客户端 + 页缓存 + 随机读几毫秒）。

在不改 SMB 读延迟的前提下，无论怎么调块大小/预读，1500 次请求就是 3–5 分钟起步。

## 下一步候选（按性价比）

1. **降小读延迟**：给 `NetworkRemote` 加"批量区间读"接口（一次 SMB READ 返回多个不连续区间，
   或在 Kotlin 侧把相邻 cue 的请求合并），把 1500 次压到几百次。
2. **Kotlin 侧预取**：Rust 先读 Cues 拿到全部 `cluster_abs`，一次性回传，由 Kotlin 按 4–8 个
   相邻簇一批读取并缓存，Rust 再从缓存解析。等于把"随机读"变成"批量顺序读"。
3. **换协议**：NAS 侧同时开 WebDAV/HTTP，Android 直接对服务器发 Range 请求，绕开 smbj
   的固定开销（需要用户侧配置，未必可接受）。
4. 如果都不做，至少把网络源的内嵌字幕入口标注为"需要数分钟"，别让用户以为卡死。

## 关键代码索引

- 桌面稀疏抽取：`H:\Project\Bplayer\src-tauri\src\mkv_sub.rs`（`sparse_extract_srt`）
- 桌面兜底：`H:\Project\Bplayer\src-tauri\src\transcode.rs`（`extract_subtitle_text`，安卓没有 ffmpeg 兜底）
- 安卓本地：`bplayer-android/src-tauri/src/lib.rs::extract_subtitle_text_impl`
- 安卓网络：`bplayer-android/src-tauri/src/lib.rs::extract_subtitle_text_url` + `http_range.rs`
- 代理与预读：`NetworkMediaServer.kt`、`NetworkRemote.kt::PositionedNetworkStream`
- 前端入口：`ui/index.html::extractNetworkSubtitle`（网络）/ 同函数上方的本地分支
