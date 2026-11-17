// PGS（蓝光位图字幕）安卓移植：libpgs 按 MKV 的 Cues 索引用 seek 只读字幕块，解出
// 位图后合成 PNG 事件表；前端覆盖层按播放时钟把 PNG 贴到画面上。不转码、不 OCR、
// 不落盘 —— 只是把「Chromium 内核不认的图形字幕」还原成图片。
//
// 移植自桌面版 Bplayer `src-tauri/src/pgs_render.rs`。返回给前端的形状、事件切分
// 规则、代际守卫、PNG 编码、两个内存预算的检查时机全部与桌面版一致，只有三处不同：
//
// 1. 抽取入口是 `async fn open` + `crate::blocking::blocking(...)`。安卓的 invoke
//    派发器是单线程的（见 blocking.rs 头注释），而这里一次抽取实测 2–7 s；留在
//    同步命令里会把挂字幕、探音轨、刷进度、读封面全部堵在后面。
// 2. 内存预算 128 MB → 64 MB（见下面两个常量）：手机上 WebView 自己就占上百 MB，
//    进程可用余量比桌面小得多，超限整轨报错、前端 toast 后继续正常播放。
// 3. 全局状态用模块级 `static`，不再走 Tauri 的 managed State：整个播放会话只有
//    一份 PGS 文档，static 就够了，四个命令的签名与前端契约一个字都不用改。
//
// 关键实测（桌面版，潘神 UHD 35.6 GB，简体轨）：抽取 1669 个显示集只读 13.4 MB
// （文件的 0.038%），冷启动 7.3 s；合成 884 张裁边 PNG 约 2.5 s，合计约 30 MB。
// 手机 CPU 慢一截、/sdcard 走 FUSE，冷启动可能到 10 s 量级 —— 所以必须离开 IPC
// 通道，前端在等待期间显示「正在解析位图字幕…」。
//
// 事件切分：显示集里出现 PCS 对象且「构图签名」（对象 id/版本/坐标 + 调色板）变化，
// 就算一条新事件；事件在下一次清屏显示集处结束。纯调色板更新（palette_only）
// 不产生新事件，只是重绘已有事件。

use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};

use libpgs::pgs::payload::ods_rle_data;
use libpgs::pgs::rle::decode_rle;
use libpgs::pgs::{CompositionState, PaletteEntry};

/// 一条字幕事件：时间区间 + 位图在 PGS 画布上的位置尺寸（已裁掉透明边）。
/// 字段名就是前端 `pgsEventAt`/`layoutPgsImg` 直接读的 `start/end/x/y/w/h`，
/// 改一个字母就是「菜单说挂上了、画面没图」，不要动。
#[derive(Serialize, Clone)]
pub struct PgsEvent {
    pub start: f64, // ms
    pub end: f64,   // ms
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

/// 交给前端的索引：画布尺寸 + 事件表（不含图像，图像按需由 `pgs_image` 取）。
#[derive(Serialize, Clone)]
pub struct PgsIndex {
    pub canvas_w: u32,
    pub canvas_h: u32,
    pub events: Vec<PgsEvent>,
}

struct PgsDoc {
    index: PgsIndex,
    images: Vec<Vec<u8>>, // 与 events 同序的 PNG 字节
}

/// 当前 PGS 文档。桌面版挂在 Tauri State 上，安卓这里只有一份，用模块级 static。
/// `Mutex::new` 是 const fn，所以连 OnceLock 都不需要。
static PGS_DOC: Mutex<Option<PgsDoc>> = Mutex::new(None);

fn lock_doc() -> MutexGuard<'static, Option<PgsDoc>> {
    // 持锁线程 panic 也不会让文档处于半个状态（我们只在锁内整体替换 Option），
    // 所以中毒后直接取内部值继续用，不要跟着 panic —— 命令里 panic 会让 WebView
    // 侧拿到一个突兀的 invoke 失败。
    PGS_DOC.lock().unwrap_or_else(PoisonError::into_inner)
}

// ---- 请求代际 ----

/// PGS 请求代际号，只增不减。前端连点两条 PGS 轨时，先发出的那次 build 可能更慢：
/// 如果它一完成就无条件写 state，会把后发者已经写好的文档盖回去，`pgs_image` 随后
/// 按事件序号取到的是另一条轨的图（或图数对不上而静默无图）。前端的 `pgsToken`
/// 只挡 promise 回调，挡不住 Rust 侧状态被旧文档覆盖，所以这里必须自己认号。
static PGS_GEN: AtomicU64 = AtomicU64::new(0);

