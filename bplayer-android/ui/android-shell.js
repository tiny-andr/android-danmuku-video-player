/* Android 壳：
 * 1. 桌面版把选文件/选目录交给 invoke('pick_video'|'pick_folder')，Android 没有 rfd；
 *    这里用 Rust 的 list_dir 渲染触摸友好的文件浏览器，返回真实路径（asset 协议只认真实路径）。
 * 2. 界面按手机横屏重排：启动页 = 选片 + 最近播放；播放页 = 视频铺满 + 顶部悬浮条。
 * 3. 状态栏/刘海用 env(safe-area-inset-*) 动态让位；播放时通过 AndroidUI 隐藏系统栏。
 */
(function () {
  "use strict";

  // 本脚本先于 Tauri 注入 window.__TAURI__ 执行，统一在调用时再取。
  function origInvoke(cmd, args) {
    return window.__TAURI__.core.invoke(cmd, args);
  }

  var VIDEO_RE = /\.(mp4|m4v|webm|mov|mkv|avi|ts|flv|wmv|mpg|mpeg)$/i;
  var LAST_DIR_KEY = "bplayer.android.lastDir";
  var RECENT_KEY = "bplayer.android.recent.v1";

  var overlay = null;
  var resolver = null;
  var mode = "file";
  var cwd = "";
  var home = null;
  var topbar = null;
  var infoPanel = null;
  var playing = false;
  var hookedArt = null;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function fmtSize(n) {
    if (!n) return "";
    var u = ["B", "KB", "MB", "GB", "TB"];
    var i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return n.toFixed(n >= 10 || i === 0 ? 0 : 1) + " " + u[i];
  }

  /* ------------------------------------------------------------------ *
   * 全局样式（手机布局 / 安全区 / 播放页 / 播放列表 / 提示层级）
   * ------------------------------------------------------------------ */
  function injectBaseCss() {
    var css =
      "html,body{-webkit-tap-highlight-color:transparent;}" +

      /* ---- 启动页 ---- */
      "#mHome{position:fixed;inset:0;z-index:99900;display:flex;flex-direction:column;" +
      "padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) " +
      "env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px);" +
      "background:radial-gradient(900px 460px at 84% -12%, rgba(123,92,255,.24), transparent 62%)," +
      "radial-gradient(720px 420px at -10% 34%, rgba(251,114,153,.15), transparent 64%)," +
      "linear-gradient(160deg,#0f1118 0%,#0a0c11 100%);}" +
      "#mHome.hide{display:none;}" +
      ".mBody{flex:1;display:flex;gap:24px;padding:14px 26px;min-height:0;}" +
      ".mLeft{flex:1.15;min-width:0;display:flex;flex-direction:column;justify-content:center;gap:16px;}" +
      ".mBrand{display:flex;align-items:center;gap:14px;}" +
      ".mLogo{width:52px;height:52px;border-radius:15px;flex:none;display:flex;align-items:center;justify-content:center;" +
      "background:linear-gradient(135deg,#fb7299,#7b5cff);color:#fff;font-size:22px;" +
      "box-shadow:0 12px 30px -12px rgba(251,114,153,.65);}" +
      ".mBrand h1{margin:0;font-size:25px;letter-spacing:.5px;color:#f2f5ff;}" +
      ".mBrand p{margin:3px 0 0;font-size:12.5px;color:#8b95ab;}" +
      ".mHomeGear{margin-left:auto;flex:none;width:40px;height:40px;border-radius:50%;" +
      "border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.05);color:#aab3c6;" +
      "font-size:17px;font-family:inherit;}" +
      ".mHomeGear:active{background:rgba(251,114,153,.22);color:#fff;}" +
      ".mActions{display:flex;gap:12px;}" +
      ".mBtn{flex:1;min-width:0;min-height:66px;display:flex;flex-direction:column;justify-content:center;gap:3px;" +
      "padding:12px 16px;border-radius:14px;border:1px solid transparent;font-family:inherit;text-align:left;" +
      "cursor:pointer;color:#fff;transition:transform .12s;}" +
      ".mBtn:active{transform:scale(.985);}" +
      ".mBtn b{font-size:16px;font-weight:600;}" +
      ".mBtn small{font-size:11.5px;opacity:.78;line-height:1.3;}" +
      ".mPrimary{background:linear-gradient(135deg,#fb7299,#8a63ff);box-shadow:0 12px 26px -12px rgba(251,114,153,.6);}" +
      ".mSecondary{background:rgba(255,255,255,.055);border-color:rgba(255,255,255,.13);}" +
      ".mHint{margin:0;font-size:11px;color:#6d778c;line-height:1.65;}" +
      ".mRight{flex:1;max-width:44%;min-width:0;display:flex;flex-direction:column;" +
      "background:rgba(22,26,36,.74);border:1px solid rgba(255,255,255,.07);border-radius:16px;padding:12px 12px 8px;}" +
      ".mRightHead{display:flex;align-items:center;gap:8px;padding:0 4px 8px;}" +
      ".mRightHead h2{margin:0;flex:1;font-size:12.5px;font-weight:500;color:#8b95ab;letter-spacing:.3px;}" +
      "#mClearRecent{background:none;border:0;color:#5f6a7f;font-size:11px;padding:6px;}" +
      "#mClearRecent:active{color:#fb7299;}" +
      ".mRecentList{flex:1;overflow:auto;display:flex;flex-direction:column;gap:6px;min-height:0;}" +
      ".mRecentRow{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:11px;" +
      "background:rgba(255,255,255,.035);cursor:pointer;}" +
      ".mRecentRow:active{background:rgba(251,114,153,.13);}" +
      ".mRecentRow .ic{flex:none;width:32px;height:32px;border-radius:9px;background:#202a3d;" +
      "display:flex;align-items:center;justify-content:center;font-size:14px;}" +
      ".mRecentRow .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" +
      "font-size:12.5px;color:#dfe5f2;}" +
      ".mRecentRow .go{flex:none;font-size:11px;color:#7f8ba3;}" +
      ".mEmpty{color:#5f6a7f;font-size:11.5px;text-align:center;padding:22px 6px;line-height:1.7;}" +
      "@media (max-width:680px){.mRight{display:none;}.mBody{padding:12px 16px;}}" +
      /* 竖屏启动页：不再强制横屏，按钮在上、最近播放下 */
      "@media (orientation:portrait){#mHome .mBody{flex-direction:column;gap:14px;padding:10px 16px 12px;}" +
      "#mHome .mLeft{flex:none;justify-content:flex-start;gap:13px;}" +
      "#mHome .mRight{flex:0 1 auto;display:flex;max-width:none;max-height:44vh;min-height:120px;}" +
      "#mHome .mBrand h1{font-size:22px;}#mHome .mLogo{width:44px;height:44px;font-size:19px;}" +
      "#mHome .mBtn{min-height:58px;padding:10px 12px;}#mHome .mBtn b{font-size:15px;}}" +

      /* ---- 播放页顶部悬浮条 ---- */
      "#mTop{position:fixed;top:0;left:0;right:0;z-index:100000;display:flex;align-items:center;gap:10px;" +
      "padding:calc(env(safe-area-inset-top,0px) + 6px) calc(env(safe-area-inset-right,0px) + 12px) 24px " +
      "calc(env(safe-area-inset-left,0px) + 12px);" +
      "background:linear-gradient(rgba(0,0,0,.78) 0%,rgba(0,0,0,.34) 62%,transparent 100%);" +
      "opacity:0;transform:translateY(-10px);pointer-events:none;transition:opacity .2s,transform .2s;}" +
      "#mTop.show{opacity:1;transform:none;pointer-events:auto;}" +
      "#mTop .mIconBtn{flex:none;width:42px;height:42px;border-radius:50%;border:0;background:rgba(255,255,255,.12);" +
      "color:#fff;font-size:20px;line-height:42px;padding:0;font-family:inherit;}" +
      "#mTop .mIconBtn:active{background:rgba(255,255,255,.26);}" +
      "#mBack{font-size:27px;font-weight:300;line-height:38px;}" +
      "#mDanBtn{font-size:14px;opacity:.5;}" +
      "#mDanBtn.on{opacity:1;background:rgba(251,114,153,.85);}" +
      "#mInfoBtn{font-size:16px;font-family:Georgia,serif;font-style:italic;}" +
      ".mTitleBox{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;}" +
      "#mTitle{font-size:14px;font-weight:600;color:#fff;overflow:hidden;text-overflow:ellipsis;" +
      "white-space:nowrap;text-shadow:0 1px 6px rgba(0,0,0,.85);}" +
      "#mDan{font-size:11px;color:#a9ecc4;overflow:hidden;text-overflow:ellipsis;" +
      "white-space:nowrap;text-shadow:0 1px 4px #000;}" +

      /* ---- 信息卡：替代桌面底部信息条，兼作音轨/字幕/屏蔽/设置入口 ---- */
      "#mInfo{position:fixed;left:12px;right:12px;bottom:calc(env(safe-area-inset-bottom,0px) + 12px);" +
      "z-index:100060;max-height:72vh;overflow:auto;display:flex;flex-direction:column;gap:11px;" +
      "background:rgba(18,21,29,.97);border:1px solid rgba(255,255,255,.12);border-radius:16px;" +
      "padding:13px 15px;color:#e8ecf5;box-shadow:0 24px 70px -24px rgba(0,0,0,.85);}" +
      "#mInfo[hidden]{display:none!important;}" +
      ".mi-head{display:flex;align-items:center;gap:10px;}" +
      ".mi-head b{flex:1;font-size:14px;}" +
      ".mi-close{flex:none;width:34px;height:34px;border-radius:50%;border:1px solid rgba(255,255,255,.16);" +
      "background:none;color:#aab3c6;font-family:inherit;font-size:14px;}" +
      ".mi-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px 16px;}" +
      ".mi-row{display:flex;justify-content:space-between;gap:10px;font-size:12px;" +
      "border-bottom:1px solid rgba(255,255,255,.06);padding-bottom:5px;min-width:0;}" +
      ".mi-k{color:#8b95ab;flex:none;}" +
      ".mi-v{color:#e8ecf5;text-align:right;overflow:hidden;text-overflow:ellipsis;" +
      "white-space:nowrap;font-variant-numeric:tabular-nums;}" +
      ".mi-actions{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;}" +
      ".mi-actions button{min-height:44px;border-radius:10px;border:1px solid rgba(255,255,255,.14);" +
      "background:rgba(255,255,255,.06);color:#dfe5f2;font-family:inherit;font-size:12px;padding:4px;}" +
      ".mi-actions button:active{background:rgba(251,114,153,.25);}" +
      ".mi-actions button:disabled{opacity:.32;}" +

      /* ---- 播放中：舞台铺满 ---- */
      "body.m-playing{overflow:hidden;}" +
      "body.m-playing .wrap{padding:0!important;height:100vh!important;}" +
      "body.m-playing .placeholder{display:none!important;}" +
      /* .stage 带着 rise 动画的 transform 填充帧（identity 也算 transform），
       * 会成为 fixed 后代的包含块，所以全屏必须落在 .stage 上并清掉 transform。 */
      "body.m-playing .stage{position:fixed!important;inset:0!important;width:100vw!important;" +
      "height:100vh!important;z-index:99990!important;border:0!important;border-radius:0!important;" +
      "box-shadow:none!important;transform:none!important;animation:none!important;}" +
      "body.m-playing #player{position:static!important;width:100%!important;height:100%!important;}" +

      /* ---- 播放列表 / 设置升级为手机尺寸 ---- */
      "#playlist{z-index:100100!important;width:min(340px,74vw)!important;" +
      "padding-bottom:env(safe-area-inset-bottom,0px)!important;}" +
      /* 桌面版 .playlist 是 .wrap 直接子元素，会吃到 rise 动画的 transform:none
       * 填充帧，抽屉因此永远展开；用 !important 压回滑出状态。 */
      ".playlist:not(.open){transform:translateX(110%)!important;}" +
      ".playlist.open{transform:none!important;}" +
      ".pl-head{padding-top:calc(14px + env(safe-area-inset-top,0px))!important;min-height:54px;}" +
      ".pl-head button{width:36px!important;height:36px!important;font-size:15px;}" +
      ".pl-item{min-height:44px;font-size:13px!important;}" +
      ".settings-modal{max-height:calc(100vh - 24px);}" +
      /* 桌面浮窗在手机上统一改成底部面板，并压到播放页之上 */
      ".block-panel{z-index:100050!important;left:12px!important;right:12px!important;" +
      "bottom:calc(env(safe-area-inset-bottom,0px) + 12px)!important;width:auto!important;" +
      "max-width:none!important;max-height:72vh;overflow:auto;}" +
      ".settings-mask{z-index:100070!important;padding:env(safe-area-inset-top,0px) 8px env(safe-area-inset-bottom,0px);}" +
      ".settings-modal{width:100%!important;max-width:none!important;" +
      "max-height:calc(100vh - env(safe-area-inset-top,0px) - env(safe-area-inset-bottom,0px) - 16px)!important;padding:16px!important;}" +

      /* ---- 提示要压在启动页/播放页之上 ---- */
      ".toast{z-index:200010!important;}" +
      ".pill{z-index:100001!important;}";
    var style = document.createElement("style");
    style.id = "aBaseStyle";
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }
  injectBaseCss();

  /* ------------------------------------------------------------------ *
   * 文件浏览器
   * ------------------------------------------------------------------ */
  function ensureOverlay() {
    if (overlay) return overlay;
    var style = el("style");
    style.textContent =
      "#aFileMask{position:fixed;inset:0;z-index:200000;background:rgba(0,0,0,.72);display:flex;" +
      "align-items:stretch;justify-content:center;" +
      "padding:calc(12px + env(safe-area-inset-top,0px)) calc(12px + env(safe-area-inset-right,0px)) " +
      "calc(12px + env(safe-area-inset-bottom,0px)) calc(12px + env(safe-area-inset-left,0px));}" +
      "#aFileMask[hidden]{display:none!important;}" +
      "#aFileBox{display:flex;flex-direction:column;width:100%;max-width:860px;background:#101820;" +
      "border:1px solid #2a3a48;border-radius:14px;overflow:hidden;color:#dce8f2;" +
      "font:14px system-ui,'Noto Sans CJK SC',sans-serif;}" +
      "#aFileHead{display:flex;gap:8px;align-items:center;padding:10px;background:#15212b;" +
      "border-bottom:1px solid #223241;}" +
      "#aFilePath{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" +
      "font-family:ui-monospace,monospace;font-size:12px;color:#8fd3ff;}" +
      "#aFileList{flex:1;overflow:auto;padding:6px;-webkit-overflow-scrolling:touch;}" +
      ".aRow{display:flex;align-items:center;gap:10px;min-height:52px;padding:0 12px;border-radius:9px;cursor:pointer;}" +
      ".aRow:active{background:#1d3142;}" +
      ".aName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}" +
      ".aMeta{flex:none;font-size:12px;color:#7f97aa;}" +
      ".aRow.dir .aName{color:#8fd3ff;}" +
      "#aFileBar{display:flex;gap:8px;flex-wrap:wrap;padding:10px;background:#15212b;border-top:1px solid #223241;}" +
      "#aFileBar button,#aFileHead button{min-height:44px;padding:0 14px;border-radius:9px;" +
      "border:1px solid #2a3a48;background:#1a2836;color:#dce8f2;font-size:14px;font-family:inherit;}" +
      "#aFileBar button:active,#aFileHead button:active{background:#274056;}";
    document.head.appendChild(style);

    overlay = el("div");
    overlay.id = "aFileMask";
    overlay.hidden = true;

    var box = el("div");
    box.id = "aFileBox";

    var head = el("div");
    head.id = "aFileHead";
    var up = el("button", null, "↑ 上级");
    var path = el("div", null, "");
    path.id = "aFilePath";
    var cancel = el("button", null, "取消");
    head.appendChild(up);
    head.appendChild(path);
    head.appendChild(cancel);

    var list = el("div");
    list.id = "aFileList";

    var bar = el("div");
    bar.id = "aFileBar";
    ["/sdcard/Download", "/sdcard", "/sdcard/Movies", "/storage/emulated/0"].forEach(function (p) {
      var b = el("button", null, p.replace("/sdcard", "内部存储").replace("/storage/emulated/0", "存储根"));
      b.addEventListener("click", function () { navigate(p); });
      bar.appendChild(b);
    });

    box.appendChild(head);
    box.appendChild(list);
    box.appendChild(bar);
    overlay.appendChild(box);

    up.addEventListener("click", function () {
      if (!cwd) return;
      var parent = cwd.replace(/\/+$/, "").replace(/\/[^/]+$/, "");
      if (!parent || parent === cwd) parent = "/sdcard";
      navigate(parent);
    });
    cancel.addEventListener("click", function () { close(null); });
    overlay.addEventListener("click", function (e) { if (e.target === overlay) close(null); });

    document.body.appendChild(overlay);
    return overlay;
  }

  function navigate(dir) {
    if (!dir) return;
    dir = String(dir).replace(/\\/g, "/");
    if (dir.length > 1) dir = dir.replace(/\/+$/, "");
    ensureOverlay();
    var list = document.getElementById("aFileList");
    list.textContent = "读取中…";
    origInvoke("list_dir", { dir: dir }).then(function (res) {
      cwd = res.dir || dir;
      try { localStorage.setItem(LAST_DIR_KEY, cwd); } catch (e) {}
      document.getElementById("aFilePath").textContent = cwd;
      render(res.entries || []);
    }).catch(function (e) {
      list.textContent = "无法读取：" + e + "\n可点上方快捷路径重试。";
    });
  }

  function render(entries) {
    var list = document.getElementById("aFileList");
    list.textContent = "";
    var dirs = entries.filter(function (e) { return e.is_dir; });
    var files = entries.filter(function (e) { return !e.is_dir && VIDEO_RE.test(e.name); });
    dirs.sort(function (a, b) { return a.name.toLowerCase().localeCompare(b.name.toLowerCase()); });
    files.sort(function (a, b) { return a.name.toLowerCase().localeCompare(b.name.toLowerCase()); });

    if (!dirs.length && !files.length) {
      list.appendChild(el("div", "aRow", "（此目录没有子文件夹或视频）"));
    }
    dirs.forEach(function (e) {
      var row = el("div", "aRow dir");
      row.appendChild(el("span", "aName", "📁 " + e.name));
      row.addEventListener("click", function () { navigate(e.path); });
      list.appendChild(row);
    });
    files.forEach(function (e) {
      var row = el("div", "aRow");
      row.appendChild(el("span", "aName", "🎬 " + e.name));
      row.appendChild(el("span", "aMeta", fmtSize(e.size)));
      row.addEventListener("click", function () {
        if (mode === "dir") return; // 选目录模式下用底部按钮确认，避免误触
        close(e.path);
      });
      list.appendChild(row);
    });

    var bar = document.getElementById("aFileBar");
    var old = document.getElementById("aPickHere");
    if (old) old.parentNode.removeChild(old);
    if (mode === "dir") {
      var pick = el("button", null, "选择当前文件夹");
      pick.id = "aPickHere";
      pick.style.borderColor = "#3d7ea6";
      pick.addEventListener("click", function () { close(cwd); });
      bar.insertBefore(pick, bar.firstChild);
    }
  }

  function openBrowser(m) {
    mode = m || "file";
    ensureOverlay();
    overlay.hidden = false;
    var start = "/sdcard/Download";
    try { start = localStorage.getItem(LAST_DIR_KEY) || start; } catch (e) {}
    navigate(start);
    return new Promise(function (resolve) { resolver = resolve; });
  }

  function close(value) {
    if (overlay) overlay.hidden = true;
    var r = resolver;
    resolver = null;
    if (r) r(value || null);
  }

  /* ------------------------------------------------------------------ *
   * 最近播放
   * ------------------------------------------------------------------ */
  function normPath(p) {
    return String(p || "").replace(/\\/g, "/").replace(/^\/+/, "/");
  }

  function readRecent() {
    try {
      var a = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
      if (!Array.isArray(a)) return [];
      var seen = {};
      return a.filter(function (x) {
        if (!x || !x.p) return false;
        x.p = normPath(x.p);
        if (seen[x.p]) return false;
        seen[x.p] = 1;
        return true;
      });
    } catch (e) { return []; }
  }

  function writeRecent(list) {
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 8))); } catch (e) {}
  }

  function rememberVideo(path, name) {
    path = normPath(path);
    if (!path) return;
    var list = readRecent().filter(function (x) { return x.p !== path; });
    list.unshift({ p: path, n: name || path.split("/").pop() || "", t: Date.now() });
    writeRecent(list);
    renderRecent();
  }

  function renderRecent() {
    if (!home) return;
    var box = document.getElementById("mRecentList");
    if (!box) return;
    box.textContent = "";
    var list = readRecent();
    writeRecent(list); // 顺手把历史上重复/多斜杠的路径清一遍
    if (!list.length) {
      var empty = el("div", "mEmpty", "还没有播放记录\n选一部片子开始吧");
      empty.style.whiteSpace = "pre-line";
      box.appendChild(empty);
      return;
    }
    list.slice(0, 5).forEach(function (item) {
      var row = el("div", "mRecentRow");
      row.appendChild(el("span", "ic", "🎞"));
      row.appendChild(el("span", "nm", item.n || item.p));
      row.appendChild(el("span", "go", "继续"));
      row.title = item.p;
      row.addEventListener("click", function () {
        if (!window.__BplayerDesktop) return;
        window.__BplayerDesktop.loadVideo(item.p, null);
        // 同一个文件不会重新触发 loadedmetadata，这里兜底进入播放页
        setTimeout(function () {
          var chip = document.getElementById("chipVideo");
          var cur = chip ? chip.textContent : "";
          if (cur && item.n && cur.indexOf(item.n) >= 0) enterPlaying();
        }, 500);
      });
      box.appendChild(row);
    });
  }

  /* ------------------------------------------------------------------ *
   * 启动页
   * ------------------------------------------------------------------ */
  function buildHome() {
    if (home) return;
    home = el("div");
    home.id = "mHome";
    home.innerHTML =
      '<div class="mBody">' +
        '<div class="mLeft">' +
          '<div class="mBrand"><div class="mLogo">▶</div>' +
            '<div><h1>Bplayer</h1><p>本地视频 · 弹幕播放器</p></div>' +
            '<button type="button" class="mHomeGear" id="mHomeSettings" title="设置">⚙</button></div>' +
          '<div class="mActions">' +
            '<button type="button" id="mOpenVideo" class="mBtn mPrimary">' +
              '<b>选择视频</b><small>单个文件 · 自动配对同名弹幕</small></button>' +
            '<button type="button" id="mOpenFolder" class="mBtn mSecondary">' +
              '<b>选择文件夹</b><small>整季连播 · 自动生成剧集列表</small></button>' +
          '</div>' +
          '<p class="mHint">MP4 / MKV / HEVC · 同名弹幕与外挂字幕自动加载</p>' +
        '</div>' +
        '<div class="mRight">' +
          '<div class="mRightHead"><h2>最近播放</h2>' +
            '<button type="button" id="mClearRecent">清空</button></div>' +
          '<div class="mRecentList" id="mRecentList"></div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(home);

    function openVideo() {
      var btn = document.getElementById("btnOpenVideo");
      if (btn) btn.click();
    }
    function openFolder() {
      var btn = document.getElementById("btnOpenFolder");
      if (btn) btn.click();
    }
    document.getElementById("mOpenVideo").addEventListener("click", openVideo);
    document.getElementById("mOpenFolder").addEventListener("click", openFolder);
    document.getElementById("mHomeSettings").addEventListener("click", function () {
      var b = document.getElementById("btnSettings");
      if (b) b.click();
    });
    document.getElementById("mClearRecent").addEventListener("click", function () {
      writeRecent([]);
      renderRecent();
    });
    renderRecent();
  }

  /* ------------------------------------------------------------------ *
   * 播放页顶部悬浮条
   * ------------------------------------------------------------------ */
  function buildTopbar() {
    if (topbar) return;
    topbar = el("div");
    topbar.id = "mTop";
    topbar.innerHTML =
      '<button type="button" class="mIconBtn" id="mBack" title="返回">‹</button>' +
      '<div class="mTitleBox"><div id="mTitle">—</div><div id="mDan"></div></div>' +
      '<button type="button" class="mIconBtn on" id="mDanBtn" title="弹幕开关">弹</button>' +
      '<button type="button" class="mIconBtn" id="mInfoBtn" title="视频信息与功能">i</button>' +
      '<button type="button" class="mIconBtn" id="mPlBtn" title="播放列表">≡</button>';
    document.body.appendChild(topbar);
    buildInfoPanel();

    document.getElementById("mBack").addEventListener("click", exitPlaying);
    document.getElementById("mInfoBtn").addEventListener("click", function () {
      if (!infoPanel) return;
      var opening = infoPanel.hidden;
      openInfo(opening);
    });
    document.getElementById("mPlBtn").addEventListener("click", function () {
      var pl = document.getElementById("playlist");
      if (pl) pl.classList.add("open");
    });
    document.getElementById("mDanBtn").addEventListener("click", function () {
      var btn = this;
      var art = window.Bplayer && window.Bplayer.art;
      var p = art && art.plugins && art.plugins.artplayerPluginDanmuku;
      if (!p) return;
      if (p.isHide) { p.show(); btn.classList.add("on"); }
      else { p.hide(); btn.classList.remove("on"); }
    });
  }

  function buildInfoPanel() {
    if (infoPanel) return;
    infoPanel = el("div");
    infoPanel.id = "mInfo";
    infoPanel.hidden = true;
    infoPanel.innerHTML =
      '<div class="mi-head"><b>视频信息</b>' +
        '<button type="button" class="mi-close" id="mInfoClose" title="关闭">✕</button></div>' +
      '<div class="mi-grid">' +
        '<div class="mi-row"><span class="mi-k">时长</span><span class="mi-v" id="miDuration">—</span></div>' +
        '<div class="mi-row"><span class="mi-k">分辨率</span><span class="mi-v" id="miRes">—</span></div>' +
        '<div class="mi-row"><span class="mi-k">视频大小</span><span class="mi-v" id="miSize">—</span></div>' +
        '<div class="mi-row"><span class="mi-k">弹幕数量</span><span class="mi-v" id="miCount">—</span></div>' +
        '<div class="mi-row"><span class="mi-k">弹幕解析</span><span class="mi-v" id="miParse">—</span></div>' +
        '<div class="mi-row"><span class="mi-k">当前进度</span><span class="mi-v" id="miTime">—</span></div>' +
      '</div>' +
      '<div class="mi-actions">' +
        '<button type="button" id="mActAudio">音轨</button>' +
        '<button type="button" id="mActSub">字幕</button>' +
        '<button type="button" id="mActBlock">弹幕屏蔽</button>' +
        '<button type="button" id="mActSettings">设置</button>' +
      '</div>';
    document.body.appendChild(infoPanel);

    document.getElementById("mInfoClose").addEventListener("click", function () {
      infoPanel.hidden = true;
    });
    function forward(btnId) {
      infoPanel.hidden = true;
      var b = document.getElementById(btnId);
      if (b && !b.hidden) b.click();
    }
    document.getElementById("mActAudio").addEventListener("click", function () {
      forward("btnAudioEntry");
    });
    document.getElementById("mActSub").addEventListener("click", function () {
      forward("btnSubtitleEntry");
    });
    document.getElementById("mActBlock").addEventListener("click", function () {
      forward("btnBlockEntry");
    });
    document.getElementById("mActSettings").addEventListener("click", function () {
      infoPanel.hidden = true;
      var b = document.getElementById("btnSettings");
      if (b) b.click();
    });
  }

  function fillInfo() {
    if (!infoPanel) return;
    function copy(from, to) {
      var s = document.getElementById(from);
      var d = document.getElementById(to);
      if (d) d.textContent = s && s.textContent.trim() ? s.textContent.trim() : "—";
    }
    copy("infoDuration", "miDuration");
    copy("infoRes", "miRes");
    copy("infoSize", "miSize");
    copy("infoCount", "miCount");
    copy("infoParse", "miParse");
    copy("infoTime", "miTime");
    var ab = document.getElementById("btnAudioEntry");
    var sb = document.getElementById("btnSubtitleEntry");
    var ba = document.getElementById("mActAudio");
    var bs = document.getElementById("mActSub");
    if (ba) ba.disabled = !ab || ab.hidden;
    if (bs) bs.disabled = !sb || sb.hidden;
  }

  function openInfo(on) {
    if (!infoPanel) return;
    if (on) {
      ["audioPanel", "subtitlePanel", "densityPanel", "blockPanel"].forEach(function (id) {
        var p = document.getElementById(id);
        if (p) p.hidden = true;
      });
      var pl = document.getElementById("playlist");
      if (pl) pl.classList.remove("open");
      fillInfo();
    }
    infoPanel.hidden = !on;
  }

  function setImmersive(on) {
    try {
      if (window.AndroidUI && window.AndroidUI.setImmersive) {
        window.AndroidUI.setImmersive(!!on);
      }
    } catch (e) {}
  }

  function setLandscape(on) {
    try {
      if (window.AndroidUI && window.AndroidUI.setLandscape) {
        window.AndroidUI.setLandscape(!!on);
      }
    } catch (e) {}
  }

  function updateTopbar() {
    if (!topbar) return;
    var cv = document.getElementById("chipVideo");
    var cd = document.getElementById("chipDanmaku");
    var title = cv ? cv.textContent.replace(/^\s*🎬\s*/, "").split(" · ")[0] : "";
    title = title.replace(/\.[a-z0-9]{2,5}$/i, ""); // 顶部标题不带扩展名
    var dan = cd ? cd.textContent.replace(/^\s*💬\s*/, "") : "";
    var t = document.getElementById("mTitle");
    var d = document.getElementById("mDan");
    if (t && title) t.textContent = title;
    if (d) d.textContent = dan;
    if (infoPanel && !infoPanel.hidden) fillInfo();
  }

  function rememberCurrent() {
    var art = window.Bplayer && window.Bplayer.art;
    var v = art && art.video;
    var src = v && (v.currentSrc || v.src);
    if (!src) return;
    var path = src;
    try {
      var u = new URL(src);
      path = decodeURIComponent(u.pathname || "");
    } catch (e) {
      path = src.replace(/^https?:\/\/asset\.localhost/, "");
    }
    if (!path) return;
    var name = path.split("/").pop() || "";
    rememberVideo(path, name);
  }

  function enterPlaying() {
    var art = window.Bplayer && window.Bplayer.art;
    if (!art) return;
    var first = !playing;
    playing = true;
    document.body.classList.add("m-playing");
    if (home) home.classList.add("hide");
    if (topbar) topbar.classList.add("show");
    var pl = document.getElementById("playlist");
    if (pl) pl.classList.remove("open");
    openInfo(false);
    setImmersive(true);
    setLandscape(true);
    updateTopbar();
    if (first) {
      setTimeout(function () {
        try { art.resize(); } catch (e) {}
        window.dispatchEvent(new Event("resize"));
      }, 80);
      setTimeout(rememberCurrent, 600);
    }
  }

  function exitPlaying() {
    playing = false;
    document.body.classList.remove("m-playing");
    if (home) home.classList.remove("hide");
    if (topbar) topbar.classList.remove("show");
    openInfo(false);
    setImmersive(false);
    setLandscape(false);
    try {
      var art = window.Bplayer && window.Bplayer.art;
      if (art) art.pause();
    } catch (e) {}
    renderRecent();
  }

  function hookArt() {
    setInterval(function () {
      var art = window.Bplayer && window.Bplayer.art;
      if (!art || art === hookedArt) return;
      hookedArt = art;
      art.on("control", function (show) {
        if (topbar && playing) topbar.classList.toggle("show", !!show);
      });
      art.on("video:loadedmetadata", function () {
        enterPlaying();
        setTimeout(rememberCurrent, 500);
      });
      art.on("video:play", enterPlaying);
      art.on("video:error", function () {
        if (playing && !art.playing) {
          // 解码失败时退回启动页，让用户换片
          setTimeout(function () { if (!art.playing) exitPlaying(); }, 1200);
        }
      });
    }, 400);
  }

  function observeInfo() {
    var cv = document.getElementById("chipVideo");
    var cd = document.getElementById("chipDanmaku");
    if (window.MutationObserver) {
      var mo = new MutationObserver(updateTopbar);
      if (cv) mo.observe(cv, { childList: true, characterData: true, subtree: true });
      if (cd) mo.observe(cd, { childList: true, characterData: true, subtree: true });
    }
  }

  /* 系统返回键：设置/信息卡/浮窗 → 文件浏览器 → 播放列表 → 播放页 → 退出应用 */
  window.__aAndroidBack = function () {
    var mask = document.getElementById("settingsMask");
    if (mask && !mask.hidden) {
      var sc = document.getElementById("settingsClose");
      if (sc) sc.click(); else mask.hidden = true;
      return true;
    }
    if (infoPanel && !infoPanel.hidden) { infoPanel.hidden = true; return true; }
    var panels = ["audioPanel", "subtitlePanel", "densityPanel", "blockPanel"];
    for (var i = 0; i < panels.length; i++) {
      var p = document.getElementById(panels[i]);
      if (p && !p.hidden) { p.hidden = true; return true; }
    }
    if (overlay && !overlay.hidden) { close(null); return true; }
    var pl = document.getElementById("playlist");
    if (pl && pl.classList.contains("open")) { pl.classList.remove("open"); return true; }
    if (playing) { exitPlaying(); return true; }
    try {
      if (window.AndroidUI && window.AndroidUI.exitApp) window.AndroidUI.exitApp();
    } catch (e) {}
    return true;
  };

  function polishSettings() {
    var opt = document.getElementById("optAutostart");
    if (opt && opt.closest) {
      var row = opt.closest(".settings-row");
      if (row) row.style.display = "none"; // 手机没有开机启动项
    }
    var modal = document.querySelector("#settingsMask .settings-modal");
    var head = modal && modal.querySelector(".settings-head");
    if (head && !document.getElementById("mSettingsNote")) {
      var note = el("div", "settings-desc", "Android 版：音轨 / 字幕自动转换需要后台 ffmpeg，当前版本保留开关，转码在后续版本接入。");
      note.id = "mSettingsNote";
      note.style.paddingLeft = "0";
      head.parentNode.insertBefore(note, head.nextSibling);
    }
  }

  function boot() {
    buildHome();
    buildTopbar();
    polishSettings();
    hookArt();
    observeInfo();
    // 不再锁定方向：旋转后重排播放器（启动页靠 CSS 自动切竖排）
    window.addEventListener("orientationchange", function () {
      setTimeout(function () {
        try {
          var art = window.Bplayer && window.Bplayer.art;
          if (art) art.resize();
        } catch (e) {}
        window.dispatchEvent(new Event("resize"));
        if (infoPanel && !infoPanel.hidden) fillInfo();
      }, 260);
    });
    // 播放列表条目是动态生成的；点中后主动进播放页（同源切换不会触发 loadedmetadata）
    document.addEventListener("click", function (e) {
      var t = e.target;
      while (t && t !== document && !(t.classList && t.classList.contains("pl-item"))) {
        t = t.parentNode;
      }
      if (!t || t === document) return;
      setTimeout(function () {
        var art = window.Bplayer && window.Bplayer.art;
        if (!art) return;
        enterPlaying();
        try { art.play(); } catch (err) {}
      }, 200);
    }, true);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  // 主流程在 initDesktop() 里提前捕获 invoke，这里显式暴露代理函数，
  // index.html 改为优先使用它（见 initDesktop / placeholder 点击两处）。
  window.__aInvoke = function (cmd, args) {
    if (cmd === "pick_video") return openBrowser("file");
    if (cmd === "pick_folder") return openBrowser("dir");
    return origInvoke(cmd, args);
  };
})();
