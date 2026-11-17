// 把阻塞的 IO / 目录遍历挪出 Android 的 invoke 通道。
//
// Tauri 同步命令本身不会冻住窗口消息循环，真正的代价是**所有 invoke 共用同一条串行
// 通道**：wry 0.57.2 的 Android 实现把 IPC 派发器固定成
// `Executors.newSingleThreadExecutor()`（wry/src/android/kotlin/Ipc.kt:62），一条命令
// 没返回，后面排队的命令就都拿不到执行机会。桌面版 Bplayer 8e6c4f7 实测：一条 SMB
// 断连的 `fs_stat` 耗时 2997 ms，期间并发发起的本地快命令同样 2997 ms 才返回；
// 改成 async + spawn_blocking 之后降到 2.1 ms。
//
// Android 上本地路径也可能落在 /sdcard、SMB/WebDAV 虚拟挂载或 FUSE 上：单次
// `metadata()` 就可能几十毫秒到数秒，`list_dir` 还是逐条 metadata 的 O(n)。一条慢
// 命令会把挂字幕、探音轨、刷进度、封面读取全部堵在后面，用户看到的是"点了没反应、
// 菜单不刷新"。
//
// 官方文档（v2.tauri.app/develop/calling-rust）要求这类命令声明成 `async` 让出通道。
// 但只写 `async` 还不够：async fn 的函数体跑在 tokio worker 上，里面的阻塞调用仍会
// 饿死异步运行时。真正的阻塞段必须交给 spawn_blocking 的专用线程池 —— 这个模块就是
// 那层薄壳。
//
// 用法约束：`#[tauri::command]` 的 async 函数里不要跨 `.await` 持有非 Send 的东西
// （MutexGuard、Rc 等）。本模块只把整个闭包搬进阻塞线程，闭包内部没有 await，所以
// 天然满足。

/// 在阻塞线程池里执行 `f`。
///
/// 返回 `Result<T, String>` 而不是 `T`：失败只可能来自 `spawn_blocking` 本身（任务
/// panic 或异步运行时已关闭），由调用方决定兜底方式 ——
/// 原本"永不 reject"的命令（`fs_stat` / `scan_subtitles` / `scan_folder` /
/// `sidecar_cache_files` / `pair_danmaku`）用 `unwrap_or` / `ok()` 保持原语义；
/// 原本就返回 `Result` 的命令用 `?` 把错误串透传，前端显示的错误消息格式不变。
pub async fn blocking<F, T>(f: F) -> Result<T, String>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|error| format!("后台任务异常退出: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 真的跑到另一个线程上：只靠 async 的话，阻塞调用会占着 tokio worker。
    #[test]
    fn runs_off_thread_and_returns_value() {
        let caller = std::thread::current().id();
        let (worker, value) = tauri::async_runtime::block_on(blocking(move || {
            (std::thread::current().id(), 42u32)
        }))
        .unwrap();
        assert_eq!(value, 42);
        assert_ne!(worker, caller, "阻塞任务应该跑在 spawn_blocking 线程池里");
    }
}
