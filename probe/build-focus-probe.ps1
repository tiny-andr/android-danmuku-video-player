$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$work = Join-Path $root 'tmp/audio-focus-fixture'
$sdk = $env:ANDROID_HOME
$javaBin = Join-Path $env:JAVA_HOME 'bin'
$tools = Join-Path $sdk 'build-tools/37.0.0'
$platform = Join-Path $sdk 'platforms/android-37.0/android.jar'
$sourceDir = Join-Path $work 'src'
$classes = Join-Path $work 'classes'
$dex = Join-Path $work 'dex'
New-Item -ItemType Directory -Force -Path $sourceDir,$classes,$dex | Out-Null
$source = @'
package com.danmuku.bplayer.focusprobe;
import android.app.Service;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;
public class FocusProbeService extends Service implements AudioManager.OnAudioFocusChangeListener {
  private AudioManager manager;
  private AudioFocusRequest focus;
  private final Handler handler = new Handler(Looper.getMainLooper());
  private void release() {
    if (focus != null) manager.abandonAudioFocusRequest(focus);
    focus = null;
  }
  @Override public void onCreate() {
    super.onCreate(); manager = (AudioManager)getSystemService(AUDIO_SERVICE);
    NotificationManager notifications = (NotificationManager)getSystemService(NOTIFICATION_SERVICE);
    NotificationChannel channel = new NotificationChannel("focus-test", "Focus test", NotificationManager.IMPORTANCE_LOW);
    channel.setSound(null, null); notifications.createNotificationChannel(channel);
    startForeground(1, new Notification.Builder(this, "focus-test").setSmallIcon(android.R.drawable.ic_media_play).setContentTitle("Temporary audio focus test").setOngoing(true).build());
  }
  @Override public IBinder onBind(Intent intent) { return null; }
  @Override public int onStartCommand(Intent intent, int flags, int id) {
    String kind = intent == null ? "release" : intent.getStringExtra("kind");
    handler.removeCallbacksAndMessages(null); release();
    if ("release".equals(kind)) { stopSelf(); return START_NOT_STICKY; }
    int gain = "transient".equals(kind) ? AudioManager.AUDIOFOCUS_GAIN_TRANSIENT : "duck".equals(kind) ? AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK : AudioManager.AUDIOFOCUS_GAIN;
    focus = new AudioFocusRequest.Builder(gain).setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MOVIE).build()).setOnAudioFocusChangeListener(this).build();
    int result = manager.requestAudioFocus(focus);
    Log.i("BplayerFocusProbe", "focus=" + kind + " result=" + result);
    handler.postDelayed(() -> { release(); stopSelf(); }, 15000);
    return START_NOT_STICKY;
  }
  @Override public void onAudioFocusChange(int change) { Log.i("BplayerFocusProbe", "change=" + change); }
  @Override public void onDestroy() { handler.removeCallbacksAndMessages(null); release(); super.onDestroy(); }
}
'@
$manifest = @'
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.danmuku.bplayer.focusprobe">
  <uses-sdk android:minSdkVersion="26" android:targetSdkVersion="33" />
  <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
  <uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" />
  <application android:label="Bplayer focus test" android:allowBackup="false">
    <service android:name=".FocusProbeService" android:exported="true" android:foregroundServiceType="mediaPlayback" />
  </application>
</manifest>
'@
$sourcePath = Join-Path $sourceDir 'FocusProbeService.java'
$manifestPath = Join-Path $work 'AndroidManifest.xml'
Set-Content -LiteralPath $sourcePath -Value $source -Encoding utf8
Set-Content -LiteralPath $manifestPath -Value $manifest -Encoding utf8
& (Join-Path $javaBin 'javac.exe') -source 8 -target 8 -classpath $platform -d $classes $sourcePath
if ($LASTEXITCODE -ne 0) { throw 'Fixture Java compilation failed' }
$jar = Join-Path $work 'classes.jar'
& (Join-Path $javaBin 'jar.exe') cf $jar -C $classes .
if ($LASTEXITCODE -ne 0) { throw 'Fixture jar failed' }
& (Join-Path $tools 'd8.bat') --lib $platform --min-api 26 --output $dex $jar
if ($LASTEXITCODE -ne 0) { throw 'Fixture dex failed' }
$unsigned = Join-Path $work 'unsigned.apk'
& (Join-Path $tools 'aapt2.exe') link -I $platform --manifest $manifestPath -o $unsigned
if ($LASTEXITCODE -ne 0) { throw 'Fixture resources failed' }
& (Join-Path $javaBin 'jar.exe') uf $unsigned -C $dex classes.dex
if ($LASTEXITCODE -ne 0) { throw 'Fixture package failed' }
$aligned = Join-Path $work 'aligned.apk'
& (Join-Path $tools 'zipalign.exe') -f 4 $unsigned $aligned
if ($LASTEXITCODE -ne 0) { throw 'Fixture alignment failed' }
$apk = Join-Path $work 'focus-probe.apk'
$key = Join-Path $root 'bplayer-android/src-tauri/gen/android/.android-network/debug.keystore'
& (Join-Path $tools 'apksigner.bat') sign --ks $key --ks-pass pass:android --out $apk $aligned
if ($LASTEXITCODE -ne 0) { throw 'Fixture signing failed' }
Get-Item -LiteralPath $apk | Select-Object FullName,Length
