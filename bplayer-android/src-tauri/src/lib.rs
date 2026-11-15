// Bplayer Android 后端：复用桌面版的纯 std 命令，移除 Windows 专属实现。
// 文件模型：All-files 权限下直接读写 /sdcard 真实路径，asset 协议负责流式播放。
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

mod mkv_probe;

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

#[tauri::command]
fn fs_stat(path: String) -> FsStat {
    match fs::metadata(&path) {
        Ok(m) => FsStat {
            kind: if m.is_dir() { "dir" } else { "file" }.into(),
            size: m.len(),
        },
        Err(_) => FsStat { kind: "missing".into(), size: 0 },
    }
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
#[tauri::command]
fn scan_subtitles(video_path: String) -> Vec<SubFile> {
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
}

/// 读取文件字节并以 base64 返回（字幕编码探测用）。
#[tauri::command]
fn read_bytes(path: String) -> Result<String, String> {
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    Ok(b64_encode(&bytes))
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

#[tauri::command]
fn pair_danmaku(video_path: String) -> Option<DanmakuPayload> {
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
    let bytes = fs::read(&p).ok()?;
    Some(DanmakuPayload {
        name: p.file_name()?.to_string_lossy().to_string(),
        text: String::from_utf8_lossy(&bytes).into_owned(),
    })
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

#[tauri::command]
fn scan_folder(dir: String) -> FolderScan {
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
}

#[tauri::command]
fn read_text(path: String) -> Result<String, String> {
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[tauri::command]
fn probe_mkv_tracks(path: String) -> Result<mkv_probe::MkvProbe, String> {
    mkv_probe::probe(&path)
}

// ---------------- Android 文件浏览器 ----------------

#[derive(Serialize)]
struct DirEntryInfo {
    name: String,
    path: String,
    size: u64,
    is_dir: bool,
}

#[derive(Serialize)]
struct DirListing {
    dir: String,
    entries: Vec<DirEntryInfo>,
}

/// 列出目录内容。给自定义文件浏览器用（rfd 在 Android 没有实现）。
#[tauri::command]
fn list_dir(dir: String) -> Result<DirListing, String> {
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
            size: meta.map(|m| m.len()).unwrap_or(0),
            is_dir,
        });
    }
    Ok(DirListing {
        dir: dp.to_string_lossy().to_string(),
        entries,
    })
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

#[tauri::command]
fn sidecar_cache_files(video_path: String) -> Vec<String> {
    let vp = Path::new(&video_path);
    let Some(dir) = vp.parent() else { return Vec::new() };
    let stem = vp.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    if stem.is_empty() {
        return Vec::new();
    }
    let prefix = format!("{stem} (");
    let mut out = Vec::new();
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if !name.starts_with(&prefix) || name.contains(".tmp.") {
                continue;
            }
            let lower = name.to_ascii_lowercase();
            if lower.ends_with(".mka") || lower.ends_with(".srt") {
                out.push(e.path().to_string_lossy().into_owned());
            }
        }
    }
    out.sort();
    out
}

#[tauri::command]
fn transcode_target(_video_path: String, _audio_index: i64) -> Result<String, String> {
    Err("Android 版尚未打包 ffmpeg，音轨转码待 P3".into())
}

#[tauri::command]
fn transcode_audio_start(_video_path: String, _audio_index: i64, _duration_us: Option<u64>) -> Result<(), String> {
    Err("Android 版尚未打包 ffmpeg，音轨转码待 P3".into())
}

#[tauri::command]
fn extract_subtitle_text(_video_path: String, _subs: serde_json::Value, _duration_us: Option<u64>) -> Result<serde_json::Value, String> {
    Err("Android 版内嵌字幕抽取待 P3".into())
}

#[tauri::command]
fn transcode_audio_cancel() -> Result<bool, String> {
    Ok(false)
}

#[tauri::command]
fn clean_sidecar_tmp(_video_path: String) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
fn pgs_open(_video_path: String, _track: u64) -> Result<serde_json::Value, String> {
    Err("Android 版 PGS 解码待 P3".into())
}

#[tauri::command]
fn pgs_image(_index: u32) -> Result<String, String> {
    Err("Android 版 PGS 解码待 P3".into())
}

#[tauri::command]
fn pgs_close() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
fn pgs_current(_t: f64) -> Option<u32> {
    None
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
            pick_video,
            pick_folder,
            reveal_path,
            get_autostart,
            set_autostart,
            sidecar_cache_files,
            transcode_target,
            transcode_audio_start,
            extract_subtitle_text,
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