fn next_gen() -> u64 {
    PGS_GEN.fetch_add(1, Ordering::SeqCst) + 1
}

// ---- 资源上限（手机预算）----

/// PNG 位图总量上限。只限事件条数是不够的 —— 200000 条 × 30 KB 也能到 6 GB。
/// 真片实测约 884 条、30 MB：桌面版给 128 MB，手机压到 64 MB —— 播放器进程里还有
/// WebView（上百 MB）、解码器、音轨缓存，位图字幕没有理由吃掉这么多。
const PGS_MAX_IMAGE_BYTES: usize = 64 * 1024 * 1024;

/// 单个 epoch 内解码后的对象总量上限。对象尺寸另受画布上限约束，但 id 空间有
/// 65536 个，坏文件能堆出天文数字；真片几百 KB 到几 MB。同样 128 MB → 64 MB。
const PGS_MAX_OBJECT_BYTES: usize = 64 * 1024 * 1024;

/// 画布边长硬顶。蓝光最大 1920×1080，UHD 蓝光 3840×2160，8192 留足余量。
/// 尺寸是文件里的外部数据，不设限时损坏/恶意文件声明 65535×65535 会让
/// `Canvas::new` 申请约 17 GB（65535²×4），分配失败直接 abort 整个播放器。
const PGS_MAX_DIM: u32 = 8192;

/// 画布字节上限（RGBA 临时缓冲，每条新事件都要重新分配一次）。桌面版没设这条，
/// 因为桌面 swap 大、8192² 也就 256 MB；手机上一次性 256 MB 会直接把进程打死
/// （Rust 的 Vec 分配失败是 abort，不是可捕获的 Err）。UHD 3840×2160 的 RGBA
/// 画布 33 MB，48 MB 对真实片源绰绰有余，8K PGS 不在这个播放器的目标里。
const PGS_MAX_CANVAS_BYTES: usize = 48 * 1024 * 1024;

/// 单轨事件数上限。每条事件都常驻一张 PNG，条数失控同样会吃光内存。
/// （PNG 总量先撞线，这条主要防「零字节 PNG」之类的退化情形。）
const PGS_MAX_EVENTS: usize = 200_000;

fn check_canvas_size(w: u32, h: u32) -> Result<(), String> {
    if w == 0 || h == 0 || w > PGS_MAX_DIM || h > PGS_MAX_DIM {
        return Err(format!("PGS 画布尺寸异常（{w}×{h}），拒绝加载"));
    }
    if (w as usize).saturating_mul(h as usize).saturating_mul(4) > PGS_MAX_CANVAS_BYTES {
        return Err(format!(
            "PGS 画布 {w}×{h} 的像素缓冲超过 {} MB 上限，拒绝加载",
            PGS_MAX_CANVAS_BYTES / (1024 * 1024)
        ));
    }
    Ok(())
}

/// ODS 对象尺寸也是文件声明的，`decode_rle` 会按 w*h 预分配像素缓冲，超限同样是
/// 一次 abort。0 表示空对象，解码器自己会返回空切片，照旧放行。
fn object_size_reasonable(w: u16, h: u16) -> bool {
    w <= PGS_MAX_DIM as u16 && h <= PGS_MAX_DIM as u16
}

// ---- 位图合成 ----

/// PGS 的调色板是 YCbCr（BT.709 / 有限范围的近似值），合成时转成 RGB，
/// alpha 直接用调色板条目里的不透明度。
fn ycbcr_to_rgb(y: u8, cr: u8, cb: u8) -> (u8, u8, u8) {
    let yf = y as f32;
    let crf = cr as f32 - 128.0;
    let cbf = cb as f32 - 128.0;
    let clamp = |v: f32| v.clamp(0.0, 255.0) as u8;
    (
        clamp(yf + 1.402 * crf),
        clamp(yf - 0.344_136 * cbf - 0.714_136 * crf),
        clamp(yf + 1.772 * cbf),
    )
}

struct Canvas {
    w: usize,
    h: usize,
    rgba: Vec<u8>,
}

