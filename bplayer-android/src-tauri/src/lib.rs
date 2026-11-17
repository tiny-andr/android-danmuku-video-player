// Bplayer Android 后端：复用桌面版的纯 std 命令，移除 Windows 专属实现。
// 文件模型：All-files 权限下直接读写 /sdcard 真实路径，asset 协议负责流式播放。
use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

const MAX_SIDECAR_BYTES: u64 = 32 * 1024 * 1024;

fn read_sidecar(path: &Path) -> Result<Vec<u8>, String> {
    let input = fs::File::open(path).map_err(|error| error.to_string())?;
    let metadata = input.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_SIDECAR_BYTES {
        return Err("附件不是普通文件或超过 32 MiB 限制".into());
    }
    let mut bytes = Vec::new();
    input.take(MAX_SIDECAR_BYTES + 1).read_to_end(&mut bytes).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_SIDECAR_BYTES {
        return Err("附件超过 32 MiB 读取限制".into());
    }
    Ok(bytes)
}

mod blocking;
mod http_range;
mod mkv_probe;
mod mkv_sub;
mod pgs_render;

use crate::blocking::blocking;

const VIDEO_EXTS: &[&str] = &[
    "mp4", "m4v", "webm", "mov", "mkv", "avi", "ts", "flv", "wmv", "mpg", "mpeg",
];
const CACHE_TAG: &str = " (AAC)";

fn is_video(name: &str) -> bool {
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    VIDEO_EXTS.contains(&ext.as_str())
}

fn is_cache_name(name: &str) -> bool {
    match Path::new(name).file_stem().and_then(|s| s.to_str()) {
        Some(stem) => stem.ends_with(CACHE_TAG) || stem.ends_with(&format!("{CACHE_TAG}.tmp")),
        None => false,
    }
}

fn base_name(name: &str) -> String {
    match name.rfind('.') {
        Some(i) => name[..i].to_string(),
        None => name.to_string(),
    }
}

#[derive(Serialize)]
pub struct FsStat {
    kind: String, // "file" | "dir" | "missing"
    size: u64,
}

/// 探路径类型/大小。Android 上 /sdcard、SMB/WebDAV 挂载点单次 metadata 可能耗时数秒，
/// 放同步命令会堵住整条串行 invoke 通道，所以整个调用搬进阻塞线程池。
#[tauri::command]
async fn fs_stat(path: String) -> FsStat {
    blocking(move || match fs::metadata(&path) {
        Ok(m) => FsStat {
            kind: if m.is_dir() { "dir" } else { "file" }.into(),
            size: m.len(),
        },
        Err(_) => FsStat { kind: "missing".into(), size: 0 },
    })
    .await
    // 原命令永不 reject（任何失败都返回 missing），保持前端语义。
    .unwrap_or(FsStat { kind: "missing".into(), size: 0 })
}

#[derive(Serialize)]
pub struct DanmakuPayload {
    name: String,
    text: String,
}

const SUB_EXTS: &[&str] = &["srt", "ass", "ssa", "vtt"];

#[derive(Serialize)]
pub struct SubFile {
    name: String,
    path: String,
}

