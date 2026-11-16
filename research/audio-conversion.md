# Android audio compatibility conversion

## Scope and Windows reference

The user requested this work after local subtitle/sidecar commit `8d2c090`. The Android project is a port of `H:/Project/Bplayer`; that checkout was inspected read-only and not modified.

The Windows implementation converts one selected audio-only ordinal to AAC-LC stereo at 192 kbit/s and stores `Video (音轨N).mka` beside the original video. It does not transcode video or generate the old full-film `(AAC)` variant. Android retains that final naming/location, original video path, subtitle/danmaku clock, navigation origin and resume key. A two-hour audio track is approximately 173 MB. Extracting it can still require reading much of an interleaved source movie.

PiP and hold-to-speed remain excluded. A bound, non-exported isolated worker is an implementation detail, not a background-playback service; leaving the foreground cancels work. Chromium remains the only audio-focus owner.

## Components

- `AndroidAudioNative.kt`: trusted-origin request bridge, serial bounded command queue, UUID session/permit/job ownership, source/cache validation, progress and terminal events.
- `AudioWorkerClient.kt`: Messenger connection, per-call response ownership, cancellation, timeouts and binder-death handling.
- `AudioDecodeService.kt`: bound worker in `:audio_transcode`, asynchronous argument arrays, selected-track decode/encode, metadata tags, output probe and owned staging cleanup. The process name uses an underscore; a hyphen was rejected by the physical device's package parser.
- `AudioMedia.kt`: source identity, FFprobe normalization, timeline offset, cache acceptance, disk preflight, independent source access and local publication.
- `AudioCacheTransfer.kt` and the SMB/SFTP/WebDAV implementations: exclusive remote temporary creation and no-overwrite publication beside the video.
- `android-audio.js`: request/event transport, UUID playback sessions and a staged HTML Audio clock follower. Vendor player files are unchanged.

## Dependency lock and limits

The exact native dependency is `dev.ffmpegkit-maintained:ffmpeg-kit-min:8.1.7` (LGPLv3-or-later), not a GPL, audio or full variant. Its AAR is 16,151,151 bytes, SHA-256 `591ddcf3698028e838b854dc775e60aedaf43fffd59689cb59b8af632aba3d76`. The contained FFmpeg identifies as `n8.1.2`; artifact and FFmpeg version namespaces differ.

The published min POM omits a required Java runtime dependency. Static initialization immediately calls `com.arthenica.smartexception.java.Exceptions`; the AAR does not contain that class. Explicitly add `com.arthenica:smart-exception-java:0.2.1`, whose POM brings `smart-exception-common:0.2.1`. Both are BSD-3-Clause. Their SHA-256 values are respectively `5b96aaa5f191dedbef72fb0c38f1a2b01807920afc0d92a75a2acd6e0cc7703c` and `1cad0fb4dfa01755a014331b5ed199281d2c3fab5aca5c9d7abd0b41d0ec3f7b`.

The artifact was first obtained from Aliyun Central and compared against public Huawei/Central checksums and the corresponding GitHub asset digest. Static ELF relocation/codec registration checks confirm native DTS/DCA, TrueHD, AC-3 and E-AC-3 decoders and native AAC encoding. All nine arm64 JNI ELF files have 16 KiB PT_LOAD alignment. This is not equivalent to runtime certification or final APK zip alignment. AC-4 and DRA were not certified and must not be advertised as supported.

Sources-JAR Java API files match upstream tag `v8.1.7` commit `62b07bf097baf26b416c815aea514e05c9ad6d63`; release tag `v8.1.7-lts-android` is a different commit. A full reproducible native rebuild and publisher-signature verification were not performed. AAR resources include LGPL and cpu_features license texts; app distribution must retain notices and the appropriate corresponding-source/build/relink information. This document is not a legal opinion.

References:

- https://github.com/ffmpegkit-maintained/ffmpeg
- https://repo.maven.apache.org/maven2/dev/ffmpegkit-maintained/ffmpeg-kit-min/8.1.7/
- https://repo.maven.apache.org/maven2/com/arthenica/smart-exception-java/0.2.1/
- https://www.rfc-editor.org/rfc/rfc4918.html#section-9.9

## Task and storage contracts

Requests are `audio_probe`, `audio_prepare`, `audio_start`, `audio_cancel` and `audio_cache_files`. The first four use a UUID session, with a native prepare permit/job UUID. Progress/completion/error events carry session, jobId, video path and audio index. Same-path reopen is a different session. Cancelling a known job does not end the session; only exit/replacement sends a session-wide cancellation. Job tombstones cover permit-to-running transfer races.

The worker has one active native session. Cancellation targets only that FFmpegKit session, retains the slot until asynchronous exit, then replies after releasing it. An unresponsive cancellation terminates only the positively identified isolated worker process. Probe stages have 30-second deadlines; conversion has a 30-minute deadline. Binder probe JSON is capped at 128 Ki characters rather than truncated.

Output staging is app-private, at most 512 MiB per task. A periodic/statistics size guard plus an FFmpeg `-fs` sentinel and final size validation prevent oversized/truncated output from being published. Local publication temporarily needs two copies, so space preflight reserves both plus headroom. Final completed caches are beside the source video, never silently relocated to private persistent storage.

