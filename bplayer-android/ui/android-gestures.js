(function () {
  "use strict";

  var active = false;
  var owner = null;
  var gesture = null;
  var hud = null;
  var hideTimer = null;
  var frame = null;
  var nextValue = null;
  var suppressClickUntil = 0;
  var tap = null;

  function clearTap() {
    if (tap) clearTimeout(tap.timer);
    tap = null;
  }

  function ensureHud() {
    if (hud) return;
    var style = document.createElement("style");
    style.textContent = "#mGestureHud{position:fixed;z-index:100030;left:50%;top:50%;transform:translate(-50%,-50%);min-width:160px;max-width:70vw;padding:18px 22px;border:1px solid #ffffff33;border-radius:18px;background:#10131ee8;color:#fff;text-align:center;pointer-events:none;font:15px system-ui,sans-serif;box-shadow:0 10px 40px #0008}#mGestureHud[hidden]{display:none!important}#mGestureHud strong{display:block;font-size:24px;margin:5px 0 10px}#mGestureHud progress{width:100%;height:5px;accent-color:#b28bff}";
    document.head.appendChild(style);
    hud = document.createElement("div"); hud.id = "mGestureHud"; hud.hidden = true;
    hud.setAttribute("role", "status");
    hud.innerHTML = '<span></span><strong></strong><progress max="100"></progress>';
    document.body.appendChild(hud);
  }
  function show(kind, value) {
    ensureHud(); clearTimeout(hideTimer); hud.hidden = false;
    hud.querySelector("span").textContent = kind === "brightness" ? "☀ 屏幕亮度" : "♫ 媒体音量";
    hud.querySelector("strong").textContent = value + "%";
    hud.querySelector("progress").value = value;
  }
  function flush() {
    frame = null;
    if (!active || !nextValue || !window.AndroidUI) return;
    var change = nextValue; nextValue = null;
    try {
      if (change.kind === "brightness") window.AndroidUI.setPlaybackBrightness(change.value);
      else window.AndroidUI.setPlaybackVolume(change.value);
    } catch (error) {}
  }
  function queue(kind, value) {
    nextValue = { kind: kind, value: value };
    if (frame == null) frame = requestAnimationFrame(flush);
  }
  function eligible(target, point) {
    if (!active || !owner || !window.AndroidUI) return false;
    if (window.AndroidPlayerTools && (window.AndroidPlayerTools.locked || window.AndroidPlayerTools.resumePending)) return false;
    if (document.querySelector('#settingsMask:not([hidden]),#mInfo:not([hidden]),#aFileMask:not([hidden]),#mResumePrompt:not([hidden]),.block-panel:not([hidden]),#playlist.open')) return false;
    if (target.closest('button,input,select,textarea,a,.art-controls,.art-settings,.art-contextmenus,#mTop,#mPlayerActions,.apd-config-panel')) return false;
    return point.clientY > 52 && point.clientY < innerHeight - 62 && point.clientX > 12 && point.clientX < innerWidth - 12;
  }
  function start(event) {
    gesture = null;
    if (event.touches.length !== 1 || !eligible(event.target, event.touches[0])) return;
    var state;
    try { state = JSON.parse(window.AndroidUI.getPlaybackControls()); } catch (error) { return; }
    var touch = event.touches[0];
    gesture = {
      id: touch.identifier, x: touch.clientX, y: touch.clientY, started: Date.now(),
      zone: touch.clientX < innerWidth * 0.4 ? "left" : touch.clientX > innerWidth * 0.6 ? "right" : "center",
      kind: touch.clientX < innerWidth / 2 ? "brightness" : "volume",
      brightness: Number(state.brightness), volume: Number(state.volume),
      max: Number(state.maxVolume), min: Number(state.minVolume) || 0,
      axis: "pending", last: null
    };
  }
  function move(event) {
    if (!gesture) return;
    if (event.touches.length !== 1) { end(); return; }
    var point = Array.from(event.touches).find(function (touch) { return touch.identifier === gesture.id; });
    if (!point) { end(); return; }
    var dx = point.clientX - gesture.x;
    var dy = gesture.y - point.clientY;
    if (gesture.axis === "pending") {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 12) return;
      gesture.axis = Math.abs(dy) > Math.abs(dx) * 1.2 ? "vertical" : "ignore";
    }
    if (gesture.axis !== "vertical") return;
    event.preventDefault(); event.stopImmediatePropagation();
    var delta = dy / Math.max(100, innerHeight * 0.72);
    var value;
    if (gesture.kind === "brightness") {
      value = Math.max(0.05, Math.min(1, gesture.brightness + delta));
      show("brightness", Math.round(value * 100));
    } else {
      value = Math.max(gesture.min, Math.min(gesture.max, Math.round(gesture.volume + delta * gesture.max)));
      show("volume", Math.round(value / gesture.max * 100));
    }
    if (value !== gesture.last) { queue(gesture.kind, value); gesture.last = value; }
  }
  function end(event) {
    if (!gesture) return;
    var finished = gesture;
    var handled = gesture.axis === "vertical";
    gesture = null;
    if (handled) {
      clearTap();
      if (frame != null) { cancelAnimationFrame(frame); frame = null; }
      flush(); suppressClickUntil = Date.now() + 400;
      if (event) { event.preventDefault(); event.stopImmediatePropagation(); }
      // 亮度/音量 HUD 的停留时间同样按 60% 缩短：700 → 420
      hideTimer = setTimeout(function () { if (hud) hud.hidden = true; }, 420);
    } else if (event && event.type === "touchend" && finished.axis === "pending" && finished.zone !== "center" && Date.now() - finished.started < 300) {
      event.preventDefault(); event.stopImmediatePropagation(); suppressClickUntil = Date.now() + 400;
      if (tap && tap.zone === finished.zone && Date.now() - tap.time < 320) {
        clearTap();
        if (window.AndroidPlayerTools) window.AndroidPlayerTools.seekBy(finished.zone === "left" ? -10 : 10);
      } else {
        clearTap();
        tap = { zone: finished.zone, time: Date.now(), timer: setTimeout(function () {
          tap = null;
          if (active && owner && !(window.AndroidPlayerTools && (window.AndroidPlayerTools.locked || window.AndroidPlayerTools.resumePending))) owner.controls.show = !owner.controls.show;
        }, 320) };
      }
    }
  }
  function click(event) {
    if (Date.now() < suppressClickUntil) { event.preventDefault(); event.stopImmediatePropagation(); }
  }
  function attach(art) {
    if (owner === art) return;
    owner = art;
    var stage = document.querySelector(".stage");
    if (!stage) return;
    stage.addEventListener("touchstart", start, { capture: true, passive: true });
    stage.addEventListener("touchmove", move, { capture: true, passive: false });
    stage.addEventListener("touchend", end, { capture: true, passive: false });
    stage.addEventListener("touchcancel", end, { capture: true, passive: false });
    stage.addEventListener("click", click, true);
    art.on("destroy", function () {
      stage.removeEventListener("touchstart", start, true); stage.removeEventListener("touchmove", move, true);
      stage.removeEventListener("touchend", end, true); stage.removeEventListener("touchcancel", end, true);
      stage.removeEventListener("click", click, true); owner = null; setActive(false);
    });
  }
  function setActive(value) {
    active = !!value;
    if (!active) {
      clearTap();
      gesture = null; nextValue = null; clearTimeout(hideTimer);
      if (frame != null) { cancelAnimationFrame(frame); frame = null; }
      if (hud) hud.hidden = true;
    }
  }
  window.AndroidGestures = { attach: attach, setActive: setActive };
})();
