/*!
 * android-native-timeline.js — 假视频时间轴垫片（shim spike）
 *
 * 背景：libmpv 解码 + SurfaceView 渲染之后，WebView 里的 <video> 不再解码任何东西，
 * 但 Artplayer 5.3.0 与 artplayer-plugin-danmuku 5.2.0 全都靠 $video.currentTime /
 * $video.duration / media 事件工作。本文件用一个「不加载任何媒体」的 <video> 元素
 * 承载 DOM 与事件能力，把所有时间轴属性的读写转发给注入的原生 provider。
 *
 * 依赖的 artplayer 内部实现位置（绝对字符偏移，bplayer-android/ui/vendor/artplayer.js）：
 *   currentTimeMix   k4e77 @111082   读 $video.currentTime；写 $video.currentTime（setter 里 clamp 到 art.duration）
 *   durationMix      aK1ks @111501   读 $video.duration（Infinity→0、NaN→0）
 *   playingMix       2Ndus @123838   先读 $video.playing（非标准布尔）；否则 currentTime>0 && !paused && !ended && readyState>2
 *   playedMix        cK23B @123530   art.played = art.currentTime / art.duration（不是 $video.played！）
 *   playbackRateMix  7hqKi @123059   读/写 $video.playbackRate
 *   volumeMix        4DF3Z @132800   读/写 $video.volume、$video.muted
 *   loadedMix        gzJMP @118087   art.loadedTime = $video.buffered.end(buffered.length-1)；art.loaded = loadedTime/$video.duration
 *   eventInit        eodDF @111842   对 config.events（22 个）逐个 addEventListener，重发 video:<type>
 *   playMix 6o5f2 @124242 / pauseMix hoc9H @121547   调 $video.play() / $video.pause()
 *   urlMix  loZvu @132173           读/写 $video.src（写 src 等于换源）
 *   optionInit gy71D @120776        写 $video[moreVideoAttr]、$video.volume、$video.autoplay、$video.playsInline
 *   autoSize k2ukN @110082 / autoHeight lxRiE @109637 / info bAZEJ @101640   读 $video.videoWidth/videoHeight
 *
 * 推荐接入方式（不要构造后再改 $video）：
 *     var shim = AndroidNativeTimeline.create({ provider: nativeMpvBridge });
 *     var art = new Artplayer({ ..., proxy: function () { return shim.video; } });
 *     // 或在 art 构造后、art.url 赋值前：AndroidNativeTimeline.attachToArt(art, { provider });
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.AndroidNativeTimeline = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var HAS_OWN = Object.prototype.hasOwnProperty;
  var READY_STATE = { NOTHING: 0, METADATA: 1, CURRENT_DATA: 2, FUTURE_DATA: 3, ENOUGH_DATA: 4 };

  function noop() {}
  function isNum(v) {
    return typeof v === 'number' && !Number.isNaN(v); // 允许 ±Infinity（直播）
  }
  function numOr(v, d) {
    return isNum(v) ? v : d;
  }
  function clamp(v, lo, hi) {
    if (!(v > lo)) v = lo;
    return hi !== Infinity && v > hi ? hi : v;
  }
  function now() {
    return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  }
  function isThenable(v) {
    return v && typeof v.then === 'function';
  }

  /** 伪造 TimeRanges（art 只用到 length / end(i)） */
  function makeRanges(pairs) {
    var list = [];
    if (pairs && pairs.length) {
      for (var i = 0; i < pairs.length; i++) {
        var a = Number(pairs[i][0]);
        var b = Number(pairs[i][1]);
        if (isNum(a) && isNum(b) && b > a) list.push([a, b]);
      }
      list.sort(function (x, y) {
        return x[0] - y[0];
      });
    }
    return {
      length: list.length,
      start: function (i) {
        return list[i] ? list[i][0] : 0;
      },
      end: function (i) {
        return list[i] ? list[i][1] : 0;
      },
      item: function (i) {
        return list[i] ? { start: list[i][0], end: list[i][1] } : null;
      },
      toString: function () {
        return '[fake TimeRanges len=' + list.length + ']';
      }
    };
  }

  var EventCtor =
    root && typeof root.Event === 'function'
      ? root.Event
      : function MiniEvent(type) {
          this.type = type;
          this.target = null;
          this.bubbles = false;
          this.timeStamp = Date.now();
        };

  function raf(cb) {
    if (root && typeof root.requestAnimationFrame === 'function') return root.requestAnimationFrame(cb);
    return setTimeout(function () {
      cb(now());
    }, 16);
  }
  function cancelRaf(id) {
    if (root && typeof root.cancelAnimationFrame === 'function') root.cancelAnimationFrame(id);
    else clearTimeout(id);
  }

  /**
   * @param {Object} opts
   *   provider 必填：{ time(), duration(), paused(), seek(t), play(), pause(), rate(v), volume(v) }
   *            可选：buffered(), played(), readyState(), size(), ended(), seeking(), muted(v), load(url)
   *   element  可选：要接管的 <video>（缺省 createElement('video')）
   *   mode     'interval'（默认，4Hz）| 'raf'（60fps 外推帧 + 4Hz 拉取）
   *   hz       发射频率，默认 4
   *   pollHz   向 provider 拉取的频率，默认 4（raf 模式下其余帧做外推）
   *   extrapolate        两次拉取之间用「锚点 + 墙钟 × 倍速」外推，默认 true
   *   staleTolerance     seek 后判定「原生已到位」的容差（秒），默认 0.35
   *   backwardTolerance  无 seek 时容忍的时间回退（秒），默认 0.5
   *   seekTimeoutMs       seek 不落地时的兜底（毫秒），默认 3000
   *   log       调试日志
   */
  function create(opts) {
    opts = opts || {};
    var log = typeof opts.log === 'function' ? opts.log : null;
    var doc = (root && root.document) || (opts.element && opts.element.ownerDocument) || null;
    var el = opts.element || (doc ? doc.createElement('video') : null);
    if (!el) throw new Error('android-native-timeline: 需要 document 或 opts.element');

    var provider = opts.provider || {};
    var mode = opts.mode === 'raf' ? 'raf' : 'interval';
    var hz = Math.max(1, numOr(opts.hz, 4));
    var pollHz = Math.max(1, numOr(opts.pollHz, 4));
    var extrapolate = opts.extrapolate !== false;
    var staleTolerance = numOr(opts.staleTolerance, 0.35);
    var backwardTolerance = numOr(opts.backwardTolerance, 0.5);
    var seekTimeoutMs = numOr(opts.seekTimeoutMs, 3000);
    var autoPlayOnPlay = opts.autoPlayOnPlay !== false;

    // ---- 本地镜像（provider 是权威；这里只是同步可读的缓存）----
    var st = {
      time: 0, // 最近一次 provider 报告的原始时间
      duration: 0,
      paused: true,
      ended: false,
      rate: 1,
      volume: 1,
      muted: false,
      readyState: READY_STATE.NOTHING,
      seeking: false,
      width: 0,
      height: 0,
      src: '',
      buffered: makeRanges([]),
      played: makeRanges([])
    };

    // 外推锚点：provider 在 at 时刻报告 time=t
    var anchor = { t: 0, at: now(), rate: 1, valid: false };
    // 待落地 seek：{ target, gen, at }
    var pending = null;
    // 暂停冻结基准：进入暂停后第一次采到的原生时间；之后只允许小幅修正
    var pausedRef = null;
    // 这个源是否已经采到过第一个样本（暂停中也要照收，作为冻结基准）
    var haveSample = false;

    var gen = 0; // 换源 / seek 世代号
    var metaGen = -1; // 该世代是否已发过 loadedmetadata
    var canPlayFired = false;

    var driver = { running: false, id: null, timer: null, lastPollAt: 0, lastEmitAt: 0 };

    var stats = {
      polls: 0,
      emits: 0,
      droppedStale: 0,
      droppedBackward: 0,
      seekTimeouts: 0,
      providerErrors: 0,
      events: {}
    };

    // ---- provider 调用（任何异常都不能把播放器带崩）----
    function pcall(name, arg) {
      var fn = provider[name];
      if (typeof fn !== 'function') return { ok: false };
      try {
        return { ok: true, value: arguments.length > 1 ? fn.call(provider, arg) : fn.call(provider) };
      } catch (err) {
        stats.providerErrors++;
        if (log) log('[timeline] provider.' + name + ' 抛错: ' + err);
        return { ok: false, error: err };
      }
    }
    function pnum(name, fallback) {
      var r = pcall(name);
      return r.ok ? numOr(r.value, fallback) : fallback;
    }

    // ---- 事件 ----
    function dispatch(type) {
      stats.events[type] = (stats.events[type] || 0) + 1;
      var ev;
      try {
        ev = new EventCtor(type);
      } catch (e) {
        ev = { type: type, target: el };
      }
      if (typeof el.dispatchEvent === 'function') el.dispatchEvent(ev);
      return true;
    }

    // ---- 时间估算 ----
    function estimate(ts) {
      if (pending) return pending.target; // seek 未落地：UI 钉在目标上，绝不返回旧时间
      if (!extrapolate || st.paused || !st.rate || !anchor.valid) return st.time;
      var t = anchor.t + ((ts - anchor.at) / 1000) * anchor.rate;
      if (t < anchor.t) t = anchor.t; // 墙钟回拨保护
      if (isNum(st.duration) && st.duration !== Infinity) t = clamp(t, 0, st.duration);
      return t;
    }
    function setAnchor(t, ts) {
      anchor.t = t;
      anchor.at = ts;
      anchor.rate = st.rate || 1;
      anchor.valid = true;
    }

    function settleSeek(rawTime, ts, timedOut) {
      if (!pending) return;
      if (timedOut) stats.seekTimeouts++;
      pending = null;
      st.seeking = false;
      st.time = rawTime;
      pausedRef = st.paused ? rawTime : null;
      haveSample = true;
      setAnchor(rawTime, ts);
      dispatch('seeked');
      dispatch('timeupdate');
    }

    /**
     * 拉一次 provider。返回 false = 这一帧被丢弃（不要发任何事件）；
     * 返回 'settled' = 这一拍刚好落地一次 seek（seeked + timeupdate 已发）；
     * 返回 true = 正常采样。
     *
     * 丢弃规则：
     *  1. seek 未落地，且原生时间离目标 > staleTolerance（或原生自称 seeking）→ 丢；
     *     超过 seekTimeoutMs 仍未落地 → 兜底放行（否则 UI 永久卡住）。
     *  2. 没有 seek 却回退超过 backwardTolerance（mpv 观测位置抖动 / 缓冲回退）→ 丢。
     *  3. 暂停中：进入暂停后的第一个样本照收（作为冻结基准），之后只接受 ≤backwardTolerance
     *     的修正，明显前进一律拒绝 → 时间冻结。
     */
    function poll(ts) {
      stats.polls++;

      // 先定暂停状态：冻结规则要用「本拍」的状态，而不是上一拍。
      // 否则「原生同时发生 恢复播放 + 时间跳到 30」会被上一拍的 paused=true 误判成冻结。
      var pr = pcall('paused');
      var nowPaused = pr.ok ? !!pr.value : st.paused;
      if (nowPaused !== st.paused) {
        st.paused = nowPaused;
        pausedRef = null;
      }

      var rawTime = pnum('time', st.time);

      if (pending) {
        var behind = Math.abs(rawTime - pending.target) > staleTolerance;
        var busy = (function () {
          var r = pcall('seeking');
          return r.ok ? !!r.value : false;
        })();
        if (behind || busy) {
          stats.droppedStale++;
          if (ts - pending.at > seekTimeoutMs) settleSeek(rawTime, ts, true);
          return false;
        }
        settleSeek(rawTime, ts, false);
        return 'settled'; // seeked + timeupdate 已在 settleSeek 里发过
      }

      if (!nowPaused) {
        pausedRef = null;
        if (rawTime + backwardTolerance < st.time) {
          // 没有 seek 却回退超过容忍量：多半是原生侧旧的观测位置（mpv time-pos 抖动/缓冲回退）
          stats.droppedBackward++;
          return false;
        }
        st.time = rawTime;
        haveSample = true;
      } else if (!haveSample) {
        // 这个源的第一个样本：暂停中也要照收，作为冻结基准
        st.time = rawTime;
        pausedRef = rawTime;
        haveSample = true;
      } else {
        // 暂停：以进入暂停后的基准为准，只接受 ≤backwardTolerance 的修正，明显前进一律冻结
        if (pausedRef == null) pausedRef = st.time;
        if (rawTime <= pausedRef + backwardTolerance) {
          pausedRef = rawTime;
          st.time = rawTime;
        } else {
          st.time = pausedRef;
        }
      }

      // duration
      var d = pnum('duration', st.duration);
      if (isNum(d) && d !== st.duration) {
        var before = st.duration === Infinity ? 0 : st.duration;
        st.duration = d;
        setAnchor(st.time, ts);
        if (Math.abs((d === Infinity ? 0 : d) - before) > 0.05) dispatch('durationchange');
      }
      setAnchor(st.time, ts);

      // rate
      var rate = pnum('rate', st.rate);
      if (rate > 0 && rate !== st.rate) {
        st.rate = rate;
        setAnchor(st.time, ts);
        dispatch('ratechange');
      }

      // 尺寸
      var size = pcall('size');
      if (size.ok && size.value && typeof size.value === 'object') {
        var w = numOr(Number(size.value.width), st.width);
        var h = numOr(Number(size.value.height), st.height);
        if (w !== st.width || h !== st.height) {
          st.width = w;
          st.height = h;
          stats.sizeChanges = (stats.sizeChanges || 0) + 1;
        }
      }

      // readyState
      var rs = pnum('readyState', -1);
      st.readyState =
        rs >= 0 ? rs : st.duration > 0 || st.width > 0 || st.height > 0 ? READY_STATE.ENOUGH_DATA : READY_STATE.NOTHING;

      // buffered / played
      var br = pcall('buffered');
      if (br.ok && br.value) st.buffered = makeRanges(br.value);
      else if (st.duration > 0)
        st.buffered = makeRanges([[0, st.duration === Infinity ? st.time : Math.max(st.duration, st.time)]]);
      var pl = pcall('played');
      st.played = pl.ok && pl.value ? makeRanges(pl.value) : makeRanges([[0, st.time]]);

      // ended
      var ed = pcall('ended');
      if (ed.ok) st.ended = !!ed.value;
      else st.ended = isNum(st.duration) && st.duration > 0 && st.time >= st.duration - 0.15;

      // 元数据 / canplay：art 的 isReady 只认第一次 video:canplay
      if (st.duration > 0 && metaGen !== gen) {
        metaGen = gen;
        st.readyState = Math.max(st.readyState, READY_STATE.ENOUGH_DATA);
        dispatch('loadedmetadata');
        if (!canPlayFired) {
          canPlayFired = true;
          dispatch('canplay');
        }
      }
      return true;
    }

    // ---- 发射 ----
    function emitTimeupdate() {
      var ts = now();
      var r = poll(ts);
      if (r === false) return false;
      if (r === 'settled') return true; // settleSeek 已经发过 timeupdate
      if (st.paused) return false;
      stats.emits++;
      driver.lastEmitAt = ts;
      dispatch('timeupdate');
      return true;
    }

    function emitProgress() {
      dispatch('progress');
      return true;
    }

    function step(forcePoll) {
      var ts = now();
      var pollDue = forcePoll || mode === 'interval' || ts - (driver.lastPollAt || 0) >= 1000 / pollHz;
      if (pollDue) {
        driver.lastPollAt = ts;
        var r = poll(ts);
        if (r === false) return false;
        dispatch('progress');
        if (r === 'settled') return true;
        if (st.paused) return false;
      } else if (st.paused || pending) {
        return false;
      }
      stats.emits++;
      driver.lastEmitAt = ts;
      dispatch('timeupdate');
      return true;
    }

    function scheduleInterval() {
      driver.timer = setTimeout(function () {
        if (!driver.running) return;
        step(true);
        scheduleInterval();
      }, Math.round(1000 / hz));
    }

    function rafLoop() {
      if (!driver.running) return;
      driver.id = raf(function () {
        if (!driver.running) return;
        step(false);
        rafLoop();
      });
    }

    function start() {
      if (driver.running) return inst;
      driver.running = true;
      driver.lastPollAt = 0;
      if (mode === 'raf') rafLoop();
      else scheduleInterval();
      return inst;
    }

    function stop() {
      driver.running = false;
      if (driver.id != null) cancelRaf(driver.id);
      driver.id = null;
      if (driver.timer) clearTimeout(driver.timer);
      driver.timer = null;
      return inst;
    }

    // ---- 覆盖与还原 ----
    var saved = Object.create(null);
    function define(name, desc) {
      if (!HAS_OWN.call(saved, name)) {
        saved[name] = { had: HAS_OWN.call(el, name), desc: Object.getOwnPropertyDescriptor(el, name) };
      }
      desc.configurable = true; // 必须可配置：destroy() 要能还原
      desc.enumerable = false;
      // 值为函数的方法（play/pause/load…）默认是不可写的，而 Artplayer 会在某些路径上
      // 重新给 $video.play 赋值（`cannot assign to read only property 'play'`），所以放行写入。
      if (!desc.get && !desc.set && !('writable' in desc)) desc.writable = true;
      Object.defineProperty(el, name, desc);
    }
    function restore() {
      Object.keys(saved).forEach(function (name) {
        var s = saved[name];
        try {
          if (s.had && s.desc) Object.defineProperty(el, name, s.desc);
          else delete el[name];
        } catch (err) {
          if (log) log('[timeline] 还原 ' + name + ' 失败: ' + err);
        }
      });
      saved = Object.create(null);
    }

    // ---- seek ----
    function doSeek(target, silent) {
      var t = Number(target);
      if (!isNum(t)) return undefined;
      var d = st.duration;
      if (isNum(d) && d !== Infinity) t = clamp(t, 0, d);
      if (t < 0) t = 0;
      gen++;
      pending = { target: t, gen: gen, at: now() };
      st.seeking = true;
      st.ended = false;
      st.time = t; // 立即钉住可见时间；陈旧样本在 poll 里被丢掉
      pausedRef = null;
      setAnchor(t, now());
      if (!silent) dispatch('seeking');
      var r = pcall('seek', t);
      if (!r.ok && log) log('[timeline] provider.seek 不可用，仅按本地目标推进');
      return t;
    }

    // ---- 属性 ----
    define('currentTime', {
      get: function () {
        return pending ? pending.target : estimate(now());
      },
      set: function (v) {
        doSeek(v);
      }
    });
    define('duration', {
      get: function () {
        return st.duration;
      },
      set: noop
    });
    define('paused', {
      get: function () {
        return st.paused;
      },
      set: noop
    });
    define('ended', {
      get: function () {
        return st.ended;
      },
      set: noop
    });
    define('readyState', {
      get: function () {
        return st.readyState;
      },
      set: noop
    });
    define('seeking', {
      get: function () {
        return !!pending || st.seeking;
      },
      set: noop
    });
    define('buffered', {
      get: function () {
        return st.buffered;
      },
      set: noop
    });
    define('played', {
      get: function () {
        return st.played;
      },
      set: noop
    });
    define('seekable', {
      get: function () {
        return makeRanges(st.duration > 0 ? [[0, st.duration]] : []);
      },
      set: noop
    });
    define('videoWidth', {
      get: function () {
        return st.width;
      },
      set: noop
    });
    define('videoHeight', {
      get: function () {
        return st.height;
      },
      set: noop
    });
    define('playbackRate', {
      get: function () {
        return st.rate;
      },
      set: function (v) {
        var r = Number(v);
        if (!isNum(r) || r <= 0) return; // 原生 playbackRate 非法值会抛 NotSupportedError，这里静默丢弃
        st.rate = r;
        setAnchor(estimate(now()), now());
        pcall('rate', r);
        dispatch('ratechange');
      }
    });
    define('volume', {
      get: function () {
        var r = pcall('volume');
        if (r.ok && isNum(Number(r.value))) return Number(r.value);
        return st.volume;
      },
      set: function (v) {
        var x = Number(v);
        if (!isNum(x)) return;
        x = clamp(x, 0, 1);
        st.volume = x;
        pcall('volume', x);
        dispatch('volumechange');
      }
    });
    define('muted', {
      get: function () {
        var r = pcall('muted');
        if (r.ok && typeof r.value === 'boolean') return r.value;
        return st.muted;
      },
      set: function (v) {
        st.muted = !!v;
        pcall('muted', st.muted);
        dispatch('volumechange');
      }
    });
    // 非标准：artplayer playingMix @124038 优先读它（"boolean"==typeof t.playing）
    define('playing', {
      get: function () {
        return !st.paused && !st.ended;
      },
      set: noop
    });
    // src：只记下来，绝不触发真实加载（否则 Chromium 发 source not supported → video:error → art 重连循环）
    define('src', {
      get: function () {
        return st.src;
      },
      set: function (v) {
        st.src = v == null ? '' : String(v);
        gen++;
        metaGen = -1;
        st.duration = 0;
        st.time = 0;
        st.ended = false;
        st.seeking = false;
        st.buffered = makeRanges([]);
        pending = null;
        pausedRef = null;
        haveSample = false;
        setAnchor(0, now());
        if (st.src) {
          dispatch('loadstart');
          pcall('load', st.src);
        }
      }
    });
    define('currentSrc', {
      get: function () {
        return st.src;
      },
      set: noop
    });
    // 引擎内部只读位：给个安全值，避免被内部读取时抛错
    define('networkState', {
      get: function () {
        return 1;
      },
      set: noop
    }); // NETWORK_IDLE
    define('error', {
      get: function () {
        return null;
      },
      set: noop
    });

    // ---- 方法 ----
    define('play', {
      value: function () {
        var r = pcall('play');
        if (autoPlayOnPlay) {
          pausedRef = null;
          st.paused = false;
          st.ended = false;
          setAnchor(st.time, now());
          dispatch('play');
          dispatch('playing');
        }
        start();
        return r.ok && isThenable(r.value) ? r.value : Promise.resolve();
      }
    });
    define('pause', {
      value: function () {
        var r = pcall('pause');
        pausedRef = null;
        st.paused = true;
        setAnchor(st.time, now());
        stop();
        dispatch('pause');
        return r.ok ? r.value : undefined;
      }
    });
    define('load', {
      value: function () {
        dispatch('loadstart');
      }
    });
    define('canPlayType', {
      value: function (type) {
        var r = pcall('canPlayType', type);
        return r.ok && r.value ? String(r.value) : 'maybe';
      }
    });

    // ---- 实例 ----
    var inst = {
      video: el,
      stats: stats,
      get provider() {
        return provider;
      },
      set provider(p) {
        provider = p || {};
      },
      get state() {
        return {
          time: estimate(now()),
          polledTime: st.time,
          duration: st.duration,
          paused: st.paused,
          ended: st.ended,
          rate: st.rate,
          seeking: !!pending,
          seekTarget: pending ? pending.target : null,
          readyState: st.readyState,
          src: st.src,
          width: st.width,
          height: st.height
        };
      },
      start: start,
      stop: stop,
      get running() {
        return driver.running;
      },
      /** 手动一拍：拉状态 + 发 timeupdate（暂停时不发） */
      tick: function () {
        return step(true);
      },
      /** 只拉状态，不发事件 */
      sync: function () {
        return poll(now());
      },
      emitTimeupdate: emitTimeupdate,
      emitProgress: emitProgress,
      emit: dispatch,
      /** 尺寸变化后让 art 重新算画面矩形（art 的 video:loadedmetadata 处理器会 emit resize） */
      notifyResize: function () {
        dispatch('loadedmetadata');
      },
      /** 原生推送一帧状态（Kotlin → JS 回调路径） */
      push: function (s) {
        s = s || {};
        var t = Number(s.time);
        if (pending) {
          if (isNum(t) && Math.abs(t - pending.target) > staleTolerance) {
            stats.droppedStale++;
            return false;
          }
          if (isNum(t)) {
            pending = null;
            st.seeking = false;
            st.time = t;
            setAnchor(t, now());
            dispatch('seeked');
          }
        } else if (isNum(t)) {
          if (!st.paused && t + backwardTolerance < st.time) {
            stats.droppedBackward++;
            return false;
          }
          st.time = st.paused ? Math.min(t, st.time) : t;
          haveSample = true;
          if (st.paused) pausedRef = st.time;
          setAnchor(st.time, now());
        }
        if (isNum(Number(s.duration)) && Number(s.duration) !== st.duration) st.duration = Number(s.duration);
        if (typeof s.paused === 'boolean') st.paused = s.paused;
        if (typeof s.ended === 'boolean') st.ended = s.ended;
        if (isNum(Number(s.rate)) && Number(s.rate) > 0) st.rate = Number(s.rate);
        if (s.bufferedEnd != null) st.buffered = makeRanges([[0, Number(s.bufferedEnd)]]);
        else if (st.duration > 0) st.buffered = makeRanges([[0, Math.max(st.duration, st.time)]]);
        if (s.width) st.width = Number(s.width);
        if (s.height) st.height = Number(s.height);
        st.played = makeRanges([[0, st.time]]);
        if (st.duration > 0 && metaGen !== gen) {
          metaGen = gen;
          st.readyState = READY_STATE.ENOUGH_DATA;
          dispatch('loadedmetadata');
          if (!canPlayFired) {
            canPlayFired = true;
            dispatch('canplay');
          }
        }
        if (!st.paused) {
          stats.emits++;
          dispatch('timeupdate');
          return true;
        }
        return false;
      },
      seek: function (t) {
        return doSeek(t);
      },
      /** 让 art 的 video:error 分支跑一次（重连/提示） */
      fail: function () {
        dispatch('error');
      },
      destroy: function () {
        stop();
        restore();
      }
    };
    return inst;
  }

  /**
   * 直接接管一个已存在的 Artplayer 实例的 $video（备选方案）。
   * 必须在 `art.url = ...` 之前调用，否则 art 已经写过一次 src。
   * 更推荐 `new Artplayer({ proxy: () => shim.video })`。
   */
  function attachToArt(art, opts) {
    var tpl = art && art.template;
    var v = (tpl && tpl.$video) || (art && art.video);
    if (!v) throw new Error('attachToArt: art 还没有 $video（Artplayer 没构造完？）');
    opts = opts || {};
    opts.element = v;
    if (opts.provider && v.src) {
      // 已经触发过真实加载的元素上接管：先清掉，避免 MediaError 继续冒泡
      try {
        v.removeAttribute('src');
      } catch (e) {}
    }
    return create(opts);
  }

  return {
    create: create,
    attachToArt: attachToArt,
    makeRanges: makeRanges,
    READY_STATE: READY_STATE
  };
});
