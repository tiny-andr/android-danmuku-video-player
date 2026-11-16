# Android navigation return contract

## Routes and ownership

- A playback session owns one return origin: home/recent, a file-browser snapshot, or an explicitly selected folder playlist.
- Normal exit, pending-resume cancellation, loading cancellation and loading-error Back all release the player and restore that origin.
- Manual episode changes and auto-next replace media in the same session; they do not create a per-episode history or replace its origin.
- An automatically scanned sibling playlist is a playback overlay, not a new return origin. An explicitly selected folder playlist is a return route with its own browser caller.

## Layers

`android-navigation.js` owns the visible overlay stack. Root actions replace sibling overlays, so a playlist cannot obscure an information/track panel that Back closes first. Information-card actions use `forward()` to preserve the card as the caller; closing a child restores it. Wide quick actions intentionally start at the playback root.

The native dispatcher and player top Back call the same function. Touch lock consumes Back by unlocking. The file browser handles its own directory hierarchy. Loading and pending folder scans can be cancelled; remaining overlays pop before playback exits. Artplayer's built-in speed/flip menu participates in the same policy.

Do not directly toggle registered layers from new code. Use `open`, `close`, or `clear`. Cleanup uses `clear` without invoking route-return callbacks. Media readiness events must not dismiss user-opened overlays.

## Browser snapshots

`AndroidFiles.open(mode, section, startDir)` still resolves a selected path or null. `takeSelection(path)` transfers an immutable, one-use snapshot to the initiating flow. `restore(snapshot)` returns another picker promise, not a directory-ready promise.

Snapshots contain directory/source identity, picker mode, sort/view preferences, selected path and a stable item/offset scroll anchor. They contain no directory entries, credentials or video data. Each storage tab retains its own directory. Parent/source-list positions are bounded in memory. An unavailable source restores its original route with an error and Retry rather than silently opening home.

## Async work

Explicit folder scans use a navigation task token. Back cancels the task and restores its caller; newer navigation invalidates the result without opening an abandoned route over the new screen. Existing video tokens continue to guard media and sidecar loading.

## Validation

- `node probe/navigation-core-check.cjs`: overlay nesting, sibling replacement, cleanup callbacks, task ownership, cancellation and scroll anchors.
- `node probe/storage-navigation-check.cjs`: picker snapshots, folder mode, tab/directory/source hierarchy, sort/view anchors, offline Retry and stale results.
- `node probe/navigation-device-check.cjs`: actual Android WebView with real local video decoding and deterministic in-page local/network directory fixtures. Tests nested panels, top/system Back, buffer readiness, lock, resume cancellation, load failure, explicit playlist, auto-next and cancelled folder scans. It restores browser/native test overrides, preferences and playback records, then reloads home. Requires an unlocked device and CDP forwarding; never run it during user playback.

Fixture tests do not prove NAS permissions or network throughput. Separately, a saved SMB source and its existing H.264/AAC movie were read and played on the physical device; Back restored the same live network directory and file. No source credentials or remote files were modified.