/// 扫描视频同目录的外挂字幕：基名相同或带语言/标题后缀变体。
/// 目录遍历 + 逐条 `is_file()` 都是磁盘/网络 IO，搬进阻塞线程池。
#[tauri::command]
async fn scan_subtitles(video_path: String) -> Vec<SubFile> {
    blocking(move || {
        let vp = Path::new(&video_path);
        let dir = match vp.parent() {
            Some(d) => d,
            None => return vec![],
        };
        let base = base_name(&vp.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()).to_lowercase();
        let mut out: Vec<SubFile> = Vec::new();
        if let Ok(rd) = fs::read_dir(dir) {
            for entry in rd.flatten() {
                let p = entry.path();
                if !p.is_file() {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().into_owned();
                let ext = Path::new(&name)
                    .extension()
                    .map(|e| e.to_string_lossy().to_ascii_lowercase())
                    .unwrap_or_default();
                if !SUB_EXTS.contains(&ext.as_str()) || name.contains(".tmp") {
                    continue;
                }
                let stem_lc = base_name(&name).to_lowercase();
                if !(stem_lc == base || stem_lc.starts_with(&format!("{base}."))) {
                    continue;
                }
                if name.contains(" (字幕") || name.contains(" (音轨") || name.contains(CACHE_TAG) {
                    continue;
                }
                out.push(SubFile { name, path: p.to_string_lossy().into_owned() });
            }
        }
        out.sort_by(|a, b| {
            let a_exact = base_name(&a.name).to_lowercase() == base;
            let b_exact = base_name(&b.name).to_lowercase() == base;
            b_exact.cmp(&a_exact).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        out
    })
    .await
    // 原命令失败时返回空列表，保持前端语义。
    .unwrap_or_default()
}

/// 读取文件字节并以 base64 返回（字幕编码探测用）。
/// 最多 32 MiB 的读盘 + base64 编码都搬进阻塞线程池，避免堵住 invoke 通道。
#[tauri::command]
async fn read_bytes(path: String) -> Result<String, String> {
    blocking(move || -> Result<String, String> {
        let bytes = read_sidecar(Path::new(&path))?;
        Ok(b64_encode(&bytes))
    })
    .await?
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
fn b64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { B64[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64[n as usize & 63] as char } else { '=' });
    }
    out
}

/// 在视频同目录找同名弹幕文件（xml 优先于 json），并读出文本。
/// 目录遍历 + 最多 32 MiB 读盘都搬进阻塞线程池。
#[tauri::command]
async fn pair_danmaku(video_path: String) -> Option<DanmakuPayload> {
    blocking(move || -> Option<DanmakuPayload> {
        let vp = Path::new(&video_path);
        let dir = vp.parent()?;
        let base = base_name(&vp.file_name()?.to_string_lossy()).to_lowercase();
        let mut best: Option<(u8, PathBuf)> = None;
        for entry in fs::read_dir(dir).ok()?.flatten() {
            let p = entry.path();
            if !p.is_file() {
                continue;
            }
            let name = p.file_name()?.to_string_lossy().to_string();
            let ext = p.extension()?.to_string_lossy().to_ascii_lowercase();
            let prio = match ext.as_str() {
                "xml" => 0u8,
                "json" => 1u8,
                _ => continue,
            };
            if base_name(&name).to_lowercase() != base {
                continue;
            }
            if best.as_ref().map(|(b, _)| prio < *b).unwrap_or(true) {
                best = Some((prio, p));
            }
        }
        let (_, p) = best?;
        let bytes = read_sidecar(&p).ok()?;
        Some(DanmakuPayload {
            name: p.file_name()?.to_string_lossy().to_string(),
            text: String::from_utf8_lossy(&bytes).into_owned(),
        })
    })
    .await
    // 原命令失败时返回 None，保持前端语义。
    .ok()
    .flatten()
}

#[derive(Serialize)]
pub struct Episode {
    name: String,
    path: String,
    size: u64,
    danmaku: Option<String>,
}

#[derive(Serialize)]
pub struct FolderScan {
    label: String,
    episodes: Vec<Episode>,
}

/// 扫描剧集目录：视频文件 + 每个文件的大小，并配对同名弹幕。
/// 目录遍历 + 逐条 `metadata()` 最慢（SMB/FUSE 上 O(n) 次往返），必须离开 invoke 通道。
#[tauri::command]
async fn scan_folder(dir: String) -> FolderScan {
    // 只用于 spawn_blocking 本身失败（panic/运行时关闭）的兜底，与命令原返回值一致。
    let fallback_label = Path::new(&dir)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| dir.clone());
    blocking(move || {
        let dp = Path::new(&dir);
        let mut videos: Vec<(String, PathBuf, u64)> = Vec::new();
        let mut dan_map: std::collections::HashMap<String, (u8, String)> = std::collections::HashMap::new();
        if let Ok(rd) = fs::read_dir(dp) {
            for entry in rd.flatten() {
                let p = entry.path();
                if !p.is_file() {
                    continue;
                }
                let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                let ext = p.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
                if is_video(&name) {
                    if is_cache_name(&name) {
                        continue;
                    }
                    let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                    videos.push((name, p, size));
                } else if ext == "xml" || ext == "json" {
                    let prio = if ext == "xml" { 0u8 } else { 1u8 };
                    let key = base_name(&name).to_lowercase();
                    let replace = dan_map.get(&key).map(|(p, _)| prio < *p).unwrap_or(true);
                    if replace {
                        dan_map.insert(key, (prio, name));
                    }
                }
            }
        }
        videos.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));
        let episodes = videos
            .into_iter()
            .map(|(name, p, size)| {
                let base = base_name(&name).to_lowercase();
                let danmaku = dan_map.get(&base).map(|(_, n)| n.clone());
                Episode { name, path: p.to_string_lossy().to_string(), size, danmaku }
            })
            .collect();
        FolderScan {
            label: dp.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| dir.clone()),
            episodes,
        }
    })
    .await
    .unwrap_or(FolderScan { label: fallback_label, episodes: Vec::new() })
}

