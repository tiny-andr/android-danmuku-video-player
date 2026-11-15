package com.bplayer.probe;

import android.content.Context;
import android.os.Environment;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * 荣耀这台机器的 logcat 是加密的（只有一行 HKS 头），所以所有诊断同时落盘，
 * 用 adb pull 读。优先写公共 Download（已给 MANAGE_EXTERNAL_STORAGE），失败退到应用外部目录。
 */
final class ProbeLog {

    private static final String TAG = "BPLAYER_PROBE";
    private static final Object LOCK = new Object();
    private static File file;

    private ProbeLog() {
    }

    static void init(Context ctx) {
        File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        File f = new File(dir, "bplayer-probe.log");
        synchronized (LOCK) {
            try (FileOutputStream fos = new FileOutputStream(f, false)) {
                file = f;
                String head = "=== Bplayer Android probe " + now() + " ===\n";
                fos.write(head.getBytes(StandardCharsets.UTF_8));
            } catch (IOException e) {
                file = null;
                Log.e(TAG, "public log open failed: " + f, e);
            }
            if (file == null) {
                File ext = ctx.getExternalFilesDir(null);
                if (ext != null) {
                    File g = new File(ext, "bplayer-probe.log");
                    try (FileOutputStream fos = new FileOutputStream(g, false)) {
                        file = g;
                        fos.write(("=== Bplayer Android probe " + now() + " (app dir) ===\n")
                                .getBytes(StandardCharsets.UTF_8));
                    } catch (IOException e) {
                        Log.e(TAG, "app log open failed: " + g, e);
                    }
                }
            }
        }
        i("LOG_FILE " + (file == null ? "none" : file.getAbsolutePath()));
    }

    static void i(String s) {
        Log.i(TAG, s);
        write("I " + s);
    }

    static void w(String s) {
        Log.w(TAG, s);
        write("W " + s);
    }

    static void e(String s) {
        Log.e(TAG, s);
        write("E " + s);
    }

    static void e(String s, Throwable t) {
        Log.e(TAG, s, t);
        write("E " + s + " :: " + t);
    }

    private static void write(String s) {
        synchronized (LOCK) {
            if (file == null) return;
            try (FileOutputStream fos = new FileOutputStream(file, true)) {
                fos.write((now() + " " + s + "\n").getBytes(StandardCharsets.UTF_8));
            } catch (IOException ignored) {
                // 落盘失败不能反过来影响探针
            }
        }
    }

    private static String now() {
        return new SimpleDateFormat("HH:mm:ss.SSS", Locale.US).format(new Date());
    }
}