impl Canvas {
    fn new(w: usize, h: usize) -> Self {
        Canvas { w, h, rgba: vec![0; w * h * 4] }
    }

    fn draw(&mut self, x: usize, y: usize, bw: usize, bh: usize, idx: &[u8], pal: &HashMap<u8, PaletteEntry>) {
        for row in 0..bh {
            let cy = y + row;
            if cy >= self.h {
                break;
            }
            for col in 0..bw {
                let cx = x + col;
                if cx >= self.w {
                    break;
                }
                let Some(e) = pal.get(&idx[row * bw + col]) else { continue };
                if e.alpha == 0 {
                    continue;
                }
                let (r, g, b) = ycbcr_to_rgb(e.luminance, e.cr, e.cb);
                let o = (cy * self.w + cx) * 4;
                self.rgba[o] = r;
                self.rgba[o + 1] = g;
                self.rgba[o + 2] = b;
                self.rgba[o + 3] = e.alpha;
            }
        }
    }

    /// 透明像素的最小外接矩形（x, y, w, h）；全透明返回 None。
    /// 裁边是为了让前端拿到的每张图都只有字，位置/尺寸按画布坐标缩放即可。
    fn ink_box(&self) -> Option<(u32, u32, u32, u32)> {
        let (mut x0, mut y0, mut x1, mut y1) = (usize::MAX, usize::MAX, 0usize, 0usize);
        for y in 0..self.h {
            let row = y * self.w;
            for x in 0..self.w {
                if self.rgba[(row + x) * 4 + 3] != 0 {
                    if x < x0 {
                        x0 = x;
                    }
                    if y < y0 {
                        y0 = y;
                    }
                    if x > x1 {
                        x1 = x;
                    }
                    if y > y1 {
                        y1 = y;
                    }
                }
            }
        }
        if x0 == usize::MAX {
            return None;
        }
        Some((x0 as u32, y0 as u32, (x1 - x0 + 1) as u32, (y1 - y0 + 1) as u32))
    }

    fn crop_png(&self, x: u32, y: u32, w: u32, h: u32) -> Result<Vec<u8>, String> {
        let mut out = vec![0u8; (w as usize) * (h as usize) * 4];
        for row in 0..h as usize {
            let src = ((y as usize + row) * self.w + x as usize) * 4;
            let dst = row * (w as usize) * 4;
            out[dst..dst + (w as usize) * 4].copy_from_slice(&self.rgba[src..src + (w as usize) * 4]);
        }
        let mut buf: Vec<u8> = Vec::new();
        {
            let mut enc = png::Encoder::new(&mut buf, w, h);
            enc.set_color(png::ColorType::Rgba);
            enc.set_depth(png::BitDepth::Eight);
            let mut writer = enc.write_header().map_err(|e| e.to_string())?;
            writer.write_image_data(&out).map_err(|e| e.to_string())?;
        }
        Ok(buf)
    }
}

/// 构图签名：对象集合（id/版本/位置）+ 调色板版本决定这一帧画面是否变了。
fn signature(pcs: &libpgs::pgs::PcsData, palette_ver: u8) -> Vec<(u16, u8, u16, u16)> {
    let mut v: Vec<(u16, u8, u16, u16)> = pcs
        .objects
        .iter()
        .map(|o| (o.object_id, 0u8, o.x, o.y))
        .collect();
    v.push((u16::MAX, palette_ver, pcs.palette_id as u16, 0));
    v
}

// ---- 抽取 + 合成 ----

