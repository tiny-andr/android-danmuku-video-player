# Manual sidecars and subtitle preferences

## Approved scope

The previously accepted feature batch was committed locally as `d127c47`. The user then chose only manual subtitle/danmaku loading and subtitle settings. Picture-in-picture was explicitly cancelled; audio processing and background services were deferred. This batch does not add native media dependencies, alter source videos or write to network storage.

## User entry points

- Playback information card: **Subtitles** and **Load danmaku**. Wide windows also retain the direct subtitle action.
- The subtitle panel remains accessible even when no automatic subtitle matched. Select a local or network SRT, VTT, ASS or SSA from any folder.
- The danmaku panel accepts Bilibili XML and array-format JSON. A clear action removes only the current in-memory danmaku, not the source file.
- Subtitle delay ranges from -10 to +10 seconds in 0.1-second steps; negative is earlier, positive is later. It resets on the next video.
- Font size, white/yellow/cyan text, outline, position and automatic language preference preview immediately. Defaults are small (18 CSS px), no outline and inside the picture bottom. Only the explicit Save action persists them; existing explicitly saved choices are retained. Manual selection always wins over automatic matching. Recognized filename/language tags rank automatic candidates; unknown language is not guessed.
- Position 1 follows the actual visible video picture bottom with a 12 CSS px inset. Position 2 starts 8 CSS px below it, falling back inside when the black border cannot fit the text. The layout derives contain/cover bounds from real media dimensions, rather than the full foldable window. Resize/metadata/fit/control changes relayout without changing subtitle timestamps.

## Format and rendering contract

`android-sidecars.js` decodes UTF-8, BOM-marked UTF-16LE/BE and GBK fallback. It normalizes SRT/VTT/ASS/SSA into safe, plain-text WebVTT. ASS/SSA retain text and timing, including multi-digit layers, traditional Marked fields, dialogue commas and line breaks, but do not retain animation, karaoke, positioning or original styles. Drawing segments are excluded.

The bundled Artplayer ASS conversion was tested and found to generate invalid cue/header separators for standard input. The new converter is separate; vendor files are unchanged.

`android-subtitle-view.js` loads a candidate hidden HTML text track. Only a successful load belonging to the current video and selection may replace the current track. Invalid, timed-out or stale candidates leave existing subtitles intact. Rendering uses exactly one entity decode and `textContent`, never untrusted HTML. A sorted cue index and cumulative end-times support overlapping cues and offset lookup. Frame/timeupdate/seek events repaint without mutating cue timestamps. Track nodes, frame callbacks and Blob URLs are released on replacement, cancellation or exit.

## Ownership and navigation

- Attachment pickers have `subtitle` and `danmaku` modes, independent scroll keys, matching extension filters and no thumbnail requests. Video list/grid preference is not overwritten by attachment browsing.
- Opening or cancelling a picker does not claim a resource generation or suppress a pending automatic match. Only a non-empty, still-current selection claims manual ownership.
- A selection carries video token, stable video path and resource generation. Old file reads, parsing tasks and automatic pair results cannot overwrite a later manual choice or another video.
- Attachment selections consume their one-use browser snapshot but never call playback begin or rewrite the session's origin. Exiting playback still returns to the original video directory or playlist.
- Local Rust and native network reads reject non-files and files over 32 MiB, and enforce a cumulative read limit rather than trusting only a front-end size check. Subtitle reads are decoded once instead of fetching the same network file twice.

## Verification

- `node probe/sidecar-core-check.cjs`: 14 groups for encoding/BOM, malformed input, cue syntax, ASS/SSA variants, drawing removal, safe text/entities, language recognition, preference whitelist and candidate ownership/ranking.
- `node probe/subtitle-view-check.cjs`: atomic track promotion, stale/invalid/empty candidates, delay direction and non-accumulation, overlapping cues, timeout, cancellation and complete node/URL cleanup.
- `node probe/storage-navigation-check.cjs`: 10 groups including four picker modes, no attachment thumbnails, independent anchors, version-1 snapshots and caller cancellation.
- `probe/sidecar-device-check.cjs`: actual local native fixture reads and HTML track parsing, Chinese SRT/UTF-16, ASS/SSA/VTT, invalid-file preservation, native oversize rejection, explicit-save behavior, XML/JSON, slow-A/fast-B and close-during-read races, automatic loading after picker cancellation, stale pair suppression and original playback origin. Three virtual network-source variants are routing tests with mocked transport and native local fixture reads, not live WebDAV/SFTP certification.
- Separate real SMB validation read an existing ASS file into **1,454 cues in 533 ms** and an existing XML file into **23,159 comments in 1,434 ms**, using saved encrypted credentials without reading or returning passwords. No NAS files were modified.
- `probe/sidecar-layout-check.cjs`: controls remain hit-testable at 415x931, 845x919, 320x720 and 931x415, including repeated resizing. A normal-width physical-device screenshot was inspected. These emulated sizes are not a claim of new physical fold testing.
- Existing navigation-device regression passed 10 groups; navigation core, recent deletion, thumbnail scheduling, keep-awake settings, resume storage and file sorting regressions also pass. The arm64 APK was built and installed successfully.

- `probe/subtitle-position-device-check.cjs`: 24 actual WebView cases across 845x919, 415x931, 931x415, 720x1200 and 1200x720, repeated fold-sized resizing, contain/cover and inside/below fallback. Subtitle text, defaults, horizontal bounds, baseline and lack of clipping are asserted. A separate ADB screenshot on the physically expanded 845x919 window was inspected with decoded video readyState=4; it confirms the default subtitle is inside the picture, not the window bottom. CDP full-window screenshots can distort composited video and are not used as physical screenshot evidence.

Reusable fixture generation lives in `probe/sidecar-fixtures.cjs`. Tests restore preferences and leave the application at home. On 2026-11-16 the user requested these subtitle-position/default corrections and authorized a local commit of the full sidecar batch before beginning the separate audio-conversion port.
