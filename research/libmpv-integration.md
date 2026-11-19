# libmpv AAR 集成记录

0.2.0 起播放内核换成 libmpv，运行时依赖一份预编译 AAR（`dev.jdtech.mpv:libmpv:1.1.0`）。
AAR 约 49 MiB，不进仓库，构建前由 `bplayer-android/scripts/fetch-libmpv.ps1` 拉取并按 SHA256 校验。

本文把原始 spike 文档里关于 AAR 的要点落到仓库内，并对当前仓库状态做了一次复核。
原始文档在 `tmp/libmpv-spike/INTEGRATION.md`，而 `tmp/` 被 `.gitignore` 忽略——新克隆的人看不到它，
所以本文件是这些事实的仓库内落点。

## 0. 先看四条结论

1. **固定产物**：libmpv-android `v1.1.0` release 的 `libmpv-release.aar`，51,550,729 B，
   SHA256 `20FD972E70D8E73BF8900D911F3AE0EEAE354606BAEB0FE58CAA1A6380E196AA`（本文 §2 复核）。
2. **版本**：mpv 0.42.0 / FFmpeg 9.0.2 / libass 0.17.5；AAR 自带 4 个 ABI，本项目只打包 `arm64-v8a`。
3. **许可证**：AAR 里没有许可证文件，上游仓库源码是 MIT，但 `libmpv.so` 链了 GPL 版 FFmpeg，
   **二进制实际是 GPL-3.0-or-later**。0.2.0 起分发的整包必须按 GPLv3 处理，仓库已整体改为
   GPL-3.0-or-later（`LICENSE`、`README.md`）。本文不是法律意见。
4. **能力边界**：这份 FFmpeg 是 `--disable-muxers --disable-encoders` 编的，只能解不能编码。
   0.2.0 删音轨转码链的前提是「mpv 直接解码所有音轨」，不要指望这份 FFmpeg 顺手做转码。

## 1. 固定产物与落点

| 项 | 值 |
|---|---|
| 上游仓库 | https://github.com/jarnedemeulemeester/libmpv-android |
| release tag | `v1.1.0`（prerelease=false，published 2026-11-15T17:20:13Z） |
| 资产名 | `libmpv-release.aar`（该 release 唯一资产） |
| 下载 URL | https://github.com/jarnedemeulemeester/libmpv-android/releases/download/v1.1.0/libmpv-release.aar |
| 字节数 | 51,550,729 B（49.2 MiB，与 GitHub API 上报的 `size` 一致） |
| SHA256 | `20FD972E70D8E73BF8900D911F3AE0EEAE354606BAEB0FE58CAA1A6380E196AA` |
| MD5 | `B900FA311500E1C2DC4B658E79022CFD` |
| Maven 坐标 | `dev.jdtech.mpv:libmpv:1.1.0`（同一 release 的发布坐标） |
| 仓库内落点 | `bplayer-android/src-tauri/gen/android/app/libs/libmpv-release.aar`（gitignore） |
| 恢复脚本 | `bplayer-android/scripts/fetch-libmpv.ps1` |

恢复方式：

```powershell
pwsh -NoProfile -File bplayer-android/scripts/fetch-libmpv.ps1          # 首次；已存在且校验通过时跳过
pwsh -NoProfile -File bplayer-android/scripts/fetch-libmpv.ps1 -DryRun   # 只打印固定 URL / SHA256 / 落点
pwsh -NoProfile -File bplayer-android/scripts/fetch-libmpv.ps1 -Force    # 强制重下
```

脚本行为：先下载到 `libmpv-release.aar.part`，校验字节数与 SHA256 都匹配后才改名成 `libmpv-release.aar`；
校验失败或下载出错会删掉残缺文件并以非零码退出。目标位置已有的文件校验不过时先删除再重下，
避免把一个错的 AAR 链接进构建。

手工核对：

```powershell
$aar = "bplayer-android\src-tauri\gen\android\app\libs\libmpv-release.aar"
(Get-Item $aar).Length                            # 51550729
(Get-FileHash $aar -Algorithm SHA256).Hash        # 20FD972E...E196AA
```

## 2. 复核记录（2026-11-19）