/// 抽取一条 PGS 轨并合成全部位图。纯 CPU/IO，调用方必须把它放进阻塞线程池。
fn build(video: &str, track: u32) -> Result<PgsDoc, String> {
    let path = std::path::Path::new(video);
    if !path.is_file() {
        return Err("源视频不存在".into());
    }
    // libpgs 读 MKV 的 Cues 索引直接 seek 到含字幕块的 Cluster，不像 mkvextract /
    // ffmpeg 那样顺序扫全片：UHD 35.6 GB 的片子只读 13.4 MB。安卓 /sdcard 走 FUSE，
    // 随机读比桌面慢，但仍远优于全片扫描。
    let sets = libpgs::extract_display_sets(path, Some(track)).map_err(|e| format!("抽取 PGS 失败: {e}"))?;
    if sets.is_empty() {
        return Err("这条字幕轨里没有可渲染的位图".into());
    }

    let mut palette: HashMap<u8, PaletteEntry> = HashMap::new();
    let mut palette_ver: u8 = 0;
    let mut objects: HashMap<u16, (usize, usize, Vec<u8>)> = HashMap::new();
    let mut objects_ver: HashMap<u16, u8> = HashMap::new();
    let mut events: Vec<PgsEvent> = Vec::new();
    let mut images: Vec<Vec<u8>> = Vec::new();
    let (mut canvas_w, mut canvas_h) = (0u32, 0u32);
    let mut current: Option<Vec<(u16, u8, u16, u16)>> = None;
    // 累计已吃下的内存，超预算就整轨放弃（见上面两个 64 MB 常量）
    let mut object_bytes: usize = 0;
    let mut image_bytes: usize = 0;

    for ds in &sets {
        if ds.composition_state == CompositionState::EpochStart {
            // 新 epoch 重新开始：旧对象/旧调色板一律失效，计数也归零（内存已释放）
            objects.clear();
            objects_ver.clear();
            palette.clear();
            object_bytes = 0;
        }
        for seg in &ds.segments {
            if let Some(pds) = seg.parse_pds() {
                palette_ver = pds.version;
                for e in pds.entries {
                    palette.insert(e.id, e);
                }
            }
        }
        // 组装可能被切成多段的 ODS
        let mut ids: Vec<u16> = Vec::new();
        let mut groups: HashMap<u16, Vec<&libpgs::pgs::PgsSegment>> = HashMap::new();
        for seg in &ds.segments {
            if let Some(ods) = seg.parse_ods() {
                if ods.width.is_some() && ods.height.is_some() && !groups.contains_key(&ods.id) {
                    ids.push(ods.id);
                }
                groups.entry(ods.id).or_default().push(seg);
            }
        }
        for id in ids {
            let group = &groups[&id];
            let Some(first) = group[0].parse_ods() else { continue };
            let (Some(w), Some(h)) = (first.width, first.height) else { continue };
            if !object_size_reasonable(w, h) {
                return Err(format!("PGS 对象尺寸异常（{w}×{h}），拒绝加载"));
            }
            let mut rle: Vec<u8> = Vec::new();
            for seg in group {
                if let Some(ods) = seg.parse_ods() {
                    if let Some(d) = ods_rle_data(&seg.payload, ods.sequence) {
                        rle.extend_from_slice(d);
                    }
                }
            }
            if let Some(pixels) = decode_rle(&rle, w, h) {
                object_bytes = object_bytes.saturating_add(pixels.len());
                if object_bytes > PGS_MAX_OBJECT_BYTES {
                    return Err(format!(
                        "PGS 对象总量超过 {} MB 上限，拒绝加载",
                        PGS_MAX_OBJECT_BYTES / (1024 * 1024)
                    ));
                }
                objects_ver.insert(id, first.version);
                objects.insert(id, (w as usize, h as usize, pixels));
            }
        }

        let Some(pcs) = ds.segments.iter().find_map(|s| s.parse_pcs()) else { continue };
        // 先校验再分配：画布是照文件声明申请的，别让坏文件把进程撑爆
        check_canvas_size(pcs.video_width as u32, pcs.video_height as u32)?;
        canvas_w = pcs.video_width as u32;
        canvas_h = pcs.video_height as u32;

        if pcs.objects.is_empty() {
            // 清屏：收尾当前事件
            if current.take().is_some() {
                if let Some(last) = events.last_mut() {
                    last.end = ds.pts_ms;
                }
            }
            continue;
        }

        // 把对象版本合进签名，避免同一对象内容换了坐标没变时漏判
        let mut sig = signature(&pcs, palette_ver);
        for entry in sig.iter_mut() {
            if entry.0 != u16::MAX {
                if let Some(v) = objects_ver.get(&entry.0) {
                    entry.1 = *v;
                }
            }
        }
        if current.as_ref() == Some(&sig) {
            continue; // 同一帧，只是刷新
        }

        let mut canvas = Canvas::new(canvas_w as usize, canvas_h as usize);
        let mut any = false;
        for obj in &pcs.objects {
            if let Some((w, h, px)) = objects.get(&obj.object_id) {
                canvas.draw(obj.x as usize, obj.y as usize, *w, *h, px, &palette);
                any = true;
            }
        }
        let Some((bx, by, bw, bh)) = (if any { canvas.ink_box() } else { None }) else {
            continue;
        };

        let png = canvas.crop_png(bx, by, bw, bh)?;
        if let Some(last) = events.last_mut() {
            if last.end <= last.start {
                last.end = ds.pts_ms; // 上一帧结束在这里
            }
        }
        if events.len() >= PGS_MAX_EVENTS {
            return Err(format!("PGS 事件数超过上限（{PGS_MAX_EVENTS}），拒绝继续合成"));
        }
        image_bytes = image_bytes.saturating_add(png.len());
        if image_bytes > PGS_MAX_IMAGE_BYTES {
            return Err(format!(
                "PGS 位图总量超过 {} MB 上限，拒绝继续合成",
                PGS_MAX_IMAGE_BYTES / (1024 * 1024)
            ));
        }
        events.push(PgsEvent { start: ds.pts_ms, end: ds.pts_ms + 2000.0, x: bx, y: by, w: bw, h: bh });
        images.push(png);
        current = Some(sig);
    }

    // 最后一条事件没有明确的结束时间：按常见字幕时长兜底
    if let Some(last) = events.last_mut() {
        if last.end > last.start + 30_000.0 {
            last.end = last.start + 8000.0;
        }
    }
    if events.is_empty() {
        return Err("这条字幕轨里没有可渲染的位图".into());
    }

    Ok(PgsDoc { index: PgsIndex { canvas_w, canvas_h, events }, images })
}

