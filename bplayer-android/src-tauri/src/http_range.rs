// 按 HTTP Range 随机读的实现，给 `mkv_sub::sparse_extract_srt_reader` 当本地文件用。
//
// 为什么需要它：MKV 字幕的稀疏抽取靠 Cues 索引按位置跳读，一条 cue 两次小读
// （簇头拿 ClusterTimestamp、簇深处拿字幕块），一条 2 小时的片子一千多条 cue。
// 桌面版这些读直接落在 SMB 挂载路径上，几千次也就几秒；Android 没有可挂载的 SMB，
// 播放层只能经本机 NanoHTTPD 代理用 `Range: bytes=a-b` 取字节。
//
// 三道优化缺一不可（同一部 7.56 GB、1947 条 cue 的 4K 片，从 5–10 分钟降到秒级）：
//
// 1. **连接复用**：所有请求共用一个 `ureq::Agent`。用顶层 `ureq::get()` 的话每次
//    Range 都是新的 TCP 连接 + NanoHTTPD 新建 handler 线程，固定开销比传输本身还大。
// 2. **大块直拉**：`read` 一次要几 MB 时（MKV 头部 2 MiB、Cues 索引几百 KB）一次取够。
//    按 32 KiB 分块会把"读一次头部"变成几百次往返。
// 3. **并发预取**：`prefetch` 在逐条 cue 解析之前把这些区间并发取回。
//    串行两千多次 × 150–250 ms 就是 4–6 分钟，这才是"字幕一直抽不出来"的真正原因。

