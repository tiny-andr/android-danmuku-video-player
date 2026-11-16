(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AndroidFileOrder = api;
})(typeof window === "object" ? window : globalThis, function () {
  "use strict";
  var collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
  function extension(name) {
    var position = String(name || "").lastIndexOf(".");
    return position > 0 ? name.slice(position + 1).toLowerCase() : "";
  }
  function timestamp(entry) {
    var value = entry.modified_ms;
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
  }
  function sort(entries, key, descending) {
    var sign = descending ? -1 : 1;
    return entries.slice().sort(function (left, right) {
      var directory = Number(!!right.is_dir) - Number(!!left.is_dir);
      if (directory) return directory;
      if (key === "modified") {
        var leftTime = timestamp(left);
        var rightTime = timestamp(right);
        if (leftTime === null && rightTime !== null) return 1;
        if (leftTime !== null && rightTime === null) return -1;
        if (leftTime !== null && rightTime !== null && leftTime !== rightTime) return (leftTime - rightTime) * sign;
      }
      if (key === "type") {
        var type = collator.compare(extension(left.name), extension(right.name));
        if (type) return type * sign;
      }
      var name = collator.compare(left.name, right.name);
      return name * sign || collator.compare(left.path || "", right.path || "");
    });
  }
  return { sort: sort, timestamp: timestamp };
});