// ---- 对外接口（lib.rs 的四个命令只是薄壳）----

/// 打开某条 PGS 字幕轨：后台抽取并合成，返回事件索引（图像按需再取）。
/// 整个抽取 + 合成都在阻塞线程池里跑，IPC 通道不被占住。
pub async fn open(video: String, track: u64) -> Result<PgsIndex, String> {
    let track = u32::try_from(track).map_err(|_| format!("PGS 轨道号异常（{track}），拒绝加载"))?;
    // 号在 build 之前就取好：之后只要再来一次 open 或 close，号就比这个大了
    let my_gen = next_gen();
    let doc = crate::blocking::blocking(move || build(&video, track)).await??;
    let index = doc.index.clone();
    // 比对和写入必须在同一把锁里：否则「比对通过 → 另一个 open 取号 → 本单写入」
    // 这个交错照样会把新文档盖掉。锁只在闭包外这一段同步代码里持有，不跨 await。
    {
        let mut guard = lock_doc();
        if PGS_GEN.load(Ordering::SeqCst) != my_gen {
            return Err("PGS 解析已被更新的请求取代".into());
        }
        *guard = Some(doc);
    }
    Ok(index)
}

/// 取某条事件的 PNG，**裸 base64，不带 data URL 前缀**。
/// 前端 `pgsPump` 自己拼 `'data:image/png;base64,' + b64`（index.html:1961），
/// 这里再带一次前缀就会变成 `data:image/png;base64,data:image/png;base64,iVBOR…`，
/// 结果是「菜单说挂上了、画面没图」。桌面版与安卓前端都是这个约定。
/// 前端自己做 LRU（`pgsTrimCache`），只有当前时间附近几条会被请求。
pub fn image(index: u32) -> Result<String, String> {
    let guard = lock_doc();
    let doc = guard.as_ref().ok_or("没有加载 PGS 字幕")?;
    let bytes = doc.images.get(index as usize).ok_or("事件序号越界")?;
    Ok(base64_encode(bytes))
}

/// 释放当前 PGS 文档（切片/关闭字幕时调用，几十 MB 内存不常驻）。
pub fn close() -> Result<(), String> {
    // 先推高代际号，让还在 build 的 open 完成后自己作废；再比对一次是为了防止
    // 「close 取号之后又来了一次新 open」时把新 open 刚写好的文档关掉
    let my_gen = next_gen();
    let mut guard = lock_doc();
    if PGS_GEN.load(Ordering::SeqCst) != my_gen {
        return Ok(()); // 有更新的 open 抢先写好了文档，别关它
    }
    *guard = None;
    Ok(())
}

