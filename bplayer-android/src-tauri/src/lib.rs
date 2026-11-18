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
// http_range / mkv_probe / mkv_sub / pgs_render are parked: libmpv now demuxes the container
// and renders subtitles (text, ASS and PGS) itself, so nothing here parses MKV or decodes PGS.
// The sources live in tmp/parked-rust/ until the port is merged.

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

/// 与 `transcode_audio_start` 配套的空实现：前端换片/退出时仍会调它，保留注册。
#[tauri::command]
fn transcode_audio_cancel() -> Result<bool, String> {
    Ok(false)
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
            transcode_audio_cancel,
            clean_sidecar_tmp
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