- 本机已有 `app/libs/libmpv-release.aar`：字节数 51,550,729、SHA256 与 §1 一致。
- 直接读该 AAR 的 zip 目录复核结构：4 个 ABI、每个 ABI 10 个 `.so`，arm64-v8a 合计 27,376,288 B，
  `classes.jar` 15,609 B，与 §4 的数字一致。
- `fetch-libmpv.ps1` 在已有文件上执行：判定通过、直接跳过，不发起网络请求。
- 脚本的下载/校验/失败清理分支用本地 HTTP 服务 + 4 KiB 假产物跑过六种情形（成功、幂等跳过、
  目标文件不对被替换、SHA 不符、404、固定值格式非法），未下载真实 AAR、未触碰真实落点。

## 3. 上游组件版本

| 组件 | 版本 | 许可证 |
|---|---|---|
| mpv | 0.42.0 | GPL-2.0-or-later |
| **FFmpeg** | **9.0.2**（`LIBAVCODEC_63`，`Lavf/63.1.102`） | **GPL-3.0-or-later** |
| libass | 0.17.5 | ISC |
| libplacebo | 7.387.0 | LGPL-2.1-or-later |
| dav1d | 1.5.4 | BSD-2-Clause |
| harfbuzz | 15.1.0 | Old MIT |
| fribidi | 1.0.18 | LGPL-2.1-or-later |
| freetype | 2.15.0 | FTL 或 GPL-2.0-or-later |
| fontconfig | 2.18.3 | permissive |
| lua / curl / mbedtls / libxml2 / libunibreak | 5.2.4 / 8.23.0 / 3.6.7 / 2.15.4 / 8.0 | MIT 类、curl license、Apache-2.0、MIT、Zlib |

构建环境（上游）：NDK `30.0.16248370`、platform android-37、build-tools 37.0.0、cmake 4.1.2、AGP 9.5.1。
证据：AAR 内 `.so` 字符串（`mpv v0.42.0`、`FFmpeg version n9.0.2`、libass commit `0.17.5-…`、
`clang 22.0.1`）+ 上游 `buildscripts/include/depinfo.sh`。

FFmpeg configure 关键开关（`libavutil.so` 内 `avutil_configuration` 原文节选）：

```
--enable-jni --enable-mediacodec --enable-mbedtls --enable-libdav1d --enable-libxml2
--enable-gpl --enable-version3 --disable-vulkan --enable-shared
--disable-muxers --disable-encoders --disable-devices --disable-filters
```

- `--enable-gpl --enable-version3`：GPLv3 二进制的直接原因。
- `--disable-muxers --disable-encoders`：能解码、不能编码/封装。
- `--enable-mediacodec`：`hwdec=mediacodec` 可用。

## 4. AAR 内容与 ABI 裁剪

### 4.1 顶层结构

```
R.txt                                                   0 B（空，AAR 无资源）
AndroidManifest.xml                                   196 B（package dev.jdtech.mpv，minSdkVersion 26，无权限）
classes.jar                                        15,609 B（只有 dev.jdtech.mpv.MPVLib + 嵌套类型）
proguard.txt                                           41 B（-keep class dev.jdtech.mpv.MPVLib { *; }）
META-INF/…/aar-metadata.properties                    178 B（minCompileSdk=37）
jni/arm64-v8a/… armeabi-v7a/… x86/… x86_64/…               ← 注意是 jni/，不是 jniLibs/
```

- `classes.jar` 里**没有** `MPVView` / `BaseMPVView`，视图层是项目自己写的
  `mpv/MPVView.kt`（`TextureView` 子类，为什么不能用 `SurfaceView` 见 AGENTS.md §7）。
- `classes.jar` 里 `MPVLib` 的 class 版本是 61（Java 17）；本项目 `sourceCompatibility 1.8` 消费没问题。
- 内置 `EventObserver` 在 `v1.1.0` 新增 `eventEndFile(reason, error)`，且 `MPV_EVENT_END_FILE`
  不再经 `event()` 送达——项目已经在用这条新 API（`MPVView.kt` 的 `eventEndFile`），
  所以**不能换回 v1.0.x 的 AAR**。
- `libmpv.so` 里静态链了 libass / libplacebo / dav1d / freetype / harfbuzz / fribidi / fontconfig /
  lua / curl / mbedtls（上游 README），所以包内只需要 AAR 提供的 10 个 `.so`。