use std::collections::BTreeMap;
use std::io::{self, Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use crate::mkv_sub::RandomRead;

/// `read` 按需单取时的最小块。
///
/// 逐条 cue 解析时单次 `read` 只有 96 字节（簇头）；若每次都按这个长度请求，
/// 一次往返只拿 96 字节。统一垫到 32 KiB，顺带把同簇相邻的少量数据一并取回。
const BLOCK: u64 = 32 * 1024;

/// 两个预取区间的间距小于这个值就合并成一次请求。
///
/// 一次往返的固定开销（实测 150–250 ms）远贵于多传几十 KB（局域网几毫秒），
/// 所以"读一段连续区间"永远比"读两个相邻小块"划算。
const MERGE: u64 = 64 * 1024;

/// 预取缓存上限。
///
/// 实测一部 1947 条 cue 的片，预取总量约 12 MiB（1400 个簇头 128 B + 1400 个块 8 KiB）。
/// 超过这个量说明片子字幕极端密集（上万条）或 Cues 异常。此时截断预取、剩下的
/// 走按需读——宁可多等几秒也不能把 app 撑爆。
const MAX_CACHE_BYTES: usize = 96 * 1024 * 1024;

/// 预取并发度。
///
/// 实测标定（真机、真 SMB 片源、816 个 Range 请求）：
///   并发 1 → 73 ms/请求；并发 4 → 18 ms/请求；并发 8/12/16 → 与 4 完全相同。
/// 也就是说本机媒体代理的吞吐在 4 路就饱和了，再往上只会多占 NanoHTTPD 的工作线程
/// （它是固定大小、满了直接拒绝的 SynchronousQueue 池），反而让请求失败重试。
const PREFETCH_THREADS: usize = 4;

/// 单次 HTTP Range 请求的超时。
///
/// 正常一次 32 KiB 局域网读是 150–250 ms；本地 SMB 卡住时宁可让这一块失败
/// （后续按需读会重试），也不要让整个抽取挂在一次请求上。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

pub struct HttpRangeReader {
    url: String,
    len: u64,
    pos: u64,
    agent: ureq::Agent,
    /// 已取回的块，键是块在文件里的起始偏移。用 BTreeMap 而不是 HashMap：查找
    /// "覆盖 pos 的那一块"要知道它前面最近的块起点，有序表一次 `range(..=pos)` 就够。
    blocks: BTreeMap<u64, Vec<u8>>,
    cache_bytes: usize,
}

impl HttpRangeReader {
    pub fn new(url: String, len: u64) -> Self {
        let agent = ureq::AgentBuilder::new()
            .timeout(REQUEST_TIMEOUT)
            // 连接池按并发度留量：每个预取线程一条常驻连接，复用到抽取结束。
            .max_idle_connections_per_host(PREFETCH_THREADS + 4)
            .build();
        Self { url, len, pos: 0, agent, blocks: BTreeMap::new(), cache_bytes: 0 }
    }

    /// 取 `[start, start+want)`。返回可能短于 `want`（文件尾），由调用方按实际长度处理。
    ///
    /// 只接受 206；200 仅当 `start == 0`（RFC 7233 允许 Range 覆盖整个资源时回 200，
    /// 此时响应体开头正好是要的起点）。`start != 0` 的 200 说明上游忽略了 Range、
    /// 从头返回整个文件——照单全收就会把**文件头**当成偏移 `start` 处的数据，
    /// 后续解析全部静默错位，必须报错而不是 fail-open。
    fn fetch_with(agent: &ureq::Agent, url: &str, start: u64, want: u64) -> io::Result<Vec<u8>> {
        if want == 0 {
            return Ok(Vec::new());
        }
        let end = start.saturating_add(want).saturating_sub(1);
        let response = agent
            .get(url)
            .set("Range", &format!("bytes={start}-{end}"))
            .call()
            .map_err(|error| io::Error::new(io::ErrorKind::Other, error.to_string()))?;
        let status = response.status();
        if status == 200 {
            if start != 0 {
                return Err(io::Error::new(
                    io::ErrorKind::Other,
                    format!(
                        "上游忽略了 Range 请求（bytes={start}-{end}），返回 200 全文件，无法定位偏移 {start}"
                    ),
                ));
            }
        } else if status != 206 {
            return Err(io::Error::new(io::ErrorKind::Other, format!("媒体代理返回 {status}")));
        }
        let mut buffer = Vec::with_capacity(want as usize);
        response
            .into_reader()
            .take(want)
            .read_to_end(&mut buffer)
            .map_err(|error| io::Error::new(io::ErrorKind::Other, error.to_string()))?;
        Ok(buffer)
    }

    fn fetch(&self, start: u64, want: u64) -> io::Result<Vec<u8>> {
        Self::fetch_with(&self.agent, &self.url, start, want)
    }

    /// 找到覆盖 `pos` 的已缓存块，返回块起点和块内偏移。
    fn hit(&self, pos: u64) -> Option<(u64, usize)> {
        let (&start, data) = self.blocks.range(..=pos).next_back()?;
        let offset = usize::try_from(pos - start).ok()?;
        if offset < data.len() {
            Some((start, offset))
        } else {
            None
        }
    }

    /// 把一块写进缓存，并在这里收口 `MAX_CACHE_BYTES` 预算。
    ///
    /// 慢路径 `load()` 是逐条 cue 按需读的，每次垫 32 KiB，两千多条 cue 就能垫到
    /// 数倍于上限；`prefetch()` 里的预算只约束预取那一次，管不到它。所以硬顶必须
    /// 落在唯一的写入口 `insert()` 上，否则 Android 的 LMK 会直接收掉进程。
    fn insert(&mut self, start: u64, bytes: Vec<u8>) {
        if bytes.is_empty() {
            return;
        }
        // 同键覆盖：先把旧块长度从计数里扣掉，否则重复累加会让记账只增不减。
        if let Some(old) = self.blocks.remove(&start) {
            self.cache_bytes = self.cache_bytes.saturating_sub(old.len());
        }
        let len = bytes.len();
        if len > MAX_CACHE_BYTES {
            // 单块本身比整份预算还大（超大 `read`）：留谁都装不下，清空只留这一块。
            // 否则会先把有用的块全删光、最后还是超预算，白折腾。
            self.blocks.clear();
            self.cache_bytes = len;
            self.blocks.insert(start, bytes);
            return;
        }
        // 淘汰离 `pos` 最远的块：`pos` 附近（含覆盖 `pos` 的那块）距离最小，
        // 永远是最后被删的；而本次要写入的新块是在循环之后才入表，不可能被自己挤掉。
        // 这两条合起来保证正在读的位置不会被驱逐出缓存。
        while self.cache_bytes + len > MAX_CACHE_BYTES && !self.blocks.is_empty() {
            // 先取出 key 再 remove：不能在遍历 `keys()` 的同时改表（借用冲突）。
            let Some(farthest) = self.blocks.keys().max_by_key(|key| key.abs_diff(self.pos)).copied() else {
                break;
            };
            if let Some(old) = self.blocks.remove(&farthest) {
                self.cache_bytes = self.cache_bytes.saturating_sub(old.len());
            }
        }
        self.cache_bytes += len;
        self.blocks.insert(start, bytes);
    }

    /// 保证 `pos` 落在已缓存的块里；`block` 是这一次要读的总量，用来决定单次请求的大小。
    ///
    /// 关键点：`block` 大（读头部 2 MiB、读整个 Cues）时一次取够，而不是切成
    /// 32 KiB 一块块来回跑——那是几百次往返。
    fn load(&mut self, block: usize) -> io::Result<()> {
        let want = std::cmp::min(std::cmp::max(block as u64, BLOCK), self.len.saturating_sub(self.pos));
        if want == 0 {
            return Ok(());
        }
        let start = self.pos;
        let bytes = self.fetch(start, want)?;
        self.insert(start, bytes);
        Ok(())
    }
}

impl Read for HttpRangeReader {
    /// 一次 `read` 会尽量填满调用方的缓冲区。
    ///
    /// `Read` 允许返回不足量，但 `mkv_sub` 里读 Cues、读簇头都是一次 `read` 就当作读满
    /// （对本地 `File` 一直成立）。这里补上循环，避免 HTTP 分块返回把解析方骗成
    /// 「Cues 读取不完整」。
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        let mut written = 0;
        while written < out.len() && self.pos < self.len {
            if let Some((start, offset)) = self.hit(self.pos) {
                let data = &self.blocks[&start];
                let available = data.len() - offset;
                let count = std::cmp::min(available, out.len() - written);
                out[written..written + count].copy_from_slice(&data[offset..offset + count]);
                self.pos += count as u64;
                written += count;
                continue;
            }
            // 没命中才算"这次还缺多少"，让大块读一次到位、小块读只补一块。
            let need = out.len() - written;
            self.load(need)?;
            // load 因容量或文件尾没放进任何字节：再循环也是同一个位置，直接退出，
            // 让调用方按"读不满"失败，而不是在这里空转。
            if self.hit(self.pos).is_none() {
                break;
            }
        }
        Ok(written)
    }
}

