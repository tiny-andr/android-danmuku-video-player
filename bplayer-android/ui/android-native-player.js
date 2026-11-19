/*!
 * android-native-player.js — libmpv 播放层与 Artplayer 的接线。
 *
 * 解码和渲染都在原生（libmpv → SurfaceView，位于 WebView 之下），本文件只做三件事：
 *   1. 给 Artplayer 一个「假 video」：时间轴从 AndroidMpv 桥读，媒体事件自己发；
 *   2. 把打开/播放/暂停/跳转/倍速/音量转发回原生；
 *   3. 让弹幕、进度条、控制条按原来的逻辑工作 —— 弹幕插件一行都不用改。
 *
 * 时间轴走 push 模式：每 250ms 把 mpv 的状态推给垫片，垫片在两次推送之间按倍速外推，
 * 并在 seek 期间丢弃陈旧帧。rAF 每帧同步跨语言拉取也能用，但没有必要。
 */
(function (root) {
  'use strict';

  var bridge = root.AndroidMpv;
  var timeline = root.AndroidNativeTimeline;
  if (!bridge || !timeline) return;

  var shim = null;
  var timer = null;
  var lastPush = { time: -1, duration: -1, paused: null, eof: false };
  // 上一次已知的画面宽度，用来判断「尺寸刚刚变得可用」这一次跃变
  var lastWidth = 0;

  function makeProvider() {
    return {
      time: function () { return bridge.timePos(); },
      duration: function () { return bridge.duration(); },
      paused: function () { return bridge.paused(); },
      seek: function (t) { bridge.seekTo(t); },
      play: function () { bridge.play(); },
      pause: function () { bridge.pause(); },
      rate: function (v) {
        if (arguments.length) { bridge.setRate(v); return v; }
        return bridge.rate();
      },
      volume: function (v) {
        if (arguments.length) { bridge.setVolume(v * 100); return v; }
        return bridge.volume() / 100;
      },
      width: function () { return bridge.videoWidth(); },
      height: function () { return bridge.videoHeight(); }
    };
  }

  function ensure() {
    if (shim) return shim;
    shim = timeline.create({
      provider: makeProvider(),
      log: root.__bplayerVerbose ? function (m) { console.log(m); } : null
    });
    timer = setInterval(pushState, 250);
    return shim;
  }

  function pushState() {
    if (!shim) return;
    var duration = bridge.duration();
    var time = bridge.timePos();
    var paused = bridge.paused();
    var eof = bridge.eof();
    var moved = Math.abs(time - lastPush.time) > 0.25;
    // 暂停且时间没动、时长也没变时不必重复推送：垫片已经冻结在暂停点上。
    if (paused && !eof && !moved && duration === lastPush.duration) return;
    lastPush.time = time;
    lastPush.duration = duration;
    lastPush.paused = paused;
    lastPush.eof = eof;
    var width = bridge.videoWidth();
    var height = bridge.videoHeight();
    shim.push({
      time: time,
      duration: duration,
      paused: paused,
      ended: eof,
      rate: bridge.rate(),
      width: width,
      height: height,
      bufferedEnd: duration
    });
    // 垫片的 canplay 只在 duration 出现的那一帧发过一次，而那一刻 width 常常还是 0
    // （mpv 的 width 要等 VO 配置完）。「进入播放页」的判据要求 videoWidth 非零，
    // 不补这一发就再也没有第二次机会 —— 表现就是声音已经在放、画面一直挂着「正在缓冲视频…」。
    if (width > 0 && lastWidth === 0) {
      lastWidth = width;
      shim.emit('loadedmetadata');
      shim.emit('canplay');
    }
    // 垫片在暂停态不发 timeupdate（弹幕循环要停），但进度条和时间显示只认这个事件：
    // 暂停中拖动进度条、或刚暂停时，得手动补一发，否则 UI 停在旧秒数上。
    if (paused && moved) shim.emitTimeupdate();
    // 画面尺寸/窗口方向都可能变，字幕位置每次推送时校准一次（内部有阈值去重）
    syncSubtitlePlacement();
  }

  /**
   * 把垫片接到一个已经构造好的 Artplayer 上。必须在 art.url 赋值之前调用，
   * 否则 art 已经往真 <video> 写过一次 src。
   */
  function attach() {
    ensure();
    shim.provider = makeProvider();
    root.__mpvFileLoaded = function () {
      pushState();
      shim.sync();
      // 让 art 重新按真实画面尺寸算矩形（方向、适应/裁剪都吃这个）
      shim.notifyResize();
      // track-list 到这一刻才完整（sub-auto=fuzzy 拉进来的外挂轨也在此刻出现），
      // 前端要靠这次回调重建字幕菜单并重跑自动挂载。
      if (root.__bplayerMpvFileLoaded) { try { root.__bplayerMpvFileLoaded(); } catch (error) { } }
    };
    root.__mpvEndFile = function (reason) {
      // mpv END_FILE: EOF=0, STOP=2, QUIT=3, ERROR=4
      if (reason === 0) {
        bridge.pause();
        shim.emit('ended');
      }
      pushState();
    };
    return shim;
  }

  // 上一次设过的字幕位置百分比，避免每个 tick 都写一遍 property
  var lastSubPos = -1;
  // 上一次设过的字幕缩放系数，同上
  var lastSubScale = -1;

  /**
   * 把字幕钉在「视频画面」的底边，而不是窗口底边。
   *
   * mpv 的 `sub-pos` 是相对**窗口高度**的百分比，竖屏 letterbox 时画面只占中间一条，
   * 用 100 会把字幕塞进下方黑边。这里复刻老版 `AndroidSubtitleView.placement()` 的
   * contain 计算：画面按 min(窗口宽/视频宽, 窗口高/视频高) 缩放后居中，字幕底边取
   * 画面底边再上移 12px。
   */
  function syncSubtitlePlacement() {
    // 不再动态写 sub-pos：mpv 的 sub-pos 百分比基准是「视频画面」而不是窗口，
    // 100 就已经是画面底边。之前按窗口高度折算出 62（竖屏 letterbox），
    // 结果字幕被摆到画面中间 —— 这个换算本来就是错的。
    // 位置保持 mpv 默认（sub-pos=100，画面底部）。
  }

  /**
   * 软横屏：不改设备方向，把视频画面和弹幕层一起转 90°。
   *
   * Android 16/17 在 sw>=600dp 的屏幕上会直接丢弃 setRequestedOrientation，
   * 平板上的「横屏」只能这么做。只转画面层+弹幕层，控制条和顶栏保持竖持布局，
   * 所以不需要做触摸坐标映射（Chromium 自己处理 CSS transform 的命中测试）。
   */
  function setSoftLandscape(on) {
    var doc = root.document;
    var layer = doc.querySelector('.art-danmuku');
    if (on) {
      doc.body.classList.add('soft-rotate');
      if (layer) {
        layer.style.transform = 'rotate(90deg)';
        layer.style.transformOrigin = 'center center';
      }
      bridge.setVideoRotation(90);
    } else {
      doc.body.classList.remove('soft-rotate');
      if (layer) layer.style.transform = '';
      bridge.setVideoRotation(0);
    }
  }
  root.__softLandscape = setSoftLandscape;

  /** path 必须是 mpv 能直接打开的东西：绝对路径，或本机 Range 代理的 http URL。 */
  function open(path, startAt) {
    ensure();
    lastPush = { time: -1, duration: -1, paused: null, eof: false };
    lastWidth = 0;
    var ok = bridge.open(path, typeof startAt === 'number' ? startAt : -1);
    if (ok) {
      // Clear pause *before* mpv finishes loading: a pause that lands after loadfile but before
      // the file is ready leaves playback parked at 0 and the UI's 30 s load watchdog fires.
      bridge.play();
      shim.sync();
    }
    return ok;
  }

  function close() {
    bridge.stop();
    lastPush = { time: -1, duration: -1, paused: null, eof: false };
    lastWidth = 0;
    if (shim) shim.emit('pause');
  }

  // 播放页要让位给底下的 SurfaceView：页面背景转透明（CSS 见 index.html 的 body.aplaying），
  // 同时让原生把 mpv 层显示出来；离开播放再还原，免得最后一帧挂在首页下面。
  var wasActive = null;
  setInterval(function () {
    if (!root.document || !root.document.body) return;
    var active = !!(root.AndroidPlayback && root.AndroidPlayback.active);
    if (active === wasActive) return;
    wasActive = active;
    root.document.body.classList.toggle('aplaying', active);
    try {
      if (root.AndroidUI && root.AndroidUI.setVideoVisible) root.AndroidUI.setVideoVisible(active);
    } catch (e) { /* 桥还没注入 */ }
  }, 300);

  // 音轨面板的说明文字还是按「选中→转码→落盘 mka」写的；libmpv 下这套流程不存在了，
  // 不换掉的话用户会一直等一个不会出现的进度。
  var audioFoot = root.document && root.document.getElementById('audioFootNote');
  if (audioFoot) {
    audioFoot.textContent = '点击音轨即可切换，视频和弹幕保持不变。libmpv 直接解码每条音轨，' +
      '不转码、不生成缓存文件，切换立即生效。';
  }

  root.AndroidNativePlayer = {    /** 传给 Artplayer 的 option.proxy：让 art 用假 video 当渲染目标 */
    proxy: function () {
      return function () { return ensure().video; };
    },
    attach: attach,
    open: open,
    close: close,
    provider: makeProvider,
    sync: function () { pushState(); },
    seek: function (t) { return shim ? shim.seek(t) : 0; },
    state: function () { return shim ? shim.state : null; },
    stats: function () { return shim ? shim.stats : null; },
    /** 原生侧能力查询，供 UI 决定要不要显示入口 */
    tracks: function () {
      try { return JSON.parse(bridge.tracks() || '[]'); } catch (e) { return []; }
    },
    videoWidth: function () { return bridge.videoWidth(); },
    videoHeight: function () { return bridge.videoHeight(); },
    hwdec: function () { return bridge.hwdec(); }
  };
})(window);
