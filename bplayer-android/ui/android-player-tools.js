(function () {
  "use strict";

  var owner = null;
  var path = "";
  var ready = false;
  var decisionMade = true;
  var playAllowed = false;
  var pendingResume = null;
  var locked = false;
  var lockControlsTimer = null;
  var lockTouch = null;
  var fit = "contain";
  var lastSave = 0;
  var actions = null;
  var shield = null;
  var prompt = null;
  var notice = null;
  var noticeTimer = null;
  var resumeTimer = null;
  var resumeRemaining = 0;
  var storage = null;
  try { storage = window.localStorage; } catch (error) {}
  var store = window.AndroidResumeStore.create(storage);

  // 续播卡的「自动继续」倒计时（秒）。为什么是 3 秒：手机用户看到续播卡后的决策窗口很短，
  // 想「从头播放」的人 3 秒内足够点到；再长卡片就只是挡着画面、用户还会忘了它开着。
  // 以后要改只动这一处（按整秒显示，计时器每秒一跳）。
  var RESUME_COUNTDOWN_SEC = 3;

  function node(tag, cls, text) {
    var element = document.createElement(tag);
    if (cls) element.className = cls;
    if (text != null) element.textContent = text;
    return element;
  }
  function button(text, id, callback) {
    var element = node("button", "", text); element.type = "button"; element.id = id;
    element.addEventListener("click", function (event) { event.stopPropagation(); callback(); });
    return element;
  }
  function ensure() {
    if (actions) return;
    var style = node("style");
    style.textContent = "#mPlayerActions{position:fixed;z-index:100015;right:calc(env(safe-area-inset-right,0px) + 12px);bottom:calc(var(--m-controls-height,76px) + 12px);display:flex;gap:8px;opacity:0;pointer-events:none;transition:opacity .18s}#mPlayerActions.show{opacity:1;pointer-events:auto}#mPlayerActions button,#mTouchLock button,#mResumePrompt button{min-height:44px;padding:10px 16px;border:1px solid #ffffff30;border-radius:13px;background:#090c12ed;color:#f4f5ff;font:14px system-ui,sans-serif}#mTouchLock{position:fixed;inset:0;z-index:200020;touch-action:none;background:transparent}#mTouchLock[hidden],#mResumePrompt[hidden]{display:none!important}#mTouchUnlock{position:absolute;left:calc(env(safe-area-inset-left,0px) + 16px);top:50%;transform:translateY(-50%);min-width:82px;box-shadow:0 4px 22px #0008;opacity:0;visibility:hidden;pointer-events:none;transition:opacity .18s,visibility .18s}#mTouchLock.show-controls #mTouchUnlock{opacity:1;visibility:visible;pointer-events:auto}#mTouchLockHint{position:absolute;left:14px;right:14px;top:calc(50% + 50px);text-align:center;color:#eee;text-shadow:0 1px 5px #000;font:12px system-ui,sans-serif;pointer-events:none;opacity:0;visibility:hidden;transition:opacity .18s,visibility .18s}#mTouchLock.show-hint #mTouchLockHint{opacity:1;visibility:visible}body.m-touch-locked #mTop,body.m-touch-locked #mPlayerActions,body.m-touch-locked .art-bottom,body.m-touch-locked .art-settings,body.m-touch-locked .art-state{opacity:0!important;pointer-events:none!important}#mResumePrompt{position:fixed;inset:0;z-index:200010;display:grid;grid-template-columns:minmax(0,1fr);place-items:center;box-sizing:border-box;min-width:0;background:#000b;padding:calc(env(safe-area-inset-top,0px) + 18px) calc(env(safe-area-inset-right,0px) + 18px) calc(env(safe-area-inset-bottom,0px) + 18px) calc(env(safe-area-inset-left,0px) + 18px);font:14px system-ui,sans-serif}#mResumeCard{width:100%;max-width:430px;min-width:0;box-sizing:border-box;max-height:100%;overflow-y:auto;padding:20px;border:1px solid #ffffff25;border-radius:20px;background:#111622;color:#eef2ff;box-shadow:0 20px 80px #0009}#mResumeCard h2{margin:0 0 12px;font-size:18px}#mResumeName{min-width:0;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#aab5ce;font-size:12px}#mResumePosition{margin:16px 0;font-size:16px}#mResumeActions{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}#mResumeActions button{min-width:0;padding:10px 6px;white-space:normal;overflow-wrap:anywhere}#mResumeContinue{background:#7553cc!important}#mPlaybackNotice{position:fixed;z-index:200030;left:50%;top:42%;transform:translate(-50%,-50%);max-width:80vw;padding:14px 20px;border:1px solid #ffffff28;border-radius:15px;background:#0c101bed;color:#fff;pointer-events:none;text-align:center;white-space:pre-line;font:15px system-ui,sans-serif}#mPlaybackNotice[hidden]{display:none!important}body.m-resume-choice #mTop,body.m-resume-choice #mPlayerActions{pointer-events:none!important}";
    document.head.appendChild(style);
    actions = node("div"); actions.id = "mPlayerActions";
    actions.appendChild(button("锁定", "mTouchLockButton", lock));
    actions.appendChild(button("适应", "mFitButton", function () { setFit(fit === "contain" ? "cover" : "contain"); }));
    document.body.appendChild(actions);
    shield = node("div"); shield.id = "mTouchLock"; shield.hidden = true;
    shield.setAttribute("role", "region"); shield.setAttribute("aria-label", "播放触摸已锁定");
    shield.appendChild(button("解锁", "mTouchUnlock", function () {
      if (shield.classList.contains("show-controls")) unlock();
    }));
    var hint = node("div", "", "已锁定，轻点画面显示解锁按钮"); hint.id = "mTouchLockHint"; shield.appendChild(hint);
    ["touchstart", "touchmove", "touchend", "touchcancel", "click", "dblclick", "contextmenu"].forEach(function (type) {
      shield.addEventListener(type, function (event) {
        if (shield.classList.contains("show-controls") && event.target.closest("#mTouchUnlock")) return;
        event.preventDefault(); event.stopImmediatePropagation();
        if (type === "touchstart") {
          lockTouch = event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY, time: Date.now(), moved: false } : null;
        } else if (type === "touchmove" && lockTouch) {
          if (event.touches.length !== 1 || Math.hypot(event.touches[0].clientX - lockTouch.x, event.touches[0].clientY - lockTouch.y) > 12) lockTouch.moved = true;
        } else if (type === "touchend") {
          if (lockTouch && !lockTouch.moved && Date.now() - lockTouch.time < 350) showLockControls(false);
          lockTouch = null;
        } else if (type === "touchcancel") lockTouch = null;
        else if (type === "click") showLockControls(false);
      }, { passive: false });
    });
    document.body.appendChild(shield);
    prompt = node("div"); prompt.id = "mResumePrompt"; prompt.hidden = true;
    prompt.setAttribute("role", "dialog"); prompt.setAttribute("aria-modal", "true"); prompt.setAttribute("aria-labelledby", "mResumeTitle");
    var card = node("div"); card.id = "mResumeCard";
    var heading = node("h2", "", "继续上次播放？"); heading.id = "mResumeTitle";
    var name = node("div"); name.id = "mResumeName";
    var position = node("div"); position.id = "mResumePosition";
    var choices = node("div"); choices.id = "mResumeActions";
    choices.appendChild(button("从头播放", "mResumeRestart", function () { chooseResume(false); }));
    choices.appendChild(button("继续播放", "mResumeContinue", function () { chooseResume(true); }));
    choices.appendChild(button("取消", "mResumeCancel", function () {
      stopResumeCountdown(); // 点任何按钮都立刻停表，不能再在用户离开后被自动继续
      if (window.AndroidPlayback) window.AndroidPlayback.exit();
    }));
    card.append(heading, name, position, choices); prompt.appendChild(card); document.body.appendChild(prompt);
    notice = node("div"); notice.id = "mPlaybackNotice"; notice.hidden = true; notice.setAttribute("role", "status"); document.body.appendChild(notice);
    document.addEventListener("visibilitychange", function () { if (document.hidden) pauseFor("background"); });
    window.addEventListener("pagehide", savePosition);
  }
  function time(value) {
    var seconds = Math.max(0, Math.floor(Number(value) || 0));
    var hours = Math.floor(seconds / 3600); var minutes = Math.floor(seconds % 3600 / 60);
    return (hours ? hours + ":" + String(minutes).padStart(2, "0") : String(minutes)) + ":" + String(seconds % 60).padStart(2, "0");
  }
  function notify(message, duration) {
    ensure(); clearTimeout(noticeTimer); notice.textContent = message; notice.hidden = false;
    noticeTimer = setTimeout(function () { notice.hidden = true; }, duration || 1500);
  }
  function abandonFocus() {
    try { if (window.AndroidPlaybackAudio) window.AndroidPlaybackAudio.abandonFocus(); } catch (error) {}
  }
  function savePosition() {
    if (!ready || !path || !owner || !owner.video || pendingResume) return;
    var video = owner.video;
    if (video.readyState >= 1 && !video.seeking) store.save(path, video.currentTime, video.duration);
  }
  function hideResume() {
    stopResumeCountdown(); // 统一在这里停表并复位按钮文案：换片 begin()/退出 finish()/选完 chooseResume() 都走这里
    pendingResume = null; if (prompt) prompt.hidden = true;
    document.body.classList.remove("m-resume-choice");
  }
  function resumeContinueButton() { return document.getElementById("mResumeContinue"); }
  function paintResumeCountdown() {
    var control = resumeContinueButton();
    if (control) control.textContent = resumeRemaining > 0 ? "继续播放（" + resumeRemaining + "）" : "继续播放";
  }
  function stopResumeCountdown() {
    if (resumeTimer !== null) { clearTimeout(resumeTimer); resumeTimer = null; }
    resumeRemaining = 0;
    paintResumeCountdown();
  }
  function tickResumeCountdown() {
    resumeTimer = null;
    if (!pendingResume) return; // 卡片已被收起：兜底，不再自动继续
    resumeRemaining -= 1;
    if (resumeRemaining > 0) {
      paintResumeCountdown();
      resumeTimer = setTimeout(tickResumeCountdown, 1000);
      return;
    }
    // 先停表再执行「继续播放」：chooseResume 会同步调用 hideResume，那里再清一次是无害的重入
    stopResumeCountdown();
    chooseResume(true);
  }
  function startResumeCountdown() {
    stopResumeCountdown();
    resumeRemaining = Math.max(1, Math.ceil(RESUME_COUNTDOWN_SEC));
    paintResumeCountdown();
    resumeTimer = setTimeout(tickResumeCountdown, 1000);
  }
  function begin(nextPath) {
    ensure(); savePosition(); abandonFocus(); unlock(false); hideResume(); // hideResume 顺带清掉上一部片的续播倒计时
    path = nextPath; ready = false; lastSave = 0; fit = "contain"; playAllowed = true;
    decisionMade = !store.get(path);
    actions.classList.remove("show"); setFit("contain", true);
    clearTimeout(noticeTimer); notice.hidden = true;
  }
  function finish() {
    savePosition(); abandonFocus(); ready = false; path = ""; decisionMade = true; playAllowed = false;
    hideResume(); // 退出播放后旧倒计时不能再把下一部片的续播卡点掉
    unlock(false); if (actions) actions.classList.remove("show");
    clearTimeout(noticeTimer); if (notice) notice.hidden = true;
  }
  function chooseResume(resume) {
    if (!owner || !pendingResume) return;
    var saved = pendingResume; decisionMade = true; hideResume();
    if (!resume) store.remove(path);
    owner.currentTime = resume ? saved.position : 0;
    Promise.resolve(owner.play()).catch(function () {});
    owner.controls.show = true;
  }
  function onReady() {
    if (!owner || !path) return;
    ensure();
    if (ready) return;
    ready = true; setFit(fit, true);
    if (!decisionMade) {
      var saved = store.get(path, owner.video.duration);
      if (saved) {
        pendingResume = saved; owner.pause();
        document.getElementById("mResumeName").textContent = path.split("/").pop();
        document.getElementById("mResumePosition").textContent = "上次看到 " + time(saved.position) + " / " + time(owner.video.duration);
        prompt.hidden = false; document.body.classList.add("m-resume-choice");
        startResumeCountdown(); // 3 秒内不操作就当用户选择继续看（视频此刻是 pause 的，必须真的 play 起来）
        onControls(false); return;
      }
      decisionMade = true;
      Promise.resolve(owner.play()).catch(function () {});
    }
    onControls(owner.controls.show);
  }
  function onControls(show) {
    if (!actions) return;
    actions.classList.toggle("show", !!show && ready && !locked && !pendingResume && !!path && !document.querySelector(".mDanControls.is-config-open"));
  }
  function hideLockControls() {
    if (!shield) return;
    shield.classList.remove("show-controls", "show-hint");
    var control = document.getElementById("mTouchUnlock");
    control.setAttribute("aria-hidden", "true"); control.tabIndex = -1;
  }
  function showLockControls(withHint) {
    if (!locked || !shield) return;
    clearTimeout(lockControlsTimer);
    shield.classList.add("show-controls");
    shield.classList.toggle("show-hint", !!withHint);
    var control = document.getElementById("mTouchUnlock");
    control.setAttribute("aria-hidden", "false"); control.tabIndex = 0;
    lockControlsTimer = setTimeout(hideLockControls, 2000);
  }
  function lock() {
    if (!owner || !ready || pendingResume) return;
    ensure(); locked = true; shield.hidden = false; document.body.classList.add("m-touch-locked");
    showLockControls(true);
    window.dispatchEvent(new Event("android-touch-lock"));
    owner.controls.show = false; onControls(false); window.AndroidGestures.setActive(false);
  }
  function unlock(showControls) {
    clearTimeout(lockControlsTimer); lockControlsTimer = null; lockTouch = null;
    hideLockControls();
    var wasLocked = locked; locked = false; if (shield) shield.hidden = true;
    document.body.classList.remove("m-touch-locked");
    if (wasLocked && ready && path) {
      window.AndroidGestures.setActive(true);
      if (showControls !== false && owner) owner.controls.show = true;
    }
  }
  function setFit(value, quiet) {
    fit = value === "cover" ? "cover" : "contain";
    if (owner && owner.video) owner.video.style.objectFit = fit;
    if (actions) {
      var control = document.getElementById("mFitButton");
      control.textContent = fit === "cover" ? "裁剪" : "适应";
      control.title = fit === "cover" ? "切换为完整适应画面" : "切换为裁剪填满画面";
      control.setAttribute("aria-label", control.title);
    }
    if (!quiet) notify(fit === "cover" ? "裁剪填满 · 保持比例" : "完整适应 · 保持比例");
  }
  function seekBy(seconds) {
    if (!owner || !ready || locked || pendingResume || !path || !Number.isFinite(owner.duration) || owner.duration <= 0) return false;
    var next = Math.max(0, Math.min(owner.duration - 0.05, owner.currentTime + seconds));
    owner.currentTime = next;
    notify((seconds > 0 ? "快进 " : "后退 ") + Math.abs(seconds) + " 秒\n" + time(next) + " / " + time(owner.duration), 850);
    return true;
  }
  function pauseFor(reason) {
    if (!owner || !path) { abandonFocus(); return; }
    var wasPlaying = !owner.video.paused;
    playAllowed = false;
    owner.pause(); savePosition(); abandonFocus();
    if (wasPlaying && reason !== "background") notify(reason === "headphones-disconnected" ? "耳机已断开，已暂停" : "其他音频需要播放，视频已暂停");
  }
  function handleBack() {
    if (locked) { unlock(); return true; }
    if (pendingResume) { if (window.AndroidPlayback) window.AndroidPlayback.exit(); return true; }
    return false;
  }
  function attach(art) {
    if (owner === art) return;
    owner = art; ensure();
    var video = art.video; video.preload = "auto";
    var nativePlay = video.play.bind(video);
    video.play = function () {
      if (!path || document.hidden) return Promise.reject(new DOMException("Playback is not active", "AbortError"));
      if (!decisionMade) return Promise.resolve();
      playAllowed = true;
      if (window.AndroidPlaybackAudio) {
        var granted = false;
        try { granted = window.AndroidPlaybackAudio.requestFocus(); } catch (error) {}
        if (!granted) {
          notify("暂时无法获得音频焦点，请稍后再播放");
          return Promise.reject(new DOMException("Audio focus denied", "NotAllowedError"));
        }
      }
      return nativePlay().catch(function (error) { playAllowed = false; abandonFocus(); throw error; });
    };
    art.on("video:pause", function () { playAllowed = false; savePosition(); abandonFocus(); });
    art.on("video:play", function () { if (!playAllowed || !decisionMade || pendingResume) { owner.pause(); } });
    art.on("video:timeupdate", function () { if (Date.now() - lastSave > 5000) { savePosition(); lastSave = Date.now(); } });
    art.on("video:seeked", savePosition);
    art.on("video:ended", function () { if (path) store.remove(path); abandonFocus(); });
    art.on("destroy", function () { finish(); owner = null; video.play = nativePlay; });
  }
  window.AndroidPlaybackAudioEvent = pauseFor;
  window.AndroidPlayerTools = {
    attach: attach, begin: begin, ready: onReady, finish: finish, onControls: onControls,
    lock: lock, unlock: unlock, back: handleBack, seekBy: seekBy, setFit: setFit,
    save: savePosition, pauseFor: pauseFor,
    get locked() { return locked; }, get resumePending() { return !!pendingResume; }, get fit() { return fit; }
  };
})();