impl Seek for HttpRangeReader {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        let next = match from {
            SeekFrom::Start(value) => value as i128,
            SeekFrom::End(value) => self.len as i128 + value as i128,
            SeekFrom::Current(value) => self.pos as i128 + value as i128,
        };
        if next < 0 {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "seek 到负位置"));
        }
        self.pos = std::cmp::min(next as u64, self.len);
        Ok(self.pos)
    }
}

impl RandomRead for HttpRangeReader {
    /// 并发取回所有 cue 要读的区间。
    ///
    /// 调用点在 `mkv_sub::sparse_extract_srt_reader` 拿到 Cues、开始逐条解析之前：
    /// 那时全部区间已知且单调递增，最适合一次批量取。每条 cue 会给出两个区间
    /// （簇头 128 字节和埋在簇深处的字幕块 8 KiB）。失败是静默的——没取到的区间
    /// 之后会按需单取，正确性完全不依赖预取是否成功。
    fn prefetch(&mut self, ranges: &[(u64, u64)]) {
        if ranges.is_empty() {
            return;
        }
        // 1. 合并：跳过已缓存的、裁掉越界的、把相邻区间并成一段连续读。
        //    调用方保证 ranges 按起点升序（`mkv_sub` 里排过序）。
        let mut windows: Vec<(u64, u64)> = Vec::with_capacity(ranges.len());
        for &(start, len) in ranges {
            if start >= self.len || len == 0 || self.hit(start).is_some() {
                continue;
            }
            let want = std::cmp::min(len, self.len - start);
            match windows.last_mut() {
                Some(last) if start <= last.0 + last.1 + MERGE => {
                    let end = std::cmp::max(last.0 + last.1, start + want);
                    last.1 = end - last.0;
                }
                _ => windows.push((start, want)),
            }
        }
        if windows.is_empty() {
            return;
        }
        // 2. 容量兜底：超上限就只预取靠前的那些（用户多半从头看，前面字幕先出来）。
        let budget = MAX_CACHE_BYTES.saturating_sub(self.cache_bytes);
        let mut planned = 0usize;
        let mut count = 0usize;
        for &(_, want) in &windows {
            if planned + want as usize > budget {
                break;
            }
            planned += want as usize;
            count += 1;
        }
        if count == 0 {
            return;
        }
        let windows = &windows[..count];

        // 3. 并发取。`std::thread::scope` 借用 `self` 的不可变字段，收集完再一次性
        //    写回 blocks——这样不用给整个 reader 加锁。
        let url = &self.url;
        let agent = &self.agent;
        let cursor = AtomicUsize::new(0);
        let collected: Mutex<Vec<(u64, Vec<u8>)>> = Mutex::new(Vec::with_capacity(windows.len()));
        let threads = std::cmp::min(PREFETCH_THREADS, windows.len());
        std::thread::scope(|scope| {
            for _ in 0..threads {
                scope.spawn(|| loop {
                    let index = cursor.fetch_add(1, Ordering::Relaxed);
                    let Some(&(start, want)) = windows.get(index) else { break };
                    if let Ok(bytes) = Self::fetch_with(agent, url, start, want) {
                        if let Ok(mut sink) = collected.lock() {
                            sink.push((start, bytes));
                        }
                    }
                });
            }
        });
        if let Ok(collected) = collected.into_inner() {
            for (start, bytes) in collected {
                self.insert(start, bytes);
            }
        }
    }
}
