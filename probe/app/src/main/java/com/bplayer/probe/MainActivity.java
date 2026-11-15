package com.bplayer.probe;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.PowerManager;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

import java.io.File;

/**
 * 最小探针：不碰 Bplayer 代码，只验证 Android WebView 能不能承担播放器内核。
 * 页面与视频分两个回环端口，刻意制造跨源，模拟 Tauri 的 tauri.localhost / asset.localhost。
 */
public class MainActivity extends Activity {

    private static final String TAG = "BPLAYER_PROBE";

    private static final String VIDEO =
            "/sdcard/Download/异形 契约.Alien.Covenant.2017.BD1080P.X264.AAC.English.CHS-ENG.Mp4Ba.mp4";
    private static final String XML =
            "/sdcard/Download/异形 契约.Alien.Covenant.2017.BD1080P.X264.AAC.English.CHS-ENG.Mp4Ba.xml";
    private static final String MKV =
            "/sdcard/Download/Pan's.Labyrinth.2006.UHD.BluRay.2160p.10bit.HDR.2Audio.DTS-HD.MA.5.1.x265-beAst.mkv";

    private WebView web;
    private TextView hud;
    private ProbeServer pageServer;
    private ProbeServer mediaServer;
    private PowerManager.WakeLock wake;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        ProbeLog.init(this);

        ProbeLog.i("=== PROBE START ===");
        ProbeLog.i("sdk=" + Build.VERSION.SDK_INT + " device=" + Build.MANUFACTURER + " " + Build.MODEL);
        ProbeLog.i("videoExists=" + new File(VIDEO).isFile() + " size=" + new File(VIDEO).length());
        ProbeLog.i("xmlExists=" + new File(XML).isFile() + " size=" + new File(XML).length());
        ProbeLog.i("allFiles=" + Environment.isExternalStorageManager());
        DisplayMetrics dm = getResources().getDisplayMetrics();
        ProbeLog.i("METRICS " + dm.widthPixels + "x" + dm.heightPixels + " dpi=" + dm.densityDpi);
        ProbeLog.i("CONFIG " + getResources().getConfiguration());

        requestMediaPermission();

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFF000000);

        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        hud = new TextView(this);
        hud.setText("probe booting...");
        hud.setTextColor(0xFF00FF00);
        hud.setTextSize(11f);
        hud.setPadding(10, 6, 10, 6);
        hud.setBackgroundColor(0x99000000);
        FrameLayout.LayoutParams hp = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT);
        hp.gravity = Gravity.TOP;
        root.addView(hud, hp);

        setContentView(root);
        setupWindow(); // 必须在 setContentView 之后：此机 API 37 上 DecorView 未建好时 getInsetsController 会 NPE

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false); // 对齐 Wry Android 默认 autoplay=true
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        WebView.setWebContentsDebuggingEnabled(true);

        web.addJavascriptInterface(new Bridge(), "Probe");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                ProbeLog.i("NAV " + url);
                return false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                ProbeLog.i("PAGE_FINISHED " + url);
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                ProbeLog.i("CONSOLE " + m.message());
                return true;
            }

            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                // Wry Android 的 RustWebChromeClient 就是这么做的：立刻回调隐藏，等于全屏不可用。
                ProbeLog.w("FULLSCREEN onShowCustomView -> cancel (Wry behavior)");
                try {
                    callback.onCustomViewHidden();
                } catch (Throwable t) {
                    ProbeLog.w("FULLSCREEN cancel failed: " + t);
                }
            }

            @Override
            public void onHideCustomView() {
                ProbeLog.i("FULLSCREEN onHideCustomView");
            }
        });

        pageServer = new ProbeServer(this, 8765);
        pageServer.start();
        mediaServer = new ProbeServer(this, 8766);
        mediaServer.start();
        boolean ok1 = pageServer.awaitReady();
        boolean ok2 = mediaServer.awaitReady();
        ProbeLog.i("SERVERS ready page=" + ok1 + " media=" + ok2);

        web.loadUrl("http://127.0.0.1:8765/");
    }

    private void setupWindow() {
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setStatusBarColor(0xFF000000);
        getWindow().setNavigationBarColor(0xFF000000);
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = getWindow().getDecorView().getWindowInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        }
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        wake = pm.newWakeLock(PowerManager.SCREEN_DIM_WAKE_LOCK, "BplayerProbe:probe");
        wake.acquire(30 * 60 * 1000L);
    }

    private void requestMediaPermission() {
        String perm = Build.VERSION.SDK_INT >= 33
                ? Manifest.permission.READ_MEDIA_VIDEO
                : Manifest.permission.READ_EXTERNAL_STORAGE;
        if (checkSelfPermission(perm) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{perm}, 1);
        } else {
            ProbeLog.i("PERM already granted " + perm);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        for (int i = 0; i < permissions.length; i++) {
            ProbeLog.i("PERM " + permissions[i] + "="
                    + (grantResults.length > i && grantResults[i] == PackageManager.PERMISSION_GRANTED));
        }
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        ProbeLog.i("CONFIG_CHANGED orientation=" + newConfig.orientation
                + " " + newConfig.screenWidthDp + "x" + newConfig.screenHeightDp
                + " smallest=" + newConfig.smallestScreenWidthDp);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        ProbeLog.i("WINDOW_FOCUS " + hasFocus);
    }

    @Override
    protected void onResume() {
        super.onResume();
        ProbeLog.i("LIFECYCLE resume allFiles=" + Environment.isExternalStorageManager());
    }

    @Override
    protected void onPause() {
        ProbeLog.i("LIFECYCLE pause");
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        ProbeLog.i("LIFECYCLE destroy");
        if (pageServer != null) pageServer.stopServer();
        if (mediaServer != null) mediaServer.stopServer();
        if (wake != null && wake.isHeld()) wake.release();
        if (web != null) {
            web.loadUrl("about:blank");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    private final class Bridge {
        @JavascriptInterface
        public String videoPath() {
            return VIDEO;
        }

        @JavascriptInterface
        public String xmlPath() {
            return XML;
        }

        @JavascriptInterface
        public String mkvPath() {
            return MKV;
        }

        @JavascriptInterface
        public boolean allFiles() {
            return Environment.isExternalStorageManager();
        }

        @JavascriptInterface
        public void log(String line) {
            ProbeLog.i("JS " + line);
        }

        @JavascriptInterface
        public void hud(String text) {
            runOnUiThread(() -> {
                if (hud != null) hud.setText(text);
            });
        }
    }
}