/// 读取文本附件（字幕/弹幕）并做 UTF-8 容错解码。读盘搬进阻塞线程池。
#[tauri::command]
async fn read_text(path: String) -> Result<String, String> {
    blocking(move || -> Result<String, String> {
        let bytes = read_sidecar(Path::new(&path))?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    })
    .await?
}

/// 探测 MKV/WebM 轨道。虽然只读文件头部，但 open + 多次 read/seek 在网络存储上
/// 每次都是往返，仍属于阻塞 IO，搬进阻塞线程池。
#[tauri::command]
async fn probe_mkv_tracks(path: String) -> Result<mkv_probe::MkvProbe, String> {
    blocking(move || mkv_probe::probe(&path)).await?
}

// ---------------- Android 文件浏览器 ----------------

#[derive(Serialize)]
struct DirEntryInfo {
    name: String,
    path: String,
    size: u64,
    is_dir: bool,
    modified_ms: Option<u64>,
}

#[derive(Serialize)]
struct DirListing {
    dir: String,
    entries: Vec<DirEntryInfo>,
}

/// 列出目录内容。给自定义文件浏览器用（rfd 在 Android 没有实现）。
/// 每条 `entry.metadata()` 都是一次 stat，SMB/FUSE 上 O(n) 次往返最慢，必须异步。
#[tauri::command]
async fn list_dir(dir: String) -> Result<DirListing, String> {
    blocking(move || -> Result<DirListing, String> {
        let dp = Path::new(&dir);
        let rd = fs::read_dir(dp).map_err(|e| format!("读取目录失败 {dir}: {e}"))?;
        let mut entries = Vec::new();
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let path = entry.path();
            let meta = entry.metadata().ok();
            let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
            if !is_dir && !is_video(&name) && !matches!(
                Path::new(&name).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase().as_str(),
                "xml" | "json" | "srt" | "ass" | "ssa" | "vtt" | "mka" | "m4a"
            ) {
                continue;
            }
            entries.push(DirEntryInfo {
                name,
                path: path.to_string_lossy().to_string(),
                size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
                is_dir,
                modified_ms: meta.and_then(|m| m.modified().ok())
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .and_then(|elapsed| u64::try_from(elapsed.as_millis()).ok()),
            });
        }
        Ok(DirListing {
            dir: dp.to_string_lossy().to_string(),
            entries,
        })
    })
    .await?
}

// ---------------- Android 暂不支持的桌面能力 ----------------

#[tauri::command]
fn pick_video() -> Option<String> {
    None
}

#[tauri::command]
fn pick_folder() -> Option<String> {
    None
}

#[tauri::command]
fn reveal_path(_path: String) -> Result<(), String> {
    Err("Android 没有资源管理器定位，请用应用内缓存管理".into())
}

#[tauri::command]
fn get_autostart() -> bool {
    false
}

#[tauri::command]
fn set_autostart(_enable: bool) -> bool {
    false
}

/// 旧桌面版「同名缓存列表」入口。**故意只返回空列表**，绝不再遍历目录。
///
/// 历史实现按「`{stem} (` 前缀 + 文件名含 `.tmp.`」匹配同目录的 `.mka`/`.srt`，把结果
/// 当成可以清理的派生缓存；桌面版实测会连用户自己的普通文件一起误删（`反派 (上).tmp.txt`、
/// `某片 (备注).tmp.mka` 这类名字碰巧套娃的文件），Windows 侧已明令禁止这种判据。
///
/// Android 这边这条通路没有调用方（`ui/` 里只剩 `android-storage.js` 的网络路径短路分支，
/// 没有任何 `invoke('sidecar_cache_files')`），本地/网络缓存统一走 `AndroidAudioNative` 的
/// `audio_cache_files`，真正的 staging 清理在 Kotlin `AudioDecodeService` 里按会话 UUID
/// 目录精确删除。命令保留注册只是为了旧前端 invoke 不报错，返回值恒为空。
#[tauri::command]
async fn sidecar_cache_files(_video_path: String) -> Vec<String> {
    Vec::new()
}