/// 当前时刻对应的事件下标（入参是**秒**，与前端 `art.currentTime` 一致）。
/// 前端 `pgsEventAt` 是同一套二分的 JS 实现；这里多提供一份给调试/原生侧复用，
/// 没有文档、或者时刻不落在任何事件区间里都返回 None。
pub fn event_at(t_sec: f64) -> Option<u32> {
    if !t_sec.is_finite() {
        return None;
    }
    let guard = lock_doc();
    let doc = guard.as_ref()?;
    find_event(&doc.index.events, t_sec * 1000.0)
}

/// 事件表二分：`events` 按 start 升序。找 start <= t_ms 的最后一条，
/// 只有 t_ms 落在 [start, end) 里才算命中（与前端 `pgsEventAt` 的语义一致）。
fn find_event(events: &[PgsEvent], t_ms: f64) -> Option<u32> {
    let count = events.partition_point(|e| e.start <= t_ms);
    if count == 0 {
        return None;
    }
    let idx = count - 1;
    (t_ms < events[idx].end).then_some(idx as u32)
}

/// 手写 base64（不引新依赖）：PNG 字节 → 前端可直接拼 data URL 的字符串。
fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(start: f64, end: f64) -> PgsEvent {
        PgsEvent { start, end, x: 0, y: 0, w: 1, h: 1 }
    }

    #[test]
    fn canvas_size_accepts_real_and_boundary_sizes() {
        // 1920×1080（蓝光）、3840×2160（UHD）是真实片源的两种画布
        for (w, h) in [(1u32, 1u32), (1920, 1080), (3840, 2160)] {
            assert!(check_canvas_size(w, h).is_ok(), "{w}×{h} 应被接受");
        }
    }

    #[test]
    fn canvas_size_rejects_zero_absurd_and_oversized_pixel_buffers() {
        for (w, h) in [
            (0u32, 0u32),
            (0, 1080),
            (1920, 0),
            (65535, 65535),
            (8193, 100),
            (100, 8193),
            // 边长合法但像素缓冲超过手机预算（8192×8192×4 = 256 MB）
            (8192, 8192),
        ] {
            assert!(check_canvas_size(w, h).is_err(), "{w}×{h} 应被拒绝");
        }
    }

    #[test]
    fn object_size_guard_allows_empty_but_rejects_oversized() {
        assert!(object_size_reasonable(0, 0));
        assert!(object_size_reasonable(1920, 1080));
        assert!(object_size_reasonable(8192, 8192));
        assert!(!object_size_reasonable(8193, 100));
        assert!(!object_size_reasonable(65535, 65535));
    }

    #[test]
    fn pgs_generation_only_increases() {
        let a = next_gen();
        let b = next_gen();
        assert!(b > a, "代际号必须单调递增：{a} -> {b}");
    }

    #[test]
    fn base64_matches_known_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(&[0x89, b'P', b'N', b'G']), "iVBORw==");
    }

    #[test]
    fn find_event_hits_interval_and_rejects_gaps() {
        let events = [ev(1000.0, 3000.0), ev(5000.0, 7000.0)];
        assert_eq!(find_event(&events, 0.0), None);
        assert_eq!(find_event(&events, 999.0), None);
        assert_eq!(find_event(&events, 1000.0), Some(0)); // 左闭
        assert_eq!(find_event(&events, 2999.0), Some(0));
        assert_eq!(find_event(&events, 3000.0), None); // 右开
        assert_eq!(find_event(&events, 4000.0), None); // 事件之间的空档
        assert_eq!(find_event(&events, 5000.0), Some(1));
        assert_eq!(find_event(&events, 9999.0), None);
    }

    #[test]
    fn find_event_handles_empty_and_touching_intervals() {
        assert_eq!(find_event(&[], 1000.0), None);
        // 首尾相接的两条：分界点归后一条（start <= t 取最后一条）
        let events = [ev(0.0, 1000.0), ev(1000.0, 2000.0)];
        assert_eq!(find_event(&events, 999.0), Some(0));
        assert_eq!(find_event(&events, 1000.0), Some(1));
    }

    #[test]
    fn index_json_shape_matches_frontend_contract() {
        // 前端 pgsIndexData 直接读 canvas_w / canvas_h / events[].start/end/x/y/w/h。
        // 这条断言把字段名和形状钉死：改名字会在这里先红，而不是等到真机上
        // 「菜单说挂上了、画面没图」。
        let index = PgsIndex {
            canvas_w: 1920,
            canvas_h: 1080,
            events: vec![PgsEvent { start: 1000.0, end: 3000.0, x: 13, y: 900, w: 40, h: 20 }],
        };
        let json = serde_json::to_string(&index).expect("索引应能序列化");
        assert_eq!(
            json,
            r#"{"canvas_w":1920,"canvas_h":1080,"events":[{"start":1000.0,"end":3000.0,"x":13,"y":900,"w":40,"h":20}]}"#
        );
    }

    /// 端到端：用 libpgs 自己的编码器造一条最小 PGS 轨（1920×1080 画布、40×20 实心块
    /// 放在 (100,900)、PTS 2000 ms），写成 .sup，再让 `build()` 走一遍真实的
    /// 抽取 → RLE 解码 → 合成 → PNG 编码链路。这条测试不需要任何外部片源，
    /// 修的是「编译过了但画面没图」这类只有真机才会暴露的问题。
    #[test]
    fn synthetic_sup_decodes_to_png_event() {
        use libpgs::pgs::{
            CompositionObject, DisplaySetBuilder, ObjectBitmap, PcsData, PdsData, WindowDefinition,
            WdsData,
        };

        let pcs = PcsData {
            video_width: 1920,
            video_height: 1080,
            composition_number: 0,
            composition_state: CompositionState::EpochStart,
            palette_only: false,
            palette_id: 0,
            objects: vec![CompositionObject { object_id: 1, window_id: 0, x: 100, y: 900, crop: None }],
        };
        let wds = WdsData {
            windows: vec![WindowDefinition { id: 0, x: 100, y: 900, width: 40, height: 20 }],
        };
        // 调色板 1 号：BT.601 白 (Y=235, Cb=Cr=128)，完全不透明
        let pds = PdsData {
            id: 0,
            version: 0,
            entries: vec![PaletteEntry { id: 1, luminance: 235, cr: 128, cb: 128, alpha: 255 }],
        };
        let obj = ObjectBitmap { id: 1, version: 0, width: 40, height: 20, pixels: vec![1u8; 40 * 20] };
        // PGS 时间戳是 90 kHz 时钟：2000 ms -> 180000
        let ds = DisplaySetBuilder::new(2_000 * 90)
            .pcs(pcs)
            .wds(wds)
            .palette(pds)
            .object(obj)
            .build()
            .expect("构造显示集");

        let path = std::env::temp_dir()
            .join(format!("bplayer_pgs_synthetic_{}.sup", std::process::id()));
        libpgs::write_sup_file(&[ds], &path).expect("写 SUP");
        let doc = build(path.to_str().unwrap(), 0).expect("合成 PGS 位图");
        let _ = std::fs::remove_file(&path);

        assert_eq!((doc.index.canvas_w, doc.index.canvas_h), (1920, 1080));
        assert_eq!(doc.index.events.len(), 1);
        let e = &doc.index.events[0];
        // 位置尺寸是裁掉透明边后的对象外接矩形；未清屏时默认 2 s 时长
        assert_eq!((e.x, e.y, e.w, e.h), (100, 900, 40, 20));
        assert_eq!((e.start, e.end), (2000.0, 4000.0));

        assert_eq!(&doc.images[0][..8], b"\x89PNG\r\n\x1a\n", "应是 PNG 魔数");
        let mut reader = png::Decoder::new(&doc.images[0][..]).read_info().expect("读 PNG 头");
        let mut buf = vec![0u8; reader.output_buffer_size()];
        let info = reader.next_frame(&mut buf).expect("解 PNG 数据");
        assert_eq!((info.width, info.height), (40, 20));
        assert_eq!(info.color_type, png::ColorType::Rgba);
        assert_eq!(buf[3], 255, "调色板 alpha=255 的像素应不透明");
        assert_eq!(&buf[..3], &[235, 235, 235], "Y=235 的中性色应还原成白");

        // 前端拿到的 base64 必须是裸串（前缀由前端自己拼），且能解回同一张 PNG
        let b64 = base64_encode(&doc.images[0]);
        assert!(!b64.starts_with("data:"), "pgs_image 不能带 data URL 前缀");
        assert!(b64.starts_with("iVBORw0KGgo"), "PNG 的 base64 应以 iVBORw0KGgo 开头");
    }
}
