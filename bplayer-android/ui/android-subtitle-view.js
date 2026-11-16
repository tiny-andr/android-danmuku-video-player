(function (root) {
  "use strict";

  function placement(options) {
    var width = options.width, height = options.height;
    var box = options.video;
    var drawWidth = box.width, drawHeight = box.height;
    if (options.videoWidth > 0 && options.videoHeight > 0 && options.fit !== "fill") {
      var scale = (options.fit === "cover" ? Math.max : Math.min)(box.width / options.videoWidth, box.height / options.videoHeight);
      if (options.fit === "none") scale = 1;
      if (options.fit === "scale-down") scale = Math.min(1, scale);
      drawWidth = options.videoWidth * scale; drawHeight = options.videoHeight * scale;
    }
    var left = Math.max(0, box.x + (box.width - drawWidth) / 2);
    var right = Math.min(width, box.x + (box.width + drawWidth) / 2);
    var top = Math.max(0, box.y + (box.height - drawHeight) / 2);
    var bottom = Math.min(height, box.y + (box.height + drawHeight) / 2);
    var limit = Math.max(0, height - (options.controls || 0) - 12);
    var textHeight = options.textHeight || 26;
    var below = options.position === "below" && bottom + 8 + textHeight <= limit;
    var anchor = below ? bottom + 8 + textHeight : Math.min(bottom - 12, limit);
    return { left: left, width: Math.max(0, right - left), bottom: Math.max(12, height - Math.max(top, anchor)),
      maxHeight: Math.max(0, (below ? textHeight : anchor - top - 12)), position: below ? "below" : "inside" };
  }

  function create(art) {
    var video = art.video;
    var container = art.template.$subtitle;
    var current = null;
    var pending = null;
    var offset = 0;
    var lastText = "";
    var disposed = false;
    var frame = null;
    var position = "inside";
    var host = art.template.$player;
    var observer = null;
    var mutation = null;

    function layout() {
      if (disposed || !host || !host.getBoundingClientRect || !video.getBoundingClientRect) return;
      var bounds = host.getBoundingClientRect(), media = video.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      var style = root.getComputedStyle(video);
      var controls = art.controls && art.controls.show ? parseFloat(root.getComputedStyle(document.documentElement).getPropertyValue("--m-controls-height")) || 76 : 0;
      var result = placement({ width: bounds.width, height: bounds.height,
        video: { x: media.left - bounds.left, y: media.top - bounds.top, width: media.width, height: media.height },
        videoWidth: video.videoWidth, videoHeight: video.videoHeight, fit: style.objectFit || "contain",
        position: position, controls: controls, textHeight: container.scrollHeight });
      art.subtitle.style({ position: "absolute", top: "auto", left: result.left + "px", right: "auto", width: result.width + "px",
        bottom: result.bottom + "px", maxHeight: result.maxHeight + "px", transform: "none", transition: "none" });
    }
    if (root.ResizeObserver && host) {
      observer = new root.ResizeObserver(layout);
      observer.observe(host); observer.observe(video); observer.observe(container);
    }
    if (root.MutationObserver) {
      mutation = new root.MutationObserver(layout); mutation.observe(video, { attributes: true, attributeFilter: ["style", "class"] });
    }
    if (root.addEventListener) root.addEventListener("resize", layout);
    if (art.on) { art.on("control", layout); art.on("resize", layout); }
    ["loadedmetadata", "resize"].forEach(function (name) { video.addEventListener(name, layout); });

    function remove(entry) {
      if (!entry) return;
      clearTimeout(entry.timer);
      entry.node.remove(); URL.revokeObjectURL(entry.url);
    }
    function paint() {
      if (disposed) return;
      var time = Number(video.currentTime) - offset;
      var visible = [];
      if (current) {
        var low = 0, high = current.cues.length;
        while (low < high) {
          var middle = Math.floor((low + high) / 2);
          if (current.cues[middle].startTime <= time) low = middle + 1; else high = middle;
        }
        for (var index = low - 1; index >= 0 && current.ends[index] > time; index--) {
          if (current.cues[index].endTime > time) visible.push(root.AndroidSidecars.cueText(current.cues[index].text));
        }
      }
      var text = visible.reverse().join("\n");
      if (text !== lastText) { container.textContent = text; lastText = text; layout(); }
    }
    function stopFrames() {
      if (frame != null && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frame);
      frame = null;
    }
    function frames() {
      if (disposed || !current || video.paused || !video.requestVideoFrameCallback || frame != null) return;
      frame = video.requestVideoFrameCallback(function () { frame = null; paint(); frames(); });
    }
    function cancelPending() {
      if (!pending) return;
      var entry = pending; pending = null;
      remove(entry); entry.reject(new DOMException("Subtitle selection changed", "AbortError"));
    }
    function load(vtt, valid) {
      cancelPending();
      return new Promise(function (resolve, reject) {
        if (disposed || !valid()) { reject(new DOMException("Subtitle selection changed", "AbortError")); return; }
        var url = URL.createObjectURL(new Blob([vtt], { type: "text/vtt;charset=utf-8" }));
        var node = document.createElement("track");
        node.kind = "subtitles"; node.label = "Bplayer text subtitles"; node.src = url;
        var entry = { node: node, url: url, reject: reject, timer: null, cues: [] };
        pending = entry;
        function failed(error) {
          if (pending !== entry) return;
          pending = null; remove(entry); reject(error);
        }
        node.addEventListener("error", function () { failed(new Error("字幕解析失败，请检查文件格式")); });
        node.addEventListener("load", function () {
          if (pending !== entry) return;
          if (!valid() || disposed) { failed(new DOMException("Subtitle selection changed", "AbortError")); return; }
          entry.cues = Array.from(node.track.cues || []).sort(function (left, right) { return left.startTime - right.startTime; });
          var end = 0;
          entry.ends = entry.cues.map(function (cue) { end = Math.max(end, cue.endTime); return end; });
          if (!entry.cues.length) { failed(new Error("字幕没有可显示的文本")); return; }
          clearTimeout(entry.timer); pending = null;
          remove(current); current = entry;
          node.track.mode = "disabled";
          art.subtitle.style({ display: "block", whiteSpace: "pre-line" });
          paint(); frames(); resolve(entry.cues.length);
        });
        entry.timer = setTimeout(function () { failed(new Error("字幕载入超时")); }, 8000);
        video.appendChild(node); node.track.mode = "hidden";
      });
    }
    function clear() {
      cancelPending(); remove(current); current = null;
      stopFrames(); lastText = ""; container.textContent = "";
    }
    function setOffset(value) {
      offset = Math.max(-10, Math.min(10, Number(value) || 0)); paint();
    }
    function update() { paint(); frames(); }
    ["timeupdate", "seeked", "play"].forEach(function (name) { video.addEventListener(name, update); });
    video.addEventListener("pause", stopFrames);
    return {
      load: load, cancelPending: cancelPending, clear: clear, setOffset: setOffset,
      setPosition: function (value) { position = value === "below" ? "below" : "inside"; layout(); },
      dispose: function () {
        clear(); disposed = true;
        if (observer) observer.disconnect();
        if (mutation) mutation.disconnect();
        if (root.removeEventListener) root.removeEventListener("resize", layout);
        if (art.off) { art.off("control", layout); art.off("resize", layout); }
        ["loadedmetadata", "resize"].forEach(function (name) { video.removeEventListener(name, layout); });
        ["timeupdate", "seeked", "play"].forEach(function (name) { video.removeEventListener(name, update); });
        video.removeEventListener("pause", stopFrames);
      },
      get offset() { return offset; }, get count() { return current ? current.cues.length : 0; }
    };
  }
  root.AndroidSubtitleView = { create: create, placement: placement };
})(typeof window !== "undefined" ? window : globalThis);