### 4.2 ABI 与包体

AAR 带 4 个 ABI、每个 ABI 同样 10 个 `.so`。未压缩合计 114,706,356 B（109.4 MiB），压缩后 49.2 MiB。

本项目只打包 arm64：

```kotlin
// app/build.gradle.kts
ndk { abiFilters += listOf("arm64-v8a") }
```

只留 `arm64-v8a` 是 27,376,288 B（26.1 MiB）未压缩；APK 默认不压缩 `.so`
（`useLegacyPackaging=false`），即包体增加约 26 MB。不加 `abiFilters` 会把另外三个 ABI 一起带进包（+83 MiB）。

### 4.3 arm64-v8a 的 10 个 .so

| .so | 字节数 |
|---|---:|
| libavcodec.so | 12,103,320 |
| libavdevice.so | 9,232 |
| libavfilter.so | 138,296 |
| libavformat.so | 3,027,512 |
| libavutil.so | 734,528 |
| libc++_shared.so | 1,423,696 |
| libmpv.so | 8,590,312 |
| libplayer.so | 19,888 |
| libswresample.so | 96,760 |
| libswscale.so | 1,232,744 |
| **合计** | **27,376,288** |

`libplayer.so` 是 JNI 胶水层（17 个 `Java_dev_jdtech_mpv_MPVLib_*` 符号，与 `javap` 的 17 个
native 方法一一对应），`libmpv.so` 是 mpv 本体。

arm64 全部 10 个 `.so` 的 `PT_LOAD` 最小 `p_align = 16384`（16 KB 页对齐），满足 Android 15+ 的要求。

arm64 各 `.so` 的 SHA256（供日后比对）：

```
7B8F01F83A5F8B364D5E275D270FFBFE44D295B1D854A01D1E3533F8A5048601  libavcodec.so
B5D8AC05E0749B1ED20F0518EC5A45958E245CB951E96612D82E89067EF541FD  libavdevice.so
83287B42435002AB0E4005903A8F676E16CDF26CDFFD8E4455EBCB117E1245B4  libavfilter.so
A4B9B2B59842151F9D4A15357427B8BE44EE2AFFF7D2316AC0E9DE0D6548F391  libavformat.so
391D0303E16347142B602C20B6948B269EC60C3CD4F7F669757A11565C0E7079  libavutil.so
B5D97C38A728AFE28D341CDA3369F512D35EAF9C680C1B0563CD6A63E395230F  libc++_shared.so
1B3D1B37DC0EDD0CBFED70E3DB5CB2100FFC1D592ECBE1C60F9EAC0EEFA37B5B  libmpv.so
2B8B2704B47C44D8CCED6C7C5EBDAC8888AA0A49668429610F54B785FCA3885F  libplayer.so
09B358549595B51C2D3E41BCB7633F6CA2FA5DA85A6E00BD678338BABA62B7A9  libswresample.so
3E7B4A9298938C46FA9B44540854B86E9EEAE0099FB10B8894BDCEEB4FC02E33  libswscale.so
```

`libc++_shared.so` 由 AAR 带进来，以后若引入其它 C++ 原生依赖必须共用这一份、同一 NDK 版本，
多份 `libc++_shared.so` 是经典崩溃源。

### 4.4 与 0.1.x ffmpeg-kit 的关系

spike 阶段最大的阻塞项是 AAR 里的 7 个 `libav*.so` 与当时 `ffmpeg-kit-min 8.1.7`（FFmpeg n8.1.2、
`LIBAVCODEC_62`）**同名不同版本**，无法共存于同一个 APK（合并重复 `.so` 直接失败，用 `pickFirsts`
硬压会在 `dlopen` 时符号版本不匹配崩溃）。

0.2.0 的处理是把 `ffmpeg-kit` 和整条音轨转码链一起删掉（源码存档在 `tmp/parked-audio/`），
冲突因此消失：当前 APK 里只有 libmpv 这一套 FFmpeg 9.0.2。
注意 `gen/android/build.gradle.kts` 的阿里云仓库 `includeModule` 白名单里还留着三条
`dev.ffmpegkit-maintained:ffmpeg-kit-min` / `com.arthenica:smart-exception-*`，已经没有任何依赖引用它们；
留着无副作用，但属于可清理的残留。

## 5. 许可证：为什么整包必须是 GPLv3

