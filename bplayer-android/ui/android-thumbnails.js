(function (root) {
  "use strict";

  var serial = 0;
  var session = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10) + "-";
  var queue = [];
  var cacheQueue = [];
  var active = null;
  var cacheActive = new Set();
  var tasks = new Map();
  var images = new Map();
  var failures = new Map();
  var observer = typeof root.IntersectionObserver === "function" ? new root.IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      var binding = images.get(entry.target);
      if (!binding) return;
      binding.visible = entry.isIntersecting && !(typeof document !== "undefined" && document.visibilityState === "hidden");
      if (binding.visible) load(binding);
      else if (binding.task) { binding.task.cancel(); binding.task = null; }
    });
  }, { rootMargin: "0px", threshold: 0.01 }) : null;

  function settle(task, result) {
    if (!tasks.has(task.id)) return;
    tasks.delete(task.id);
    clearTimeout(task.timer);
    queue = queue.filter(function (queued) { return queued !== task; });
    cacheQueue = cacheQueue.filter(function (queued) { return queued !== task; });
    if (active === task) active = null;
    cacheActive.delete(task);
    task.resolve(result || { image: null, status: "unavailable" });
    pump();
  }

  function cancel(id) {
    var task = tasks.get(String(id));
    if (!task) return;
    if ((active === task || cacheActive.has(task)) && root.AndroidThumbnails) {
      try { root.AndroidThumbnails.cancel(task.id); } catch (error) {}
    }
    settle(task, { image: null, status: "cancelled" });
  }

  function start(task, cached) {
    if (cached) cacheActive.add(task); else active = task;
    if (!root.AndroidThumbnails || typeof root.AndroidThumbnails.request !== "function") {
      settle(task); return;
    }
    task.timer = setTimeout(function () { cancel(task.id); }, cached ? 2000 : 6500);
    try {
      if (task.command === "store") root.AndroidThumbnails.store(task.id, JSON.stringify(task.args));
      else root.AndroidThumbnails.request(task.id, "get", JSON.stringify(task.args));
    }
    catch (error) { settle(task); }
  }

  function pump() {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    while (cacheActive.size < 4 && cacheQueue.length) start(cacheQueue.shift(), true);
    if (active || !queue.length) return;
    queue.sort(function (left, right) { return right.priority - left.priority || left.order - right.order; });
    start(queue.shift(), false);
  }

  function request(path, stat, visible, captured) {
    var id = session + String(++serial);
    var resolve;
    var promise = new Promise(function (done) { resolve = done; });
    var task = { id: id, order: serial, priority: visible ? 10 : 0, resolve: resolve, timer: null,
      command: captured ? "store" : "get",
      args: { path: String(path || ""), cacheOnly: !!captured || !!(stat && stat.cacheOnly) } };
    if (captured) task.args.image = captured;
    if (stat && Number.isSafeInteger(stat.size) && stat.size >= 0) task.args.size = stat.size;
    if (stat && Number.isSafeInteger(stat.modified_ms) && stat.modified_ms >= 0) task.args.modified_ms = stat.modified_ms;
    tasks.set(id, task);
    if (typeof document !== "undefined" && document.visibilityState === "hidden") settle(task, { image: null, status: "cancelled" });
    else if (queue.length + cacheQueue.length >= 48) settle(task, { image: null, status: "busy" });
    else { (task.args.cacheOnly ? cacheQueue : queue).push(task); pump(); }
    return { id: id, promise: promise, cancel: function () { cancel(id); } };
  }

  function capture(video, path, stat) {
    if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight || !stat || !Number.isSafeInteger(stat.size) || stat.size <= 0) return null;
    if (!root.AndroidThumbnails || typeof root.AndroidThumbnails.store !== "function") return null;
    try {
      var scale = Math.min(1, 320 / Math.max(video.videoWidth, video.videoHeight));
      var canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      var context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      var pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      var total = 0, dark = 0, count = pixels.length / 4;
      for (var index = 0; index < pixels.length; index += 4) {
        var luminance = (54 * pixels[index] + 183 * pixels[index + 1] + 19 * pixels[index + 2]) / 256;
        total += luminance; if (luminance <= 12) dark++;
      }
      if (total <= count * 8 && dark * 100 >= count * 98) return null;
      var image = canvas.toDataURL("image/jpeg", 0.75);
      if (image.length > 350000) return null;
      return request(path, stat, true, image);
    } catch (error) { return null; }
  }

  function inViewport(image) {
    var rect = image.getBoundingClientRect();
    return rect.bottom > 0 && rect.right > 0 && rect.top < (root.innerHeight || document.documentElement.clientHeight) && rect.left < (root.innerWidth || document.documentElement.clientWidth);
  }

  function handleVisibility() {
    if (document.visibilityState === "hidden") {
      Array.from(images.values()).forEach(function (binding) {
        binding.visible = false;
        if (binding.task) { var task = binding.task; binding.task = null; task.cancel(); }
      });
      Array.from(tasks.keys()).forEach(cancel);
      return;
    }
    Array.from(images.values()).forEach(function (binding) {
      if (!images.has(binding.image)) return;
      binding.visible = false;
      if (observer) { observer.unobserve(binding.image); observer.observe(binding.image); }
      else { binding.visible = inViewport(binding.image); if (binding.visible && !binding.ready) load(binding); }
    });
  }

  root.__aThumbnailReply = function (id, envelope) {
    var task = tasks.get(String(id));
    if (!task) return;
    settle(task, envelope && envelope.ok ? envelope.result : null);
  };

  function key(binding) {
    return JSON.stringify([binding.path, binding.stat.size, binding.stat.modified_ms]);
  }

  function fetchBinding(binding, cacheOnly) {
    var args = Object.assign({}, binding.stat, { cacheOnly: cacheOnly });
    var task = request(binding.path, args, true);
    binding.task = task;
    task.promise.then(function (result) {
      if (binding.task !== task || !binding.visible || images.get(binding.image) !== binding) return;
      binding.task = null;
      if (result && typeof result.image === "string" && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(result.image) && result.image.length <= 350000) {
        failures.delete(key(binding));
        binding.ready = true;
        binding.image.src = result.image;
        binding.image.classList.add("thumbnail-ready");
      } else if (cacheOnly && !binding.stat.cacheOnly && result && result.status !== "cancelled" && result.status !== "busy") {
        if ((failures.get(key(binding)) || 0) <= Date.now()) fetchBinding(binding, false);
      } else if (!cacheOnly && result && result.status !== "cancelled" && result.status !== "busy") {
        failures.delete(key(binding)); failures.set(key(binding), Date.now() + 60000);
        if (failures.size > 128) failures.delete(failures.keys().next().value);
      }
    });
  }

  function load(binding) {
    if (!binding.visible || binding.task || binding.ready || !images.has(binding.image)) return;
    fetchBinding(binding, true);
  }

  function unobserve(image) {
    var binding = images.get(image);
    if (!binding) return;
    images.delete(image);
    if (observer) observer.unobserve(image);
    if (binding.task) binding.task.cancel();
  }

  function observe(image, path, stat) {
    unobserve(image);
    image.classList.remove("thumbnail-ready");
    image.removeAttribute("src");
    var binding = { image: image, path: path, stat: stat || {}, visible: false, ready: false, task: null };
    images.set(image, binding);
    if (observer) observer.observe(image);
    return function () { if (images.get(image) === binding) unobserve(image); };
  }

  function clear(container) {
    Array.from(images.keys()).forEach(function (image) {
      if (!container || image === container || container.contains(image)) unobserve(image);
    });
  }

  root.AndroidThumbnailsView = { observe: observe, request: request, capture: capture, cancel: cancel, clear: clear,
    get stats() { return { queued: queue.length, cacheQueued: cacheQueue.length, active: !!active, cacheActive: cacheActive.size }; } };
  if (typeof document !== "undefined" && document.addEventListener) document.addEventListener("visibilitychange", handleVisibility);
  if (root.addEventListener) {
    root.addEventListener("pageshow", handleVisibility);
    root.addEventListener("pagehide", function () {
      Array.from(images.values()).forEach(function (binding) {
        binding.visible = false;
        if (binding.task) { var task = binding.task; binding.task = null; task.cancel(); }
      });
      Array.from(tasks.keys()).forEach(cancel);
    });
  }
})(typeof window !== "undefined" ? window : globalThis);