// ---------------- 版本信息 ----------------

/// 应用版本号，供信息卡/设置页显示。
///
/// 与安装包同源：值来自 `Cargo.toml` 的 `[package] version`（编译期常量）；
/// Android 的 versionName 由 `tauri.conf.json` 的 `version` 生成，两处当前都是
/// 0.1.0，发版时一起改（外加 changelog），网页侧不要再硬编码版本号。
/// 纯编译期常量，毫秒级以下，保持同步命令。
#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
fn transcode_target(_video_path: String, _audio_index: i64) -> Result<String, String> {
    Err("Android 版尚未打包 ffmpeg，音轨转码待 P3".into())
}

#[tauri::command]
fn transcode_audio_start(_video_path: String, _audio_index: i64, _duration_us: Option<u64>) -> Result<(), String> {
    Err("Android 版尚未打包 ffmpeg，音轨转码待 P3".into())
}

/// 抽取内嵌文本字幕（纯内存，不落盘），返回 `[{ index, text }]`，`text` 是 SRT 文本。
///
/// 走 `mkv_sub::sparse_extract_srt`：按 MKV 的 Cues 索引 seek 到每条字幕 block，
/// 只读字幕那几 MB（桌面实测 35.6 GB UHD 片源读 13.4 MB），不顺序扫整片。
///
/// 与桌面版的差异：桌面版抽不出来会回退 ffmpeg 顺序扫一遍；安卓安装包里没有 ffmpeg，
/// 也没有 spawn 子进程的通道，所以抽不出来的轨直接跳过（不进返回数组，不返回空文本）。
/// 一条都没抽出来时返回 Err —— 前端会弹出具体原因，而不是显示"正在后台抽取"的假进度。
///
/// 一条轨要随机读几十到上千个块，在 /sdcard 的 FUSE 或 SMB 挂载上是秒级 IO，
/// 必须 async + blocking 离开单线程 IPC 通道（见 blocking.rs）。
#[tauri::command]
async fn extract_subtitle_text(
    video_path: String,
    subs: Vec<mkv_sub::SubTrack>,
    duration_us: Option<u64>,
) -> Result<serde_json::Value, String> {
    blocking(move || extract_subtitle_text_impl(video_path, subs, duration_us)).await?
}

/// 一条抽好的字幕：`index` 原样回传给前端（靠它认领轨道），`text` 为 SRT 文本。
#[derive(Serialize)]
struct SubText {
    index: usize,
    text: String,
}

fn extract_subtitle_text_impl(
    video_path: String,
    subs: Vec<mkv_sub::SubTrack>,
    _duration_us: Option<u64>,
) -> Result<serde_json::Value, String> {
    let src = PathBuf::from(&video_path);
    if !src.is_file() {
        return Err("源视频不存在".into());
    }
    let mut ready: Vec<SubText> = Vec::new();
    let mut failed: Vec<String> = Vec::new();
    for sub in subs {
        match mkv_sub::sparse_extract_srt(&src, sub.track, sub.ass) {
            Ok(srt) if !srt.trim().is_empty() => ready.push(SubText { index: sub.index, text: srt }),
            Ok(_) => failed.push(format!("轨 {}: 解析结果为空", sub.track)),
            Err(error) => failed.push(format!("轨 {}: {error}", sub.track)),
        }
    }
    if ready.is_empty() && !failed.is_empty() {
        return Err(format!(
            "内嵌字幕无法稀疏抽取（Android 没有 ffmpeg 兜底）：{}",
            failed.join("；")
        ));
    }
    serde_json::to_value(ready).map_err(|error| error.to_string())
}

#[tauri::command]
fn transcode_audio_cancel() -> Result<bool, String> {
    Ok(false)
}

