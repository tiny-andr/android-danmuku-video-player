# Thumbnail performance investigation

## Scope

This batch improves thumbnail latency and adds explicit, single-entry recent-history deletion. Manual subtitle/danmaku loading, audio processing, PiP and background playback remain separate batches. Hold-to-speed was explicitly declined.

## Evidence and root causes

The existing extraction API was not inherently the wrong choice. Android recommends `getScaledFrameAtTime()` for thumbnail-sized output and documents the extra cost of arbitrary-frame `OPTION_CLOSEST` compared with sync-frame options. The implementation already used scaled output and `OPTION_CLOSEST_SYNC`.

- Android platform reference: https://developer.android.google.cn/reference/android/media/MediaMetadataRetriever
- Media3's newer asynchronous frame extractor: https://developer.android.google.cn/media/media3/inspector/extract-frames?hl=zh-cn
- Jellyfin's pre-existing/sidecar artwork convention: https://raw.githubusercontent.com/jellyfin/jellyfin.org/master/docs/general/server/media/_metadata-images.md

A different decoder cannot remove the cost of opening a remote container, reading its index and reaching an independently decodable frame. Pre-generated artwork avoids that work entirely, but this batch does not modify the NAS, scrape movie artwork or introduce a media-server requirement.

Confirmed problems in the previous implementation:

1. JavaScript serialized all requests, including private-cache reads, behind remote extraction. The native source worker had the same head-of-line blocking.
2. Each cache miss opened a new independent SMB connection, authenticated, validated the path and opened the video. Cancellation was registered only after construction, leaving connection/authentication setup outside immediate cancellation.
3. Decoder reads crossed synchronous Binder and remote exact-read boundaries without an application block cache. Duplicate/small reads could repeatedly consume network operations and byte budget.
4. A task timeout replies after roughly four seconds, but does not itself prove that connection/decoder cleanup has completed. Queue delay is additional. Repeated failed files can delay later entries.

Mechanical-disk seek latency or spin-up can contribute, but no server-side disk tracing was done. Do not claim the hard disk is the sole cause: one measured remote open/stat stage took only 114-141 ms, while subsequent frame work consumed most of the request.

## Changes

- A separate, bounded native cache worker and JavaScript cache lane. Up to four local-cache requests may be outstanding; remote extraction remains single-active with bounded queues.
- Visible images check the versioned private cache before joining extraction. Recent-history thumbnails remain cache-only and never connect to the NAS from home.
- A metadata-keyed, 60-second failure cooldown avoids repeatedly decoding the same failed file during scroll/re-render. Cache probes still work during cooldown, so newly captured images can appear.
- Decoder-side 64 KiB aligned blocks, at most 32 blocks (2 MiB), cache repeated reads. Every block fill still passes through the 12 MiB/task, 64 KiB/read budget. The limit was not bypassed, and no playback connection is reused.
- SMB cancellation is installed before connection/authentication. Sockets created after cancellation are rejected.
- Playback caches a non-black frame already decoded by WebView. It does not open a second video connection. Up to six attempts are separated by at least two seconds; errors or a tainted canvas fall back silently without a hidden remote scan. Native storage accepts only bounded JPEG data with valid dimensions no larger than 320 by 320, and uses the existing private 32 MiB LRU.
- Diagnostic replies expose queue/open/decode duration, requested video bytes/read calls and extraction phase, but no credentials or file paths. These are reply-time measurements, not proof of cleanup completion.

## Physical-device results

Measurements are individual observations on the connected phone and saved SMB source, not throughput guarantees or a controlled server-disk benchmark.

| Scenario | Observation |
| --- | --- |
| Previous network MP4 extraction | 4010 ms, timeout, no image |
| Previous local cached image requested alongside that extraction | 4052 ms, despite being a cache hit |
| New local cached image alongside a slow extraction | 14 ms, zero video reads |
| New first successful SMB thumbnail, Gemini Man MP4 | 2293 ms; about 5.1 MiB reserved across 82 reads |
| New first successful SMB thumbnail, Dying to Survive MP4 | 2548 ms; about 5.0 MiB reserved across 80 reads |
| Subsequent cached Gemini Man thumbnail | 13 ms |
| Large 2012 MKV | 4011 ms timeout during frame phase; about 9.9 MiB reserved across 158 reads |
| Save already decoded playback frame | 44-71 ms, no additional video reads; immediate private-cache read verified |

The large MKV remains a bounded cold-extraction failure. This patch does not promise that every unplayed network file will acquire a thumbnail. Reliable instant full-library artwork requires pre-generated images or a dedicated thumbnail index; it should be a separately agreed feature rather than silently increasing reads, concurrency or timeout.

## Validation

- `probe/thumbnail-view-check.cjs`: cache fast lane under blocked extraction, cache-only isolation, visible priority, cooldown/version changes, bounded lanes, cancellation, stale replies, black-frame rejection and canvas failure.
- `probe/thumbnail-core-check.ps1`: byte budget, EOF, cancellation, deadline, block reuse, cross-block reads, short reads, LRU eviction and private versioned cache; Android bridge/service API compilation.
- `probe/thumbnail-capture-device.js`: actual WebView video capture and private-cache roundtrip, plus six invalid submissions rejected (invalid JPEG, private path, zero size, negative modification time, oversize dimensions, PNG).
- `probe/recent-delete-check.cjs`: 14 groups covering gesture arbitration, stable-path deletion, cancellation, caller Back, two views and scroll anchors.
- `probe/recent-delete-device.cjs`: real CDP touch events, narrow/wide layout, confirmation, Back, move cancellation, and preservation of the source file and resume record. Test records/preferences restored afterward. The normal-width screenshot was reviewed; emulated-wide CDP screenshots can contain tiled compositor artifacts and are not evidence of physical inner-display rendering.
- Navigation core/browser/device regressions and existing keep-awake/resume/sorting tests pass. Native unit-test task succeeds. The final APK is installed; test UI is closed and playback keep-awake released.
