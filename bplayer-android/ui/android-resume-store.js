(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AndroidResumeStore = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  var KEY = "bplayer.android.resume.v1";
  var MAX_ITEMS = 100;
  var MAX_AGE = 30 * 24 * 60 * 60 * 1000;

  function finite(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function normalize(path) {
    if (typeof path !== "string" || !path || /^\s*(https?|asset):/i.test(path)) return null;
    var normalized = path.replace(/\\/g, "/");
    if (!normalized.startsWith("/@network/")) normalized = normalized.replace(/^\/{2,}/, "/");
    return normalized;
  }

  function resumable(position, duration) {
    if (!finite(position) || !finite(duration) || duration <= 0 || position < 5) return false;
    return duration - position > Math.max(3, Math.min(15, duration * 0.03));
  }

  function create(storage, nowFn) {
    function now() {
      try {
        var value = typeof nowFn === "function" ? nowFn() : Date.now();
        if (finite(value) && value >= 0) return value;
      } catch (error) {}
      return Date.now();
    }

    function persist(items) {
      try { storage.setItem(KEY, JSON.stringify({ version: 1, items: items })); } catch (error) {}
    }

    function load(timestamp) {
      var data;
      try { data = JSON.parse(storage.getItem(KEY)); } catch (error) { return []; }
      if (!data || data.version !== 1 || !Array.isArray(data.items)) return [];
      var items = data.items.map(function (item) {
        if (!item || typeof item !== "object") return null;
        var path = normalize(item.path);
        if (!path || !resumable(item.position, item.duration) || !finite(item.updatedAt) || item.updatedAt < 0 ||
            item.updatedAt > timestamp || timestamp - item.updatedAt >= MAX_AGE) return null;
        return { path: path, position: item.position, duration: item.duration, updatedAt: item.updatedAt };
      }).filter(Boolean).sort(function (left, right) { return right.updatedAt - left.updatedAt; });
      var seen = new Set();
      items = items.filter(function (item) {
        if (seen.has(item.path)) return false;
        seen.add(item.path);
        return true;
      }).slice(0, MAX_ITEMS);
      if (JSON.stringify(items) !== JSON.stringify(data.items)) persist(items);
      return items;
    }

    function remove(path) {
      path = normalize(path);
      if (!path) return;
      var items = load(now());
      persist(items.filter(function (item) { return item.path !== path; }));
    }

    function get(path, currentDuration) {
      path = normalize(path);
      if (!path) return null;
      var items = load(now());
      var item = items.find(function (entry) { return entry.path === path; });
      if (!item) return null;
      if (currentDuration !== undefined) {
        if (!finite(currentDuration) || currentDuration <= 0) return null;
        if (Math.abs(currentDuration - item.duration) > Math.max(3, item.duration * 0.05)) {
          persist(items.filter(function (entry) { return entry.path !== path; }));
          return null;
        }
      }
      return { path: item.path, position: item.position, duration: item.duration, updatedAt: item.updatedAt };
    }

    function save(path, position, duration) {
      path = normalize(path);
      if (!path || !finite(position) || !finite(duration) || duration <= 0) return;
      var timestamp = now();
      var items = load(timestamp).filter(function (item) { return item.path !== path; });
      if (resumable(position, duration)) {
        items.unshift({ path: path, position: position, duration: duration, updatedAt: timestamp });
      }
      persist(items.slice(0, MAX_ITEMS));
    }

    return { get: get, save: save, remove: remove };
  }

  return { create: create };
});
