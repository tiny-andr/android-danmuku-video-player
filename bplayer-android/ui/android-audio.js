(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else {
    root.AndroidAudioTasks = api.createTasks(root);
    root.AndroidAudioTrack = { create: function (art) { return api.createTrack(art, root); } };
    root.AndroidAudioSession = { create: api.createSession, codec: api.codec };
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  function abortError(message) { var error = new Error(message || "Audio task cancelled"); error.name = "AbortError"; return error; }

  // 音轨 PTS 起点相对容器起点的偏移。探测结果里带出来（start_time/origin），
  // 后续 prepare 拿它当提示，就不用为了这两个数再 ffprobe 一次。
  function probeOffset(probe, audioIndex) {
    if (!probe || !probe.tracks) return 0;
    var audio = probe.tracks.filter(function (track) { return track.kind === "audio"; })[audioIndex];
    if (!audio) return 0;
    var origin = Number(probe.origin);
    if (!isFinite(origin)) origin = 0;
    var start = audio.start_time == null ? origin : Number(audio.start_time);
    if (!isFinite(start)) start = origin;
    var value = start - origin;
    return isFinite(value) ? Math.max(-3600, Math.min(3600, value)) : 0;
  }
  function uuid(environment) {
    if (environment.crypto && environment.crypto.randomUUID) return environment.crypto.randomUUID();
    var bytes = new Uint8Array(16);
    if (!environment.crypto || !environment.crypto.getRandomValues) throw new Error("安全随机数不可用，无法建立音轨会话");
    environment.crypto.getRandomValues(bytes); bytes[6] = bytes[6] & 15 | 64; bytes[8] = bytes[8] & 63 | 128;
    var hex = Array.from(bytes, function (value) { return value.toString(16).padStart(2, "0"); }).join("");
    return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
  }

  function createTasks(environment, options) {
    options = options || {};
    var pending = new Map(); var subscribers = new Set(); var serial = 0; var disposed = false; var currentSession = null;
    var prefix = Date.now().toString(36) + "-";
    var schedule = options.setTimeout || setTimeout; var unschedule = options.clearTimeout || clearTimeout;
    function settle(id, error, result) {
      var entry = pending.get(String(id)); if (!entry) return;
      pending.delete(String(id)); unschedule(entry.timer);
      if (error) entry.reject(error); else entry.resolve(result);
    }
    function request(command, args, settings) {
      args = Object.assign({}, args || {}); settings = settings || {};
      var id = prefix + String(++serial); var resolve, reject;
      var promise = new Promise(function (done, fail) { resolve = done; reject = fail; });
      var entry = { id: id, command: command, session: args.session, resolve: resolve, reject: reject, timer: null };
      promise.cancel = function () { settle(id, abortError()); };
      if (disposed) { reject(abortError("Audio bridge disposed")); return promise; }
      pending.set(id, entry);
      entry.timer = schedule(function () {
        var error = new Error("音轨请求超时，请检查网络后重试"); error.name = "TimeoutError"; settle(id, error);
      }, Math.max(1, settings.timeoutMs || options.timeoutMs || 30000));
      try {
        if (!environment.AndroidAudioNative || typeof environment.AndroidAudioNative.request !== "function") throw new Error("音轨处理桥未就绪，请重新打开应用");
        environment.AndroidAudioNative.request(id, command, JSON.stringify(args));
      } catch (error) { settle(id, error); }
      return promise;
    }
    function cancelSession(session) {
      Array.from(pending.values()).forEach(function (entry) { if (entry.session === session && entry.command !== "audio_cancel") settle(entry.id, abortError()); });
    }
    var reply = function (id, envelope) {
      if (!envelope || !envelope.ok) settle(id, new Error(envelope && envelope.error || "音轨请求失败"));
      else settle(id, null, envelope.result);
    };
    var event = function (name, payload) {
      if (disposed || !payload || !["progress", "assembling", "done", "error", "cancelled"].includes(name)) return;
      Array.from(subscribers).forEach(function (subscriber) { try { subscriber(name, payload); } catch (error) {} });
    };
    environment.__aAudioReply = reply; environment.__aAudioEvent = event;
    return {
      request: request, cancelSession: cancelSession, uuid: function () { return uuid(environment); },
      setCurrentSession: function (session) { currentSession = session || null; },
      get currentSession() { return currentSession; },
      subscribe: function (subscriber) { subscribers.add(subscriber); return function () { subscribers.delete(subscriber); }; },
      dispose: function () {
        disposed = true; currentSession = null; Array.from(pending.keys()).forEach(function (id) { settle(id, abortError("Audio bridge disposed")); }); subscribers.clear();
        if (environment.__aAudioReply === reply) delete environment.__aAudioReply;
        if (environment.__aAudioEvent === event) delete environment.__aAudioEvent;
      },
      get state() { return { pending: pending.size, subscribers: subscribers.size, disposed: disposed }; }
    };
  }

  // 内核确定能直接播的音频编码白名单。这里以前是黑名单（只列出 DTS/TrueHD/AC3 这类），
  // 名单外的冷门编码（mp2/ALAC/APE/WMA…）会被当成「可播」——结果就是不转码但没声音。
  // 改成白名单后，拿不准的一律走转换：最差多转一次，不会静音。
  // AC-3/E-AC-3 桌面内核能解、安卓 WebView 不能解，所以都留在名单外按需要转换处理。
  var NATIVE_AUDIO = ["A_AAC", "AAC", "A_MPEG/L3", "MP3", "A_OPUS", "OPUS", "A_VORBIS", "VORBIS", "A_FLAC", "FLAC"];
  function codec(value) {
    var name = String(value || "").toUpperCase();
    var dead = name.indexOf("A_DTS") === 0 || ["DTS", "DCA", "TRUEHD", "A_TRUEHD", "PCM_BLURAY", "A_PCM/BLURAY", "AC4", "AC-4", "A_AC4", "A_DRA", "DRA"].includes(name);
    var unreliable = ["A_AC3", "AC3", "AC-3", "A_EAC3", "EAC3", "E-AC-3"].includes(name);
    var native = NATIVE_AUDIO.includes(name);
    return { dead: dead, unreliable: unreliable, native: native, needsConversion: !native };
  }

  function createSession(tasks, hooks) {
    hooks = hooks || {}; var state = null; var disposed = false;
    function emit(name, value) { if (hooks[name]) hooks[name](value); }
    function owns(owner) { return !!(!disposed && state && state.session === owner.session && state.generation === owner.generation && state.video === owner.video); }
    function cancelNative(session, jobId) {
      if (!session) return;
      tasks.request("audio_cancel", { session: session, jobId: jobId || null }).catch(function () {});
    }
    function cancelSelection() {
      if (!state) return;
      var oldJob = state.jobId;
      state.generation++; state.jobId = null; state.phase = "idle";
      tasks.cancelSession(state.session); if (oldJob) cancelNative(state.session, oldJob); emit("resetTrack"); emit("idle");
    }
    function reset() {
      if (!state) return;
      var previous = state; state = null;
      if (tasks.setCurrentSession) tasks.setCurrentSession(null);
      tasks.cancelSession(previous.session); cancelNative(previous.session, null); emit("resetTrack"); emit("idle");
    }
    async function mount(owner, path, offset, legacy) {
      if (!owns(owner)) return;
      state.phase = "mounting";
      try {
        await hooks.mount({ path: path, offset: Number(offset) || 0, audioIndex: owner.audioIndex, legacy: !!legacy,
          valid: function () { return owns(owner); }, session: owner.session, generation: owner.generation,
          onError: function (error) {
            if (!owns(owner) || state.phase === "error") return;
            state.phase = "error"; state.activeIndex = -1; emit("resetTrack"); emit("error", error.message || String(error));
          } });
        if (!owns(owner)) return;
        state.phase = "ready"; state.activeIndex = owner.audioIndex; emit("ready", { audioIndex: owner.audioIndex, legacy: !!legacy });
      } catch (error) {
        if (!owns(owner) || error.name === "AbortError" || state.phase === "error") return;
        state.phase = "error"; emit("resetTrack"); emit("error", error.message || String(error));
      }
    }
    async function select(audioIndex, manual) {
      if (!state || !state.tracks[audioIndex]) return;
      cancelSelection();
      var owner = { session: state.session, generation: state.generation, video: state.video, audioIndex: audioIndex };
      state.phase = "preparing"; state.selectedIndex = audioIndex; state.activeIndex = -1;
      try {
        emit("isolate"); emit("selecting", audioIndex);
        // 探测结果里已经有时长和 PTS 起点，带上它们，prepare 就不用再跑一次 ffprobe
        var prepared = await tasks.request("audio_prepare", {
          videoPath: owner.video, audioIndex: audioIndex, session: owner.session,
          durationUs: state.probe && state.probe.duration_us ? state.probe.duration_us : 0,
          offsetSecs: probeOffset(state.probe, audioIndex)
        });
        if (!owns(owner)) return;
        if (!prepared || typeof prepared.jobId !== "string" || typeof prepared.target !== "string") throw new Error("音轨缓存准备结果无效");
        state.jobId = prepared.jobId;
        if (prepared.cached) { await mount(owner, prepared.target, prepared.offset, prepared.legacy); return; }
        if (!manual && !hooks.autoEnabled()) {
          state.phase = "disabled"; cancelNative(owner.session, prepared.jobId); state.jobId = null;
          emit("disabled", { audioIndex: audioIndex }); return;
        }
        state.phase = "starting"; emit("progress", { percent: -1, written: 0 });
        // 流式接管：边转边播（MSE），不用等整条音轨转完。失败就原样退回下面的整段转码，
        // 那条链路和缓存复用都保持不变，流式只是「先出声」的加速路径。
        // 进来先停掉上一路：换轨时旧流的 ffmpeg 和增长文件都必须立刻收掉。
        if (hooks.stream) {
          var streamed = false;
          try { streamed = await hooks.stream({ videoPath: owner.video, audioIndex: audioIndex, session: owner.session }); }
          catch (error) { streamed = false; }
          if (!owns(owner)) return;
          if (streamed) {
            var permit = state.jobId; state.jobId = null;
            if (permit) cancelNative(owner.session, permit);   // prepare 留下的 permit 不再需要
            state.phase = "ready"; state.activeIndex = audioIndex;
            emit("ready", { audioIndex: audioIndex, legacy: false });
            return;
          }
        }
        await tasks.request("audio_start", { jobId: prepared.jobId, session: owner.session });
        if (!owns(owner)) return;
        if (state.phase === "starting") state.phase = "running";
      } catch (error) {
        if (!owns(owner) || error.name === "AbortError" || ["mounting", "ready", "completed"].includes(state.phase)) return;
        state.phase = "error"; var jobId = state.jobId; state.jobId = null; if (jobId) cancelNative(owner.session, jobId);
        emit("resetTrack"); emit("error", error.message || String(error));
      }
    }
    function begin(video) {
      reset(); if (disposed) return null;
      state = { session: tasks.uuid(), video: video, generation: 0, jobId: null, phase: "loading", tracks: [], probe: null, activeIndex: -1, selectedIndex: -1 };
      if (tasks.setCurrentSession) tasks.setCurrentSession(state.session);
      return state.session;
    }
    async function open(video) { begin(video); return probe(); }
    async function probe() {
      if (!state || disposed) return;
      state.phase = "probing";
      var owner = { session: state.session, generation: state.generation, video: state.video };
      emit("probing");
      try {
        // 同一条片反复打开时没必要每次都跑 ffprobe：网络源上那一步要好几秒。
        // 缓存由外壳按「路径 + 大小 + 修改时间」校验，文件一变就自然失效。
        var probe = null;
        if (hooks.cachedProbe) { try { probe = await hooks.cachedProbe(owner.video); } catch (error) { probe = null; } }
        if (!probe) {
          probe = await tasks.request("audio_probe", { path: owner.video, session: owner.session }, { timeoutMs: 90000 });
          if (!owns(owner)) return;
          if (hooks.rememberProbe) { try { hooks.rememberProbe(owner.video, probe); } catch (error) { } }
        }
        if (!owns(owner)) return;
        state.probe = probe;
        state.tracks = (probe.tracks || []).filter(function (track) { return track.kind === "audio"; });
        state.phase = "idle"; emit("probe", { tracks: state.tracks.slice(), allTracks: probe.tracks || [], duration_us: probe.duration_us || null });
        if (!state.tracks.length) return;
        // 用户在探测返回之前就手动点了音轨：这里不能再发起自动选择。select() 第一行会
        // cancelSelection()，把用户刚启动的那单连 jobId 一起取消，进度胶囊随之消失，
        // 用户看到的是「处理中一闪就没了」。
        if (state.selectedIndex >= 0) return;
        var selected = state.tracks.findIndex(function (track) { return !!track.default; }); if (selected < 0) selected = 0;
        if (selected !== 0 || codec(state.tracks[selected].codec).needsConversion) await select(selected, false);
      } catch (error) {
        if (!owns(owner) || error.name === "AbortError") return;
        state.phase = "error"; emit("error", "音轨探测失败：" + (error.message || String(error)));
      }
    }
    var unsubscribe = tasks.subscribe(function (event, payload) {
      if (!state || payload.session !== state.session || payload.video !== state.video || payload.jobId !== state.jobId || payload.audioIndex !== state.selectedIndex) return;
      // 拼接阶段（裁段 + concat 重封装）的 phase 仍是 running：编码会话都已结束，但任务没有终态，
      // 所以这条事件能穿过上面的 phase 过滤，也不会走下面的 done 分支把胶囊提前收掉。
      if (!["starting", "running"].includes(state.phase)) return;
      var owner = { session: state.session, generation: state.generation, video: state.video, audioIndex: state.selectedIndex };
      if (event === "progress") { emit("progress", payload); return; }
      if (event === "assembling") { emit("assembling", payload); return; }
      if (event === "done") {
        state.phase = "completed";
        if (!payload.path) { state.phase = "error"; emit("error", "音轨任务完成但未返回可播放缓存"); return; }
        mount(owner, payload.path, payload.offset, false); return;
      }
      state.jobId = null; state.phase = event === "cancelled" ? "cancelled" : "error";
      emit("resetTrack"); emit(event === "cancelled" ? "idle" : "error", payload.message || "音轨转换失败，当前编码可能不受转换器支持");
    });
    return { begin: begin, probe: probe, open: open, select: select, cancel: cancelSelection, reset: reset,
      dispose: function () { reset(); disposed = true; unsubscribe(); },
      get state() { return state ? { session: state.session, video: state.video, generation: state.generation, jobId: state.jobId, phase: state.phase,
        selectedIndex: state.selectedIndex, activeIndex: state.activeIndex, tracks: state.tracks.slice() } : null; }
    };
  }

  function createTrack(art, environment) {
    environment = environment || {}; var video = art.video; var current = null; var generation = 0; var disposed = false; var blocked = false;
    var schedule = environment.setTimeout || setTimeout; var unschedule = environment.clearTimeout || clearTimeout;
    var listeners = [];
    function listen(target, name, action, collection) { target.addEventListener(name, action); collection.push(function () { target.removeEventListener(name, action); }); }
    function active(entry) { return !disposed && current === entry && entry.generation === generation && entry.valid(); }
    function pause(entry) { if (entry) { entry.wantPlay = false; try { entry.audio.pause(); } catch (error) {} } }
    function release(entry, error) {
      if (!entry) return;
      pause(entry); entry.listeners.forEach(function (remove) { remove(); }); unschedule(entry.timer);
      try { entry.audio.removeAttribute("src"); entry.audio.load(); } catch (failure) {}
      if (!entry.settled) { entry.settled = true; entry.reject(error || abortError()); }
    }
    function reset() { generation++; var old = current; current = null; release(old); blocked = false; }
    function sync(entry, force) {
      if (!active(entry)) { if (current === entry) { current = null; release(entry); } return; }
      var audio = entry.audio; var desired = Number(video.currentTime) - entry.offset;
      audio.playbackRate = Number(video.playbackRate) || 1;
      audio.volume = Math.max(0, Math.min(1, Number(video.volume) || 0));
      if (!entry.metadata || !Number.isFinite(desired)) { pause(entry); return; }
      if (desired < 0 || (Number.isFinite(audio.duration) && audio.duration > 0 && desired >= audio.duration)) {
        pause(entry);
        if (!entry.settled) { entry.settled = true; unschedule(entry.timer); entry.resolve(true); }
        return;
      }
      if (video.seeking || blocked || entry.seeking || audio.seeking || entry.audioWaiting) { pause(entry); return; }
      if (environment.document && environment.document.visibilityState === "hidden") { pause(entry); return; }
      var difference = Math.abs(Number(audio.currentTime) - desired);
      var now = Date.now();
      if (difference > (entry.aligned ? 0.25 : 0.025) && (force || !entry.aligned || now - entry.lastSeek >= 600)) {
        pause(entry); entry.aligned = false; entry.seeking = true; entry.lastSeek = now;
        try { audio.currentTime = desired; } catch (error) { current = null; release(entry, new Error("外挂音轨无法定位到当前播放位置")); }
        return;
      }
      if (!entry.aligned && difference > 0.025) { pause(entry); return; }
      if (audio.readyState < 2 || (typeof video.readyState === "number" && video.readyState < 2)) { pause(entry); return; }
      entry.aligned = true; audio.muted = !!video.muted;
      if (!entry.settled) { entry.settled = true; unschedule(entry.timer); entry.resolve(true); }
      if (video.paused || video.ended) { pause(entry); return; }
      if (entry.wantPlay && !audio.paused) return;
      if (entry.playPending) return;
      entry.wantPlay = true; entry.playPending = true;
      try {
        Promise.resolve(audio.play()).then(function () {
          entry.playPending = false;
          if (!active(entry) || video.paused || video.seeking || blocked || entry.seeking || !entry.wantPlay) pause(entry);
        }, function (error) {
          entry.playPending = false;
          if (!active(entry)) return;
          current = null; release(entry, error);
          if (entry.onError) entry.onError(error);
        });
      } catch (error) { current = null; release(entry, error); if (entry.onError) entry.onError(error); }
    }
    ["pause", "ended"].forEach(function (name) { listen(video, name, function () { pause(current); }, listeners); });
    listen(video, "seeking", function () { blocked = true; pause(current); }, listeners);
    listen(video, "waiting", function () { blocked = true; pause(current); }, listeners);
    ["playing", "canplay", "seeked"].forEach(function (name) { listen(video, name, function () { blocked = false; if (current) sync(current, true); }, listeners); });
    ["play", "timeupdate", "ratechange", "volumechange"].forEach(function (name) { listen(video, name, function () { if (current) sync(current, false); }, listeners); });
    function update(options) {
      reset(); options = options || {};
      if (disposed || !options.url) return Promise.reject(abortError("No audio source"));
      var audio = new environment.Audio(); audio.crossOrigin = "anonymous"; audio.preload = "auto"; audio.autoplay = false; audio.muted = true;
      var resolve, reject; var promise = new Promise(function (done, fail) { resolve = done; reject = fail; });
      var entry = { generation: generation, audio: audio, offset: Number.isFinite(Number(options.offset)) ? Number(options.offset) : 0, valid: options.valid || function () { return true; },
        onError: options.onError, metadata: false, aligned: false, seeking: false, audioWaiting: false, wantPlay: false, playPending: false, lastSeek: 0,
        settled: false, resolve: resolve, reject: reject, listeners: [], timer: null };
      current = entry;
      blocked = !!video.seeking || (typeof video.readyState === "number" && video.readyState < 3);
      function updateReady() { if (active(entry)) { entry.audioWaiting = false; sync(entry, true); } }
      listen(audio, "loadedmetadata", function () { if (!active(entry)) return; entry.metadata = true; sync(entry, true); }, entry.listeners);
      listen(audio, "canplay", updateReady, entry.listeners);
      listen(audio, "seeked", function () { if (!active(entry)) return; entry.seeking = false; sync(entry, true); }, entry.listeners);
      listen(audio, "waiting", function () { if (active(entry)) { entry.audioWaiting = true; pause(entry); } }, entry.listeners);
      listen(audio, "error", function () {
        if (!active(entry)) return;
        var error = new Error("外挂音轨无法播放，缓存可能损坏或编码不受支持"); current = null; release(entry, error); if (entry.onError) entry.onError(error);
      }, entry.listeners);
      entry.timer = schedule(function () { if (!active(entry)) return; var error = new Error("外挂音轨定位或缓冲超时"); current = null; release(entry, error); if (entry.onError) entry.onError(error); }, Number(options.timeoutMs) || 15000);
      try { audio.src = options.url; audio.load(); } catch (error) { current = null; release(entry, error); }
      return promise;
    }
    return { update: update, reset: reset, dispose: function () { reset(); disposed = true; listeners.forEach(function (remove) { remove(); }); listeners = []; },
      get audio() { return current ? current.audio : null; },
      get state() { return current ? { generation: generation, offset: current.offset, metadata: current.metadata, aligned: current.aligned, seeking: current.seeking, playing: !current.audio.paused } : null; } };
  }
  return { createTasks: createTasks, createSession: createSession, createTrack: createTrack, codec: codec };
});