Network reads use a dedicated `TRANSCODE` proxy/connection set, not the active playback pool. Probe delivery is cumulatively capped at 32 MiB; credentials remain in Android. Each proxy permits only its bound file and freezes the complete source configuration snapshot. Editing an existing source ID cannot mix a new server/root with an old fingerprint/publisher. The source size, mtime and bounded first/last 64 KiB fingerprint are rechecked before publication. This is not a full source-file cryptographic scan.

New caches carry version/source-identity/track/offset metadata. Acceptance requires exactly one AAC stereo stream, valid duration and matching tags; a known selected-track duration receives a two-sided tolerance check. If only container duration is available, it is an upper bound, not proof that the audio occupies the entire movie. The worker reports whether exact duration was verified. Legacy Windows caches have no identity tags and are accepted conservatively only when AAC stereo, full expected duration and known cache/source modification ordering match; the UI discloses their limited source-version validation. Invalid/conflicting caches are not overwritten automatically.

Remote publication is one attempt and never placed inside a retrying connection-pool action:

- SMB: `FILE_CREATE` exclusive unique temporary, bounded writes, flush/length checks, same-handle `rename(..., false)`. Cleanup only uses the pre-publication owned handle.
- SFTP: `CREAT|EXCL|WRITE` unique temporary, acknowledgements/length/path checks, ordinary v3 no-overwrite rename. No posix overwrite rename. When safe identity-conditioned deletion is unavailable, a failed task can leave its uniquely named temporary file instead of risking another file.
- HTTPS WebDAV: conditional PUT `If-None-Match:*` must return 201 and a strong ETag; HEAD validates the same ETag and size; MOVE uses `Overwrite:F` and `If-Match` and must return 201. No redirects, unconditional overwrite, COPY fallback or retry after ambiguous commit. Missing mtime/strong ETag or unsupported conditional operations fail closed.

## Playback synchronization

Before explicit video play/source replacement, the original video audio is routed through a zero-gain WebAudio branch. Only a confirmed native default first track is released. This prevents a temporarily playable commentary/language track from leaking while the desired default is being probed or converted.

A new external Audio element sets CORS before src, starts muted, waits for metadata, seeks to the latest `video.currentTime - offset`, waits for seek completion and only then follows the video's paused/rate/volume/mute state. Waiting/seeking/background states pause it; old source callbacks and play promises cannot revive it. Normalized cache timestamps start at zero, with source timeline offset stored separately. Android does not automatically switch the video source to an old full-film `(AAC)` cache.

## Verification status

Passed before final physical conversion testing:

- Arm64 APK build and native Gradle unit tests, including cache naming, transfer/cancellation and media identity/duration checks.
- `probe/audio-frontend-check.cjs`: 12 mock groups for bridge lifecycle, initial selection cancellation, retry, same-path session ownership, staged seek/paused mounting, buffering, timeline offsets, default-track selection and cache policy.
- `probe/navigation-core-check.cjs`: 14 groups after adapting the empty-audio-menu context.
- `probe/audio-container-device-check.cjs`: real AAC-LC stereo `.mka` and `.m4a` decode, seek, 1.5x rate, pause and nonzero WebAudio PCM energy on the installed WebView. This validates container decode, not yet the app's complete conversion chain.

The first full-chain device attempt identified the invalid process-name spelling. The next reached binding but the worker crashed at Java initialization; bytecode/runtime closure auditing identified the missing smart-exception libraries. Both issues were corrected and the complete native/device chain subsequently passed.

- `probe/audio-device-check.cjs`: actual DTS-default MKV, TrueHD MKV and AC-3 MP4 conversion, same-video-path playback, paused mounting, seek to 5 seconds, 1.5x rate, cache reuse with automatic conversion disabled and manual alternate-track selection. Each eight-second cache is approximately 196 KB.
- `probe/audio-output-check.cjs`: pulled device fixtures retain their original SHA-256 byte-for-byte. All three caches contain exactly one AAC stereo stream, correct ownership tags and approximately 8.02 seconds. Decoded PCM RMS is approximately 0.088 with a 440 Hz target tone, not the 880 Hz alternate/commentary tone.
- `probe/audio-network-device-check.cjs`: real saved SMB source, 6,970,949-byte short video, a 718,407-byte completed same-directory `.mka` cache, unchanged source size/mtime, verified non-legacy native cache reuse and synchronization while paused. This creates only the derived audio cache; the source video is not overwritten. WebDAV/SFTP live-server publication is not certified by this SMB evidence.
- A separate real SMB cached mount while video kept playing reached external-audio readyState 4; audio time 3.932487 versus video time 3.906667 (about 26 ms difference), with the original sound isolated. A physical ADB screenshot of the audio panel was inspected.
- `probe/audio-cancel-device-check.cjs`: real two-minute DTS fixtures verify running-job cancellation, missing incomplete final cache, same-session probe/retry, cancelled prepare permits and playback-exit cleanup. This caught Android `JSONObject.optString` turning explicit JSON null into a nonempty string; cancel parsing now uses `isNull` and has a native unit regression.
- The final native Gradle suite contains 61 tests with zero failures/errors, including 27 audio-cache/media/worker checks. The final APK passes `zipalign -c -P 16 4` in addition to the ELF alignment audit.

Fixture generators and probes use project-owned small test media, restore user preferences and do not repair or replace user source videos. The Windows checkout remains untouched. The user subsequently authorized direct local submission of the completed audio batch after regression; no push or release is authorized.
