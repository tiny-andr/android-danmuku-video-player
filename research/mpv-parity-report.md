# 新旧版本一致性对比（mpv-engine）

对照方式：同一份 CDP 探针分别跑在两台设备上，采集真实 DOM 结构做 diff，不靠肉眼截图。

| | 手机（新版） | Pad（对照） |
|---|---|---|
| 构建 | `debug 1118-1910`，version 0.2.0 | `debug 1118-1356`，version 仍显示 0.1.4 |
| 播放层 | `AndroidMpv` 存在、`AndroidAudioNative` 已移除 | `AndroidMpv` 不存在、`AndroidAudioNative` 存在 |
| 屏幕 | 1060×2376（2.24 dpr） | 941×1317 |

**注意**：Pad 上这个包并不是 v0.1.6 发布版，而是今天 13:56 构建的中间版本（版本号还停在 0.1.4、mpv 尚未接入）。它的 UI 与渲染路径仍走旧链路（Web 字幕层 + 原生音频转码），因此可以作为对照，但不能当成发布版基线。

## 已确认一致

| 模块 | 证据 |
|---|---|
| 播放页顶栏 `#mTop` 按钮集 | 两边都是 `mBack / mQuickAudio / mQuickSub / mQuickSettings / mRotateBtn / mInfoBtn / mPlBtn`，顺序相同 |
| 底部控制条 | 左 `playAndPause / volume / time`，右 `弹幕密度 / setting`，完全一致 |
| 信息卡 `#mInfo` 字段 | 两边都是 时长 / 分辨率 / 视频大小 / 弹幕数量 / 弹幕解析 / 当前进度 |
| 信息卡按钮 | 两边都是 `mInfoClose / mActAudio / mActSub / mActDanmaku / mActBlock / mActSettings` |
| 设置页控件 id | 两边都是 9 个：`settingsClose / optAutostart / optKeepScreenOn / optAutoAudio / optAutoSubtitle / settingsUpdateRow / updateStatus / btnUpdateAction / btnUpdateCancel / settingsStatus` |
| 字幕菜单 / 音轨菜单结构 | 条目数随片源不同（手机 6 项 / Pad 7 项，因为播的不是同一部），结构本身一致 |
| 播放页工具条 | 新版的首页 `.toolbar` 与桌面信息条 `#infobar` 在播放态隐藏，行为与原版靠 z-index 遮挡等效 |

## 本轮修掉的差异

**竖屏 PGS 字幕字号过大、位置跑到画面外**

原实现用 `sub-pos=86` 把字幕往上抬，但字幕画布当时按整个窗口算：竖屏 1060×2376 下 4K 片源的 PGS 按 3840 宽渲染，既巨大又落在画面下方的黑边里。

改为：

```
sub-scale-by-window   = yes   # 按窗口高度缩放
image-subs-video-resolution = no  # 字幕画布跟随视频画面（官方默认值，显式写出防止上游变动）
sub-pos                = 100  # 用默认底部，不再手工抬升
```

修复后竖屏字幕回到画面内、字号与画面比例协调；横屏未受影响。

## 仍然不同的地方（有意为之，非缺陷）

| 项 | 旧版 | 新版 | 说明 |
|---|---|---|---|
| 字幕渲染 | Web 层（`android-subtitle-view.js`，CSS 字号 18px） | libmpv + libass（PGS 位图原生） | 新版能显示旧版显示不了的 PGS/ASS 完整样式，代价是字幕样式由片源决定，不受 App 的字号设置控制 |
| 音频解码 | FFmpeg 转码 + 外挂 `<audio>` | libmpv 原生解码 | 不再需要转码、不生成 `.mka` 缓存 |
| 内嵌字幕抽取 | Rust 稀疏解析 MKV Cues | 无（libmpv 直接渲染） | 少了一次几十秒的等待 |

## 已全部对比完成

所有 overlay 面板用同一份 CDP 探针在两台设备上采过一遍，**结构逐项一致**：

| 面板 | 元素 id | 结论 |
|---|---|---|
| 播放列表 `#playlist` | `plTitle / plCount / plClose / plList` | 一致 |
| 弹幕面板 `#danmakuPanel` | `danmakuClose / btnPickDanmaku / danmakuStatus / btnClearDanmaku` | 一致 |
| 续播弹层 `#mResumePrompt` | `mResumeCard / mResumeTitle / mResumeName / mResumePosition / mResumeActions / mResumeContinue / mResumeCancel` | 一致 |
| 触摸锁 `#mTouchLock` | `mTouchUnlock / mTouchLockHint` | 一致 |
| 文件浏览器 `#aFileMask` | `aFileBox / aPickerTitle / aLocalTab / aNetworkTab / aQuick / aFileHead / aFileUp / aFilePath / aFileTools / aFileSort / aFileDirection / aFileView / aFileList / aSourceForm / aFileBar` | 一致（都是懒创建：手机首次采集为空，触发选择器后再采即相同） |

## 行为层仍属「旧版没有、新版独有」的部分

这些不是差异，是新版的能力增加，记录在此避免下次误判为回归：

- mpv 丢焦暂停（`AudioFocusRequest`），旧版由 Chromium 持焦
- 播放页 `.toolbar` 与 `#infobar` 显式隐藏，旧版靠 z-index 被舞台盖住
- 字幕/音轨菜单直接来自 mpv 的 `track-list`，旧版来自 ffprobe 与 MKV 解析
