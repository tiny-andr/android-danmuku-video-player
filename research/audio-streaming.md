# 流式音轨（边转边播）

内核解不了的音轨（DTS / TrueHD / AC-3 …）不必等整条转完：ffmpeg 编成碎片化 MP4，
前端用 MediaSource 边收边播，首块百毫秒级出声。整段转码 + `(音轨N).mka` 缓存仍然保留，
流式失败或 MSE 不可用时会自动回落。

原型来自 Windows 端 `Bplayer/src-tauri/src/audio_stream.rs`，那边是「ffmpeg 转 fMP4 →
stdout 管道 → MSE」，本仓库因为 FFmpegKit 的限制换了传输方式。

## 与 Windows 实现的三处差异

| 环节 | Windows | Android |
|---|---|---|
| 传输 | Rust 读 ffmpeg 的 `pipe:1` | FFmpegKit 把 stdout 当日志接管，拿不到二进制 → ffmpeg 写 `cacheDir/stream/<jobId>.mp4`，主进程按偏移增量读 |
| 进程 | ffmpeg 子进程与后端同进程 | ffmpeg 在独立进程 `:audio_transcode`，文件同 uid 可见，IPC 只传「读了多少 / 取消 / 终态」 |
| 背压 | 不读 stdout，pipe 满 → ffmpeg 自己阻塞 | 文件不会阻塞 → 前端 pull 节奏控队列（`STREAM_QUEUE_BYTES` 见底才拉下一块）+ 512 MiB 目录上限 |

## 数据流

1. `hooks.stream`（`android-audio.js` 的 `select()`）在需要转换且无 mka 缓存时被调用。
2. `audio_stream_open` → `AndroidAudioNative.openStream` 建 `AudioSourceAccess`（网络源的
   NanoHTTPD 代理要活到流结束）、建 `cacheDir/stream/<id>.mp4`、让 worker 起单进程 ffmpeg。
3. worker 回 `STARTED`，主进程才 reply「流已就绪」。
4. 前端 `audio_stream_read` 循环：Kotlin 从文件读新增字节 → 按 ISO-BMFF box 边界切成
   `init`（ftyp+moov）与每个 `moof+mdat`（1 秒）→ base64 回给页面。
5. 页面 `SourceBuffer.appendBuffer`，`updateend` 后再拉下一块；`eof` 时 `endOfStream()`。
6. seek 到未缓冲位置 / 换轨 / 退出播放：`audio_stream_close`（取消 ffmpeg + 删文件）。

ffmpeg 参数（`AudioDecodeService.streamArgs`）：

```
-hide_banner -nostdin -v error -y -probesize 2097152 -analyzeduration 3000000
[-ss <startSecs>]  -i <input>
-map 0:a:N -vn -sn -dn -map_metadata -1
-c:a aac -profile:a aac_low -ac 2 -ar 48000 -b:a 192k
-af asetpts=PTS-STARTPTS
-f mp4 -movflags +frag_keyframe+empty_moov+default_base_moof
-frag_duration 1000000 -flush_packets 1
<output>
```

`-frag_duration` + `-flush_packets 1` 是硬要求：少了它们 muxer 会攒到结束才落盘，前端永远读不到数据。

## 踩过的坑

- **外挂元素的 offset 必须是 0**。流的 `timestampOffset` 已经把这路音频摆到视频时间轴上，
  再减一次 `startSecs` 会把定位点挪到缓冲之外，元素停在 `readyState=1`、`decodedBytes=0`。
- **`ms.duration` 要在第一次 `appendBuffer` 之前设**。之后设会因「低于已缓冲末端」被拒
  （`InvalidStateError`）。
- **半个 box 不能交给 MSE**。切块器遇到不完整的 box 必须留在缓冲里等下一批。
- **`#player video` 查询可能为空**，seek 监听要挂在 `art.video` 上，否则流式音轨在 seek 后
  不会重起（表现为跳转后无声）。
- **AbortError ≠ 失败**。换轨时 `cancelSession` 会拒掉在途的 `audio_stream_read`，这类
  错误要静默忽略，不能计入重试次数（否则会误报「音轨流中断」）。
- **页面重载后旧流会占着 worker**。`openStream` 先关掉所有旧流，worker 收到新 `STREAM`
  也先把旧流顶掉，否则报「音轨任务正忙」。
- **流式与 PROBE 必须能共存**，否则换轨时 probe 被拒。只有整段转码（`CONVERT`）与流式互斥。

## 实测记录（HONOR VER-AN10，Android 17 / Chrome 151 WebView）

| 场景 | 结果 |
|---|---|
| MSE 能力 | `MediaSource.isTypeSupported('audio/mp4; codecs="mp4a.40.2"')` = true；真 append 3 秒 fMP4 后 `buffered=3.02`、`currentTime=0.958`、`decodedBytes=29852` |
| 本地 DTS（20 秒片） | 启动到 `eof` 0.7 秒，`readyState=4`、解码字节持续增长 |
| 本地 DTS-HD MA（2 小时 4K，35 GB） | 边转边播，缓冲持续增长；seek 到 1800s 触发 `stream-restart`，新缓冲从 1800 起，音画同步误差 < 0.2s |
| SMB 网络源（AC-3 ×5，7.5 GB） | 断点恢复 + 二次 seek 均正确重起；持续缓冲；无 SMB 异常 |
| 换轨 | 旧流 `stream-stopped`、新流从当前播放位置起，音轨菜单状态正确 |
| 退出播放 | `cache/stream` 清空，音轨增益恢复 |
| 回落 | 禁用 `MediaSource.isTypeSupported` 后选无缓存音轨 → 走整段转码（状态显示「正在处理选中的音轨…」），无残留流 |