/// 网络源的内嵌字幕抽取。
///
/// 和本地版共用 `mkv_sub` 的稀疏解析（按 Cues 只读字幕块），区别只在字节来源：
/// 网络源在 Android 上没有可挂载路径，这里走本机媒体代理的 HTTP Range。
/// 不这么做就只能让 ffmpeg 顺序读整片（实测 7.5 GB 的片要四十分钟），
/// 与桌面版"几秒抽完"完全不是一个量级。
#[tauri::command]
async fn extract_subtitle_text_url(
    url: String,
    size: u64,
    subs: Vec<mkv_sub::SubTrack>,
    duration_us: Option<u64>,
) -> Result<serde_json::Value, String> {
    blocking(move || {
        let _ = duration_us;
        if size == 0 {
            return Err("远端文件为空，无法抽取字幕".to_string());
        }
        let mut reader = http_range::HttpRangeReader::new(url, size);
        let mut ready: Vec<SubText> = Vec::new();
        let mut failed: Vec<String> = Vec::new();
        for sub in subs {
            match mkv_sub::sparse_extract_srt_reader(&mut reader, sub.track, sub.ass) {
                Ok(srt) if !srt.trim().is_empty() => ready.push(SubText { index: sub.index, text: srt }),
                Ok(_) => failed.push(format!("轨 {}: 解析结果为空", sub.track)),
                Err(error) => failed.push(format!("轨 {}: {error}", sub.track)),
            }
        }
        if ready.is_empty() && !failed.is_empty() {
            return Err(format!("内嵌字幕无法稀疏抽取：{}", failed.join("；")));
        }
        serde_json::to_value(ready).map_err(|error| error.to_string())
    })
    .await?
}

/// 旧桌面版清理半成品缓存的入口，Android 上是**有意的空实现**。
///
/// 前端 `index.html` 换片时仍会 `invoke('clean_sidecar_tmp', …)`，所以保留注册；
/// 真正的 staging 清理在 Kotlin `AudioDecodeService` 里按会话 UUID 目录精确删除。
/// 禁止在这里恢复「基名前缀 + 含 `.tmp.`」的目录扫描：桌面实测会误删用户文件
/// （`反派 (上).tmp.txt`、`某片 (备注).tmp.mka`）。见 `sidecar_cache_files` 的说明。
#[tauri::command]
fn clean_sidecar_tmp(_video_path: String) -> Result<(), String> {
    Ok(())
}

/// 打开一条 PGS 位图字幕轨：抽取 + RLE 解码 + 合成 PNG 事件表，返回索引
/// `{ canvas_w, canvas_h, events: [{start,end,x,y,w,h}] }`（时间单位毫秒）。
/// 抽取一次几秒（手机 /sdcard 走 FUSE 会更慢），必须 async + 阻塞线程池，
/// 否则整条串行 invoke 通道会被堵住（见 blocking.rs）。
#[tauri::command]
async fn pgs_open(video_path: String, track: u64) -> Result<pgs_render::PgsIndex, String> {
    pgs_render::open(video_path, track).await
}

/// 取一条事件的 PNG（裸 base64，前端自己拼 `data:image/png;base64,`）。纯内存，保持同步。
#[tauri::command]
fn pgs_image(index: u32) -> Result<String, String> {
    pgs_render::image(index)
}

/// 释放当前 PGS 文档（位图字幕关闭/切片/换轨时调用）。纯内存，保持同步。
#[tauri::command]
fn pgs_close() -> Result<(), String> {
    pgs_render::close()
}

/// 当前播放时刻（秒）对应的事件下标；无文档或不在任何事件区间返回 null。
#[tauri::command]
fn pgs_current(t: f64) -> Option<u32> {
    pgs_render::event_at(t)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            fs_stat,
            pair_danmaku,
            scan_folder,
            read_text,
            read_bytes,
            scan_subtitles,
            probe_mkv_tracks,
            list_dir,
            app_version,
            pick_video,
            pick_folder,
            reveal_path,
            get_autostart,
            set_autostart,
            sidecar_cache_files,
            transcode_target,
            transcode_audio_start,
            extract_subtitle_text,
            extract_subtitle_text_url,
            transcode_audio_cancel,
            clean_sidecar_tmp,
            pgs_open,
            pgs_image,
            pgs_close,
            pgs_current
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