| 层 | 内容 | 出处 |
|---|---|---|
| AAR 内 | **没有任何 LICENSE/COPYING/NOTICE 文件** | zip 逐条检查 |
| 上游仓库源码 | **MIT**（`Copyright (c) 2016 Ilya Zhuravlev` / `Copyright (c) 2016 sfan5`，mpv-android JNI 壳血统） | 上游 `LICENSE` |
| **二进制实际** | **GPL-3.0-or-later** | 上游 README：「Since `libmpv.so` links against the FFmpeg libraries and other GPL-licensed components, the effective license of the binaries in the AAR is GPL-3.0-or-later. Apps distributing the AAR must comply with the terms of that license.」；`libmpv/build.gradle.kts` 的 pom 也声明 GPL v3 or later |

所以：

- 0.2.0 / 0.2.1 的 APK 已经把这份 GPLv3 二进制打进去并分发，整包应视为 GPLv3；
- 仓库因此把 `LICENSE` 从 MIT 换成 GPLv3 全文、`README.md` 的许可证段改为 GPL-3.0-or-later，
  并写明原因是「分发了链接 GPL 版 FFmpeg 的 libmpv 二进制」；
- 分发 APK 时要能提供对应源码（本仓库即对应源码）并附 GPLv3 全文；上游版本、ABI 裁剪与
  替换方式都在本文里，够第三方重建。

补充：AAR 内外的 MIT 只覆盖上游那层 JNI 壳源码，不改变二进制整体的 GPL 结论。

## 6. Gradle 接线

```kotlin
// app/build.gradle.kts
android { defaultConfig { ndk { abiFilters += listOf("arm64-v8a") } } }

dependencies {
    implementation(files("libs/libmpv-release.aar"))   // 本地 AAR，字节由 fetch 脚本的 SHA256 固定
}
```

- 本地 AAR 不走依赖传递（该 AAR 本身无依赖），`libs/` 整目录在 `.gitignore` 里。
- 同一版本在 Maven Central 有坐标（`dev.jdtech.mpv:libmpv:1.1.0`，spike 实测 `repo1.maven.org`
  上的 pom/aar 均返回 HTTP 200），但仓库选了「本地文件 + SHA256」：构建不依赖远端仓库状态，
  也不受仓库镜像白名单影响。**spike 没有核对 Maven Central 资产与本仓库 AAR 的字节是否一致**，
  若以后改回坐标依赖，先比对 SHA256。
- `minSdk 26` / `minCompileSdk 37`：本项目 `minSdk 26`、`compileSdk 37`、`targetSdk 35`，满足要求。

## 7. 出处

原始 spike 文档 `tmp/libmpv-spike/INTEGRATION.md`（已 gitignore，仅供本机追溯）：

| 内容 | 位置 |
|---|---|
| 下载与校验表（URL / 字节数 / SHA256 / MD5） | §1，第 38-54 行（URL 第 45 行、字节数第 46 行、SHA256 第 47 行、MD5 第 48 行） |
| ABI 与 `.so` 清单、16 KB 页对齐 | §2.2，第 71-110 行 |
| AAR 顶层结构、`classes.jar` 类清单 | §2.1 / §2.5，第 60-159 行 |
| 许可证三层与组件表 | §2.8，第 260-289 行（整包结论在第 285-289 行；§0 第 25-27 行也点了这句） |
| 版本（mpv / FFmpeg / libass / 工具链） | §2.9，第 291-312 行 |
| Gradle 接法（本地文件 / flatDir / Maven） | §3.1-§3.3，第 330-377 行 |
| 与 ffmpeg-kit 的 `.so` 冲突与四种方案 | §3.4，第 379-435 行 |

上游链接：

- release：https://github.com/jarnedemeulemeester/libmpv-android/releases/tag/v1.1.0
- 源码 LICENSE（MIT）：https://github.com/jarnedemeulemeester/libmpv-android/blob/v1.1.0/LICENSE
- 二进制许可证声明（README）：https://github.com/jarnedemeulemeester/libmpv-android/blob/v1.1.0/README.md

本文数据采集于 2026-11-18 的 spike；2026-11-19 在本仓库复核了 AAR 字节数、SHA256 与
`fetch-libmpv.ps1` 的行为（见 §2）。
