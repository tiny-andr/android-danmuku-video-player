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
  // 清空整栈。栈内的层必须按「出栈逆序」补上 close() 会做的那套 hide() + onClose()：
  // clear() 吞掉 onClose 会漏收尾（playlist 唯一的 onClose 是 playlistClosed，漏掉就丢了
  // folderOrigin 的还原）。不在栈里的层照旧一律 hide()。
  // onClose 可能重入（playlistClosed 会读播放状态、还可能 open 回 playlist），所以：
  //   - 先把 stack 置空再逐个触发，重入时看到的就是「已经没有栈」；
  //   - 单个 onClose/hide 抛错只吞掉自己，绝不允许打断整轮清理。
  function clear() {
    var closing = stack.slice();
    stack = [];
    for (var i = closing.length - 1; i >= 0; i--) {
      var id = closing[i];
      var layer = layers[id];
      if (!layer) continue;
      try { layer.hide(); } catch (error) {}
      if (layer.onClose) { try { layer.onClose(); } catch (error) {} }
    }
    Object.keys(layers).forEach(function (id) {
      if (closing.indexOf(id) >= 0) return; // 栈内层已经在上面按序收过一遍
      try { layers[id].hide(); } catch (error) {}
    });
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
