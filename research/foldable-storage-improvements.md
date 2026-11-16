# 折叠屏、文件排序和封面预览

## 操作入口

- 展开后的宽窗口直接显示播放顶栏“音轨／字幕／设置”，窄窗口仍从信息卡进入；两处复用同一事件和可用状态，没有可选轨道时仍置灰。
- 首页窄窗口上下布局，最近播放使用操作区下方的全部剩余高度；宽且高的窗口左右分栏。不是预留广告或其他模块位置，不把最近播放硬限制成固定屏幕比例。
- 文件浏览的排序栏提供文件名、修改时间、类型，以及升序／降序；修改时间默认新到旧。文件夹始终置顶，名称自然排序，时间缺失的条目放在已知时间之后。同目录切换排序只重排已取得的数据。
- 文件浏览可在列表与预览图之间切换；“最近播放”标题右侧的小按钮同样切换列表／预览图，各自记住选择。
- 新 SMB 连接可以留空共享名，认证后浏览服务器公布的文件共享；已知共享也可直接填写。服务器禁止枚举时仍能直连已知共享。共享可见不等于其中目录可读，进入时再验证权限。
- 旧 SMB 连接继续绑定原共享，不改变最近播放和续播路径含义；旧连接清空共享名不会静默迁移，需新建服务器连接。

## 窗口规则

- 按实际 CSS 视口宽高判断，不根据设备型号、物理像素或单纯横竖屏判断。
- 宽度至少 720 时显示播放快捷入口；宽度至少 720 且高度至少 540 时使用大屏双栏。外屏横置虽然够宽，但高度不足时文件浏览继续使用紧凑布局。
- 设置、音轨、字幕等浮层在宽屏有宽度上限，不横跨整块屏幕；不自动压缩视频去常驻设置。
- 折叠与展开由窗口 resize 重排，不重新初始化播放器或清除当前片源；仍遵守现有系统旋转锁和显式方向按钮策略。

## 封面读取边界

- 原生 `MediaMetadataRetriever` 只通过受预算约束的随机读取接口访问本地或网络文件，不直接接收无限读取的媒体 URL。
- Each extraction reserves at most 12 MiB of video reads, with at most 64 KiB per remote request. Decoder reads use an aligned 64 KiB, 32-block (2 MiB) LRU; block fills count against the same byte budget and never borrow a playback connection. Protocol metadata is tracked separately.
- 解码在独立、不可外部导出的 `:thumbnails` 进程运行。启动任务约 4 秒后取消并回占位；遇到已在建立的连接，底层仍受自身有限连接超时约束，取消后不能继续读取。解码器停止使用任务令牌与死亡确认，旧取消不能终止下一张图。
- 请求只为可见卡片执行，退出目录、滚出屏幕或应用隐藏时取消；队列和并发均有上限。没有索引、不支持的编码、超预算或超时都保留默认图标，绝不退回全片扫描。
- 小尺寸 JPEG 保存在应用私有缓存，按稳定路径、大小和修改时间识别版本，总量上限 32 MiB。优先在片长约十分之一处取帧，最长先取 30 秒处；遇到近纯黑画面仅在同一任务预算内再尝试一次更后位置，仍为黑场就保留默认图标，不缓存纯黑封面。最近播放只读已有缓存，不在打开首页时重新连接 NAS；没有元数据的离线展示不代表已核验远端文件仍未变化。
- Playback now caches an already decoded, non-black video frame instead of opening a second video connection. Up to six attempts are spaced by at least two seconds, triggered by readiness/timeupdate/seek events. The native store validates JPEG encoding, byte length and dimensions, and uses the same private versioned LRU.

## 动态折叠缺陷修复（2026-11-16）

- 用户反馈：展开时打开文件预览，再折叠后图片与文字互相覆盖；长片名续播弹窗在外屏横向越界。此前四窗口回归只检查外层容器，不能证明加载后内容正常。
- 现场外屏视口已变为 415×931，但预览行高仍为约 58，内部图片约 96 高；问题不是完全收不到折叠尺寸，而是卡片内部高度计算没有随内容正确收缩。预览卡片改用正常块级内容流和 max-content 网格行，取消内部列 flex 的压缩依赖，图片与说明均须位于本卡片边界内。
- 续播遮罩使用可收缩的 `minmax(0,1fr)` 列，卡片与文件名均设 `min-width:0`，三个按钮使用可收缩等宽列。长片名单行省略，不能撑大弹窗轨道。
- 对照 [Android 官方 WebView 状态管理](https://developer.android.google.cn/develop/adaptive-apps/cookbook/webview-state?hl=zh-cn)：配置变化交由 Activity 处理后，调用 WebView 的重新布局与 `invalidate()`，不重载页面。前端普通 resize 也更新播放器与控制栏，不只监听 orientationchange。
- 新增 `probe/fold-content-check.cjs`：真实解码图片完成加载后检查 16 张卡片的内容包含、卡片相交、滚动底部；再用数百字文件名验证续播弹窗边界和三个按钮的实际命中。845→415→845→415、320 窄屏与短横屏全部通过。
- 用户协助真实折叠：同一文件页从 845×919 变为 415×931，页面标记保留；卡片高度从约 140 变为约 158，9 张已加载封面没有越界，用户确认正常。续播弹窗真实 415→845→415 后仍保持待选择，宽度按 380→430→380 调整，三个按钮全程位于屏内且可命中；系统截图检查通过。

## 验证与尚未覆盖

- 排序检查覆盖自然顺序、类型、时间缺失、升降序和不修改原始条目。
- WebView 布局回归覆盖 415×931、845×919、931×415、600×800，检查溢出、入口显隐、双栏、最近播放区域高度和 SMB 表单。
- 真机内外屏切换时当前播放页与路径保留；真实系统截图检查过播放顶栏和文件浏览。
- 复用原生加密凭据的 SMB 共享枚举实测约 196 毫秒返回 7 个文件共享；未读取或回传密码。服务器来源的目录／字节路由有原生单元测试，但没有为了验收临时改写已保存来源的作用域。
- 本地测试片以及两部实际电影已有非黑场小尺寸封面；最终首页命中 3 张缓存封面，读取缓存约 7–12 毫秒。大网络文件实测约 4 秒回占位，这是允许的有界失败路径，不代表视频本身不能播放。
- 最终安装包通过文件选择旧回归、新增四窗口回归（含首页底部仅保留 12–24 CSS 像素内边距）、设置迁移与常亮生命周期回归（含暂停亮屏）。34 项原生单测全部通过；排序、缩略图预算／取消／缓存／黑场和前端队列专项均通过。
- Manual subtitle/danmaku selection, subtitle timing/style, PiP/background playback and audio processing remain separate future batches. Hold-to-speed was explicitly declined and is not on the backlog.

## Thumbnail latency follow-up (2026-11-16)

- Investigation and measurements: see `research/thumbnail-performance.md`. Cached images no longer wait behind extraction jobs; failed extractions have a short, metadata-keyed cooldown. SMB cancellation is registered before connection/authentication starts.
- Recent rows support a 550 ms hold or desktop context menu, followed by an explicit delete/cancel sheet. Only the selected history entry is removed; files, resume records and thumbnails remain. Back dismisses the sheet.
