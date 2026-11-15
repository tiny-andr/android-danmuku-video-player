package com.bplayer.probe;

import android.content.Context;
import android.util.Log;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.io.UnsupportedEncodingException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 两个回环 HTTP 服务，模拟 Tauri 的页面源 + asset 源跨源关系。
 * 8765 只给页面/XML，8766 只给视频，这样 WebAudio/CORS 的坑能提前暴露。
 */
final class ProbeServer extends Thread {

    private static final String TAG = "BPLAYER_PROBE";
    private static final int MAX_RANGE = 16 * 1024 * 1024; // 先放大到 16MB，验证 1MB 上限是不是大 MKV seek 的瓶颈

    private final Context ctx;
    private final int port;
    private final AtomicInteger reqs = new AtomicInteger();
    private final CountDownLatch ready = new CountDownLatch(1);
    private volatile boolean running = true;
    private ServerSocket server;

    ProbeServer(Context ctx, int port) {
        this.ctx = ctx;
        this.port = port;
        setName("probe-http-" + port);
        setDaemon(true);
    }

    boolean awaitReady() {
        try {
            return ready.await(3, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            return false;
        }
    }

    @Override
    public void run() {
        try {
            server = new ServerSocket();
            server.setReuseAddress(true);
            server.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), port), 64);
            ready.countDown();
            ProbeLog.i("SERVER listening 127.0.0.1:" + port);
            while (running) {
                Socket s = server.accept();
                Thread t = new Thread(() -> handle(s), "probe-conn-" + port);
                t.setDaemon(true);
                t.start();
            }
        } catch (IOException e) {
            if (running) ProbeLog.e("SERVER error port=" + port + " " + e);
        } finally {
            ready.countDown();
            closeQuietly(server);
        }
    }

    void stopServer() {
        running = false;
        closeQuietly(server);
    }

    private void handle(Socket socket) {
        try (Socket s = socket) {
            s.setSoTimeout(30_000);
            InputStream in = new BufferedInputStream(s.getInputStream());
            OutputStream out = new BufferedOutputStream(s.getOutputStream());
            String head = readHead(in);
            if (head == null) return;
            String[] lines = head.split("\r\n");
            if (lines.length == 0) return;
            String[] first = lines[0].split(" ");
            if (first.length < 3) return;
            String method = first[0].toUpperCase(Locale.ROOT);
            String target = first[1];
            Map<String, String> headers = new HashMap<>();
            for (int i = 1; i < lines.length; i++) {
                int p = lines[i].indexOf(':');
                if (p > 0) {
                    headers.put(lines[i].substring(0, p).trim().toLowerCase(Locale.ROOT),
                            lines[i].substring(p + 1).trim());
                }
            }
            String origin = headers.getOrDefault("origin", "*");
            String range = headers.get("range");

            URI uri;
            try {
                uri = URI.create(target);
            } catch (IllegalArgumentException e) {
                sendText(out, 400, "Bad Request", origin, "bad uri", false);
                return;
            }
            String path = uri.getPath();
            if (path == null || path.isEmpty()) path = "/";
            Map<String, String> query = parseQuery(uri.getRawQuery());
            int id = reqs.incrementAndGet();

            if ("OPTIONS".equals(method)) {
                sendEmpty(out, 204, "No Content", origin);
                return;
            }
            boolean headOnly = "HEAD".equals(method);

            if ("/".equals(path) || "/probe.html".equals(path)) {
                byte[] body = readAsset("probe.html");
                sendBytes(out, 200, "OK", origin, "text/html; charset=utf-8", body, headOnly);
                ProbeLog.i("PAGE id=" + id + " bytes=" + body.length);
            } else if ("/asset".equals(path)) {
                serveAsset(out, query.get("path"), range, origin, headOnly, id);
            } else if ("/file".equals(path)) {
                serveWhole(out, query.get("path"), origin, headOnly, id);
            } else {
                sendText(out, 404, "Not Found", origin, "not found", headOnly);
            }
            out.flush();
        } catch (Exception e) {
            ProbeLog.w("CONN error: " + e);
        }
    }

    /** 读到空行为止（请求体不读，探针只有 GET/OPTIONS）。 */
    private String readHead(InputStream in) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream(4096);
        int last4 = 0;
        int b;
        while ((b = in.read()) != -1) {
            bos.write(b);
            last4 = (last4 << 8) | (b & 0xFF);
            if (last4 == 0x0D0A0D0A) break;
            if (bos.size() > 32768) break;
        }
        return bos.size() == 0 ? null : bos.toString("ISO-8859-1");
    }

    private void serveAsset(OutputStream out, String path, String range, String origin,
                            boolean headOnly, int id) throws IOException {
        if (path == null || path.isEmpty()) {
            sendText(out, 400, "Bad Request", origin, "missing path", headOnly);
            return;
        }
        File f = new File(path);
        if (!f.isFile()) {
            ProbeLog.w("ASSET missing " + path);
            sendText(out, 404, "Not Found", origin, "missing file", headOnly);
            return;
        }
        if (!f.canRead()) {
            ProbeLog.w("ASSET denied " + path);
            sendText(out, 403, "Forbidden", origin, "file not readable", headOnly);
            return;
        }
        long total = f.length();
        if (total == 0) {
            sendBytes(out, 200, "OK", origin, mime(path), new byte[0], headOnly);
            return;
        }

        long start = 0;
        long end = total - 1;
        boolean partial = false;
        if (range != null && range.startsWith("bytes=")) {
            String spec = range.substring(6).trim();
            int dash = spec.indexOf('-');
            if (dash < 0) {
                sendRange416(out, origin, total, headOnly);
                return;
            }
            try {
                if (dash == 0) {
                    long suffix = Long.parseLong(spec.substring(1).trim());
                    start = Math.max(0, total - suffix);
                } else {
                    start = Long.parseLong(spec.substring(0, dash).trim());
                    String es = spec.substring(dash + 1).trim();
                    if (!es.isEmpty()) end = Long.parseLong(es);
                }
            } catch (NumberFormatException e) {
                sendRange416(out, origin, total, headOnly);
                return;
            }
            if (start < 0) start = 0;
            if (start >= total) {
                sendRange416(out, origin, total, headOnly);
                return;
            }
            if (end >= total) end = total - 1;
            if (end < start) end = start;
            partial = true;
        } else {
            // Chromium 的 <video> 一定带 Range；万一没有，也别把 6.5GB 一次性写出去
            partial = true;
            end = Math.min(total - 1, (long) MAX_RANGE - 1);
            ProbeLog.i("ASSET no-range-capped id=" + id + " total=" + total);
        }

        if (end - start + 1 > MAX_RANGE) end = start + MAX_RANGE - 1;
        long len = end - start + 1;
        writeHeaders(out, partial ? 206 : 200, partial ? "Partial Content" : "OK",
                origin, mime(path), len, total, start, end, partial, headOnly);
        ProbeLog.i("ASSET id=" + id + " " + start + "-" + end + "/" + total
                + " len=" + len + " range=" + range);
        if (!headOnly) {
            try (RandomAccessFile raf = new RandomAccessFile(f, "r")) {
                raf.seek(start);
                byte[] buf = new byte[64 * 1024];
                long left = len;
                while (left > 0) {
                    int n = raf.read(buf, 0, (int) Math.min(buf.length, left));
                    if (n < 0) break;
                    out.write(buf, 0, n);
                    left -= n;
                }
            }
        }
        out.flush();
    }

    private void serveWhole(OutputStream out, String path, String origin,
                            boolean headOnly, int id) throws IOException {
        if (path == null || path.isEmpty()) {
            sendText(out, 400, "Bad Request", origin, "missing path", headOnly);
            return;
        }
        File f = new File(path);
        if (!f.isFile() || !f.canRead()) {
            ProbeLog.w("FILE missing/denied " + path);
            sendText(out, 404, "Not Found", origin, "missing file", headOnly);
            return;
        }
        if (f.length() > 32L * 1024 * 1024) {
            sendText(out, 413, "Payload Too Large", origin, "file too large", headOnly);
            return;
        }
        byte[] body = readAll(f);
        sendBytes(out, 200, "OK", origin, mime(path), body, headOnly);
        ProbeLog.i("FILE id=" + id + " bytes=" + body.length + " " + path);
    }

    private void sendRange416(OutputStream out, String origin, long total, boolean headOnly) throws IOException {
        String h = "HTTP/1.1 416 Range Not Satisfiable\r\n"
                + "Content-Range: bytes */" + total + "\r\n"
                + "Content-Length: 0\r\n"
                + "Access-Control-Allow-Origin: " + origin + "\r\n"
                + "Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges\r\n"
                + "Connection: close\r\n\r\n";
        out.write(h.getBytes(StandardCharsets.US_ASCII));
        out.flush();
    }

    private void sendEmpty(OutputStream out, int code, String reason, String origin) throws IOException {
        writeHeaders(out, code, reason, origin, "text/plain", 0, 0, 0, 0, false, true);
        out.flush();
    }

    private void sendText(OutputStream out, int code, String reason, String origin,
                          String text, boolean headOnly) throws IOException {
        byte[] body = text.getBytes(StandardCharsets.UTF_8);
        sendBytes(out, code, reason, origin, "text/plain; charset=utf-8", body, headOnly);
    }

    private void sendBytes(OutputStream out, int code, String reason, String origin,
                           String type, byte[] body, boolean headOnly) throws IOException {
        writeHeaders(out, code, reason, origin, type, body.length, body.length, 0,
                Math.max(0, body.length - 1), false, headOnly);
        if (!headOnly) out.write(body);
        out.flush();
    }

    private void writeHeaders(OutputStream out, int code, String reason, String origin,
                              String type, long len, long total, long start, long end,
                              boolean partial, boolean headOnly) throws IOException {
        StringBuilder h = new StringBuilder(384);
        h.append("HTTP/1.1 ").append(code).append(' ').append(reason).append("\r\n");
        h.append("Content-Type: ").append(type).append("\r\n");
        h.append("Content-Length: ").append(len).append("\r\n");
        h.append("Accept-Ranges: bytes\r\n");
        if (partial) {
            h.append("Content-Range: bytes ").append(start).append('-').append(end)
                    .append('/').append(total).append("\r\n");
        }
        h.append("Access-Control-Allow-Origin: ").append(origin).append("\r\n");
        h.append("Vary: Origin\r\n");
        h.append("Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n");
        h.append("Access-Control-Allow-Headers: Range, Content-Type\r\n");
        h.append("Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges\r\n");
        h.append("Cross-Origin-Resource-Policy: cross-origin\r\n");
        h.append("Cache-Control: no-store\r\n");
        h.append("Connection: close\r\n\r\n");
        out.write(h.toString().getBytes(StandardCharsets.US_ASCII));
    }

    private byte[] readAsset(String name) throws IOException {
        try (InputStream is = ctx.getAssets().open(name)) {
            return readAll(is);
        }
    }

    private static byte[] readAll(File f) throws IOException {
        try (InputStream is = new FileInputStream(f)) {
            return readAll(is);
        }
    }

    private static byte[] readAll(InputStream is) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream(8192);
        byte[] buf = new byte[8192];
        int n;
        while ((n = is.read(buf)) != -1) bos.write(buf, 0, n);
        return bos.toByteArray();
    }

    private static Map<String, String> parseQuery(String raw) {
        Map<String, String> q = new HashMap<>();
        if (raw == null || raw.isEmpty()) return q;
        for (String kv : raw.split("&")) {
            int p = kv.indexOf('=');
            if (p < 0) continue;
            q.put(decode(kv.substring(0, p)), decode(kv.substring(p + 1)));
        }
        return q;
    }

    private static String decode(String s) {
        try {
            return URLDecoder.decode(s, "UTF-8");
        } catch (UnsupportedEncodingException e) {
            return s;
        }
    }

    private static String mime(String path) {
        String p = path.toLowerCase(Locale.ROOT);
        if (p.endsWith(".mp4") || p.endsWith(".m4v")) return "video/mp4";
        if (p.endsWith(".m4a")) return "audio/mp4";
        if (p.endsWith(".mkv")) return "video/x-matroska";
        if (p.endsWith(".mka")) return "audio/x-matroska";
        if (p.endsWith(".webm")) return "video/webm";
        if (p.endsWith(".xml")) return "application/xml";
        if (p.endsWith(".srt")) return "text/plain; charset=utf-8";
        if (p.endsWith(".ass")) return "text/plain; charset=utf-8";
        if (p.endsWith(".vtt")) return "text/vtt; charset=utf-8";
        return "application/octet-stream";
    }

    private static void closeQuietly(Closeable c) {
        if (c != null) {
            try {
                c.close();
            } catch (IOException ignored) {
            }
        }
    }
}
