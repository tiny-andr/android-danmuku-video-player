// 按 HTTP Range 随机读的实现，给 `mkv_sub::sparse_extract_srt_reader` 当本地文件用。
//
// 为什么需要它：MKV 字幕的稀疏抽取靠 Cues 索引，一条字幕一次小读（簇头 96 字节 +
// 块几 KB），一条 2 小时的片子约两千次读。桌面版这些读直接落在 SMB 挂载路径上，
// 几千次也就几秒；Android 没有可挂载的 SMB，播放层只能经本机 NanoHTTPD 代理用
// `Range: bytes=a-b` 取字节，如果不做块缓存，就会退化成"每次几 KB 一个 HTTP 请求"。
//
// 这里一次取 256 KiB 缓存起来：Cues 给出的簇位置随时间单调递增，相邻字幕常常落在
// 同一块里，命中率足够高，同时又把"一次跳转一次请求"压到可以接受的量级。

use std::io::{self, Read, Seek, SeekFrom};
use std::time::Duration;

// 单次 HTTP Range 请求的字节数。
//
// 稀疏抽取的读模式是"簇头 96 字节 + 字幕块几 KB"，两者通常挨着，32 KiB 正好一次覆盖；
// 调大只会让每个 cue 多拉无用的字节（Cues 给出的簇位置彼此相距几 MB，缓存很难命中）。
const BLOCK: u64 = 32 * 1024;

pub struct HttpRangeReader {
    url: String,
    len: u64,
    pos: u64,
    block_start: u64,
    block: Vec<u8>,
}

impl HttpRangeReader {
    pub fn new(url: String, len: u64) -> Self {
        let mut reader = Self { url, len, pos: 0, block_start: 0, block: Vec::new() };
        // 已存在但空的块要显式标记成"没缓存"，免得 pos=0 被误判为命中
        reader.block_start = u64::MAX;
        reader
    }

    fn fetch(&self, start: u64, want: u64) -> io::Result<Vec<u8>> {
        if want == 0 {
            return Ok(Vec::new());
        }
        let end = start + want - 1;
        let response = ureq::get(&self.url)
            .set("Range", &format!("bytes={start}-{end}"))
            .timeout(Duration::from_secs(60))
            .call()
            .map_err(|error| io::Error::new(io::ErrorKind::Other, error.to_string()))?;
        let status = response.status();
        if status != 206 && status != 200 {
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

    /// 保证 `pos` 落在已缓存的块里。
    fn ensure(&mut self) -> io::Result<()> {
        if self.pos >= self.block_start && (self.pos - self.block_start) < self.block.len() as u64 {
            return Ok(());
        }
        let want = std::cmp::min(BLOCK, self.len.saturating_sub(self.pos));
        if want == 0 {
            self.block_start = self.pos;
            self.block.clear();
            return Ok(());
        }
        let start = self.pos;
        let bytes = self.fetch(start, want)?;
        self.block_start = start;
        self.block = bytes;
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
            self.ensure()?;
            let offset = (self.pos - self.block_start) as usize;
            if offset >= self.block.len() {
                break;
            }
            let available = self.block.len() - offset;
            let count = std::cmp::min(available, out.len() - written);
            out[written..written + count].copy_from_slice(&self.block[offset..offset + count]);
            self.pos += count as u64;
            written += count;
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
