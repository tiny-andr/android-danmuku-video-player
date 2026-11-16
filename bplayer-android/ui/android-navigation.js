(function () {
  "use strict";

  var layers = Object.create(null);
  var stack = [];
  var caller = null;
  var version = 0;
  var pending = null;

  function register(id, show, hide, onClose) {
    layers[id] = { show: show, hide: hide, onClose: onClose };
  }
  function clear() {
    stack = [];
    Object.keys(layers).forEach(function (id) { layers[id].hide(); });
  }
  function open(id) {
    if (!layers[id]) return;
    invalidate();
    if (caller && stack[stack.length - 1] === caller && caller !== id) {
      layers[caller].hide();
      stack.push(id);
    } else {
      clear();
      stack.push(id);
    }
    layers[id].show();
  }
  function close(id) {
    if (!stack.length || (id && stack[stack.length - 1] !== id)) return false;
    var current = stack.pop();
    layers[current].hide();
    if (stack.length) layers[stack[stack.length - 1]].show();
    if (layers[current].onClose) layers[current].onClose();
    return true;
  }
  function forward(action) {
    var previous = caller;
    caller = stack[stack.length - 1] || null;
    try { action(); } finally { caller = previous; }
  }
  function invalidate() {
    version++;
    pending = null;
  }
  function task(cancel) {
    invalidate();
    var ticket = version;
    var entry = { cancel: cancel };
    pending = entry;
    return {
      valid: function () { return ticket === version; },
      finish: function () { if (pending === entry) pending = null; }
    };
  }
  function cancelPending() {
    if (!pending) return false;
    var entry = pending;
    invalidate(); entry.cancel();
    return true;
  }
  function captureScroll(container) {
    if (!container) return null;
    var top = container.getBoundingClientRect().top;
    var anchor = Array.from(container.querySelectorAll('[data-path]')).find(function (row) {
      return row.getBoundingClientRect().bottom > top;
    });
    return { scrollTop: container.scrollTop, path: anchor ? anchor.dataset.path : '', offset: anchor ? anchor.getBoundingClientRect().top - top : 0 };
  }
  function restoreScroll(container, position) {
    if (!container || !position) return;
    var anchor = Array.from(container.querySelectorAll('[data-path]')).find(function (row) { return row.dataset.path === position.path; });
    container.scrollTop = position.scrollTop || 0;
    if (anchor) container.scrollTop += anchor.getBoundingClientRect().top - container.getBoundingClientRect().top - position.offset;
  }

  window.AndroidNavigation = {
    register: register, open: open, close: close, clear: clear, forward: forward,
    invalidate: invalidate, task: task, cancelPending: cancelPending,
    captureScroll: captureScroll, restoreScroll: restoreScroll,
    get top() { return stack[stack.length - 1] || null; }
  };
})();
