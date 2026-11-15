# Network storage

## Entry points

- Home: Network storage, or the Network storage tab inside either file picker.
- Local shortcuts are above the directory list. Folder mode has one bottom action: use the current folder. Video rows are disabled in folder mode.
- Connections are explicitly tested and saved. Editing with an empty password retains the saved password. Removing a connection never deletes remote files.
- Discover LAN SMB runs only after a button press: bounded mDNS `_smb._tcp` plus one WS-Discovery probe, about seven seconds, up to 32 results. It does not use SMB1, NetBIOS, subnet port scanning, authentication or remote writes. Results are untrusted hints that prefill a new connection, not proof of SMB availability. Servers that do not advertise still require an IP address.
- Connection failures use a high-contrast red alert with an explicit failure title and scroll into view. SMB server status codes distinguish login failures, unavailable shares, permission failures and signing failures; no passwords are included in errors.
- SMB requires a host and share name. WebDAV requires a final HTTPS collection URL. SFTP requires a host, username/password and an explicitly verified SHA256 host fingerprint. Private-key authentication and automatic service discovery are not implemented.

## Transport and security

| Transport | Policy |
| --- | --- |
| SMB | SMB 3.1.1, 3.0.2, 3.0, then 2.1; NTLMv2 and signing required; no SMB1, SMB 2.0 or DFS referral. Use a trusted LAN or VPN. SMB 2.1 is signed, not encrypted. |
| WebDAV | OkHttp HTTP/2 where negotiated, HTTP/1.1 fallback; TLS 1.2/1.3 with normal certificate/hostname validation; HTTPS only. Redirects are rejected, so credentials cannot follow a different origin. Use the final collection URL. The server must support PROPFIND and correct byte ranges. |
| SFTP | SSH 2, modern key exchange/ciphers/host-key algorithms, strict SHA256 host-key pinning. Unknown fingerprints are displayed before authentication and must be independently verified. A changed fingerprint is rejected. |

`AndroidNetwork` implements asynchronous commands over the Android JavaScript bridge. Sources are AES-GCM encrypted with an Android Keystore key and stored under the app's non-backup private directory. The public source model contains `hasPassword`, never the saved password. Neither credentials nor temporary media URLs are put in browser storage.

Android 17 / target API 37 requires the manifest and runtime `ACCESS_LOCAL_NETWORK` permission for LAN sockets. Permission is requested when network access is needed, not on launch. See the [Android local network permission specification](https://developer.android.google.cn/privacy-and-security/local-network-permission?hl=en).

Virtual paths use `/@network/<source UUID>/<raw relative path>`. Spaces, Unicode, `+` and `%` remain filenames, not URL syntax. Local paths continue through the existing Tauri filesystem commands. Remote paths are routed to Kotlin for directory listing, file size, text/bytes, playlists, same-name XML/JSON danmaku and external SRT/ASS/SSA/VTT subtitles.

Remote writes, parent traversal, unsafe path components, SFTP symlinks and SMB reparse points are rejected. WebDAV XML has size/depth limits, rejects DTD/entities and filters cross-origin, out-of-root and non-child hrefs. Text/sidecar reads are limited to 32 MiB.

## Media path

A random-port HTTP server binds only `127.0.0.1`. Each process uses a random 256-bit URL capability. Only media reads are exposed; connection management is not an HTTP API. CORS is limited to `http://tauri.localhost`, and Host headers are checked. Release network security allows cleartext only for loopback and the existing Tauri/asset hosts.

GET/HEAD/OPTIONS, inclusive/open/suffix byte ranges, 206/416 responses and 64-bit file sizes are supported. Files stream through bounded buffers; they are not downloaded to disk or accumulated in memory. SMB uses a negotiated read buffer and 256 KiB buffering. SFTP uses offset-based pipelined reads. Sessions are reused; disconnects invalidate them. Closing a media response closes its remote file handle.

WebDAV media responses must provide an exact 206 Content-Range and matching size. A server ignoring Range is rejected instead of silently downloading from the beginning. Connection/read timeouts are bounded; a long-running media response has no total-duration timeout.

Stable virtual paths, rather than process-specific media URLs, are retained in recent playback. The original player, danmaku parser and subtitle renderer remain in use. Network MKV track probing, embedded subtitle extraction, transcoding and unsupported audio codecs remain outside this change; network playback does not add decoders.

## Verification tools

- `probe/storage-ui-check.cjs`: CDP checks for folder action count, shortcuts, disabled video rows, protocol forms, overflow, back handling, and screenshots.
- `probe/sftp-fixture.cjs`: read-only loopback SSH 2/SFTP fixture with an ephemeral host key and password; includes Unicode filenames and a virtual file larger than 5 GiB. Test credentials and dependencies stay in ignored `tmp/network-fixture` and must be removed afterward.
- `probe/network-smoke.cjs`: real Android bridge/SFTP verification, host-key mismatch rejection, danmaku/subtitle pairing, bounded reads, actual range bytes past 5 GiB, playback and seek. The temporary connection is removed afterward.
- Gradle `NetworkRulesTest`: virtual path and byte-range boundary cases.

The fixture is a development-only endpoint, not an application service or runtime dependency. To prepare it, install `ssh2@1.17.0` into `tmp/network-fixture` with lifecycle scripts disabled, and place a small compatible video at `tmp/network-fixture/sample.mp4`. Start it with Node, forward Android port 22345 to the local fixture with `adb reverse`, and run the smoke script against the debug WebView's CDP port. Stop the fixture and remove the reverse mapping and temporary directory after use.

## Verified on 2026-11-16

- Full arm64 debug APK built and installed over the existing application with the original debug signing key; no uninstall or data reset.
- Five Kotlin path/range tests passed with zero failures.
- Real WebView UI regression passed in portrait, landscape and an expanded viewport. Folder mode has three top shortcuts, one bottom action, disabled video selection, no horizontal overflow. Protocol switching, back handling and the red role=alert error panel passed.
- Actual SFTP fixture: unknown fingerprint prompt, mismatch rejection, encrypted saved source without password exposure, Unicode/space/plus/percent filenames, text/base64 reads, same-name danmaku and subtitle pairing, and the 32 MiB cap passed.
- Actual proxy GET/HEAD/206/416 tests matched exact bytes for closed/open/suffix ranges beyond 5 GiB. Playback reached 1280x720, seek passed, and one danmaku item loaded. Duplicate Content-Length was identified and removed; NanoHTTPD generates it itself.
- LAN discovery completed in 6.7 seconds with four results, including the local Windows server via WS-Discovery and two named devices via mDNS (one advertised IPv4 and IPv6).
- SMB manual testing exposed `IllegalArgumentException: Collection is empty` in SMBJ's `EnumSet.copyOf` handling. All empty FileAttributes arguments now use `EnumSet.noneOf(FileAttributes::class.java)`. Compilation passed; authenticated SMB playback on the user's Windows share still needs the user's on-device password entry. The actual share name is distinct from its containing folder.
- Live HTTPS WebDAV server interoperability has not been tested. Certificate validation remains enabled, and no real credentials were requested or stored by the development tools.
- Temporary SFTP service, reverse mapping, debugger forwarding, fixture dependencies and random test credentials were removed after verification. No paused debugger remains attached.
