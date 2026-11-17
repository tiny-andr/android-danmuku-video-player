(function () {
  "use strict";

  var PREFIX = "/@network/";
  var LAST_DIR = "bplayer.android.lastDir";
  var VIDEO = /\.(mp4|m4v|webm|mov|mkv|avi|ts|flv|wmv|mpg|mpeg)$/i;
  var SUBTITLE = /\.(srt|ass|ssa|vtt)$/i;
  var DANMAKU = /\.(xml|json)$/i;
  var MODES = ["file", "dir", "subtitle", "danmaku"];
  function attachmentMode() { return mode === "subtitle" || mode === "danmaku"; }
  function useGrid() { return !attachmentMode() && gridView; }
  function positionKey(route) { return mode + ":" + route; }
  function acceptsFile(name) {
    return (mode === "subtitle" ? SUBTITLE : mode === "danmaku" ? DANMAKU : VIDEO).test(name);
  }
  /* 弹幕标识：只读当前 list_dir 返回的同批条目（后端已放行 xml/json，见 lib.rs list_dir），
     不会额外 invoke。配对规则与后端 pair_danmaku / scan_folder 一致：去掉最后一个扩展名后
     小写全等，不做前缀匹配（`反派 (上).xml` 不会给 `反派 (上) 花絮.mp4` 打标）。 */
  function baseName(name) { return String(name).replace(/\.[^.]+$/, "").toLowerCase(); }
  function danmakuStemSet(entries) {
    var stems = new Set();
    (entries || []).forEach(function (entry) {
      if (!entry || entry.is_dir) return;
      var name = String(entry.name || "");
      if (DANMAKU.test(name)) stems.add(baseName(name));
    });
    return stems;
  }
  function pickerTitle() {
    return { file: "选择视频", dir: "选择文件夹", subtitle: "选择字幕", danmaku: "选择弹幕" }[mode];
  }
  var pending = new Map();
  var serial = 0;
  var generation = 0;
  var sources = [];
  var mask, list, pathLabel, footer, shortcuts, form;
  var cwd = "";
  var requestedDir = "";
  var mode = "file";
  var resolvePicker = null;
  var section = "local";
  var editing = null;
  var formVersion = 0;
  var currentEntries = [];
  var sortKey = "name";
  var sortDescending = false;
  var gridView = false;
  var page = "";
  var pageReady = false;
  var positions = new Map();
  var selection = null;
  /* 非播放页的就地错误行（不用紫色浮条）。归属「当前这次目录会话」：notice 之后
     再 navigate 一次会把旧提示清掉，不会挂着一条跟当前目录无关的旧错误。 */
  var noticeEl = null;
  var noticeText = "";
  var noticeTicket = -1;
  var localDir = "/sdcard/Download";
  var networkDir = "";
  try {
    var rememberedLocal = localStorage.getItem("bplayer.android.localDir");
    var rememberedNetwork = localStorage.getItem("bplayer.android.networkDir");
    var legacyDir = localStorage.getItem(LAST_DIR);
    if (rememberedLocal && !isNetwork(rememberedLocal)) localDir = rememberedLocal;
    else if (legacyDir && !isNetwork(legacyDir)) localDir = legacyDir;
    if (rememberedNetwork !== null && (!rememberedNetwork || isNetwork(rememberedNetwork))) networkDir = rememberedNetwork;
    else if (legacyDir && isNetwork(legacyDir)) networkDir = legacyDir;
  } catch (error) {}
  function routeKey() {
    return page === "sources" ? positionKey("sources") : page === "directory" ? positionKey(requestedDir) : "";
  }
  function capturePosition() {
    var fallback = { path: "", offset: 0, scrollTop: list ? list.scrollTop : 0 };
    if (!list) return fallback;
    var top = list.getBoundingClientRect().top;
    var rows = Array.from(list.querySelectorAll("[data-path]"));
    var anchor = rows.find(function (row) { return row.getBoundingClientRect().bottom > top + 1; });
    if (anchor) { fallback.path = anchor.dataset.path; fallback.offset = anchor.getBoundingClientRect().top - top; }
    return fallback;
  }
  function rememberPosition() {
    var key = routeKey();
    if (!key || !pageReady || !mask || mask.hidden || !form.hidden) return;
    positions.delete(key); positions.set(key, capturePosition());
    if (positions.size > 128) positions.delete(positions.keys().next().value);
  }
  function restorePosition(position) {
    if (!list || !position) return;
    list.scrollTop = Math.max(0, Number(position.scrollTop) || 0);
    var anchor = Array.from(list.querySelectorAll("[data-path]")).find(function (row) { return row.dataset.path === position.path; });
    if (anchor) list.scrollTop += anchor.getBoundingClientRect().top - list.getBoundingClientRect().top - (Number(position.offset) || 0);
  }
  function copyPosition(position) {
    return Object.freeze({ path: String(position && position.path || ""), offset: Number(position && position.offset) || 0, scrollTop: Math.max(0, Number(position && position.scrollTop) || 0) });
  }
  function snapshot(path) {
    var position = copyPosition(positions.get(routeKey()) || capturePosition());
    return Object.freeze({ version: 1, mode: mode, section: section, requestedDir: requestedDir,
      sourceId: isNetwork(requestedDir) ? requestedDir.slice(PREFIX.length).split("/")[0] : "",
      sort: sortKey, descending: sortDescending, grid: useGrid(), position: position,
      selectedPath: path, localDir: localDir, networkDir: networkDir,
      sourcesPosition: copyPosition(positions.get(positionKey("sources"))) });
  }
  function persistDirectory(dir) {
    if (isNetwork(dir)) networkDir = dir; else localDir = dir;
    try {
      localStorage.setItem(LAST_DIR, dir);
      localStorage.setItem(isNetwork(dir) ? "bplayer.android.networkDir" : "bplayer.android.localDir", dir);
    } catch (error) {}
  }
  try {
    var preferences = JSON.parse(localStorage.getItem("bplayer.android.fileView") || "{}");
    if (["name", "modified", "type"].includes(preferences.sort)) sortKey = preferences.sort;
    sortDescending = preferences.descending === true;
    gridView = preferences.grid === true;
  } catch (error) {}
  function saveView() {
    try { localStorage.setItem("bplayer.android.fileView", JSON.stringify({ sort: sortKey, descending: sortDescending, grid: gridView })); } catch (error) {}
  }

  function node(tag, cls, text) {
    var element = document.createElement(tag);
    if (cls) element.className = cls;
    if (text != null) element.textContent = text;
    return element;
  }
  function button(text, action, cls) {
    var element = node("button", cls, text);
    element.type = "button";
    element.addEventListener("click", action);
    return element;
  }
  function isNetwork(path) { return String(path || "").startsWith(PREFIX); }
  function sourceFor(path) {
    var id = String(path).slice(PREFIX.length).split("/")[0];
    return sources.find(function (source) { return source.id === id; });
  }
  function rootFor(path) { return PREFIX + String(path).slice(PREFIX.length).split("/")[0]; }
  function request(command, args) {
    return new Promise(function (resolve, reject) {
      if (!window.AndroidNetwork) { reject(new Error("网络存储桥未就绪，请重新打开应用")); return; }
      var id = String(++serial);
      var timeout = setTimeout(function () {
        pending.delete(id);
        reject(new Error("连接超时，请检查网络与服务器地址后重试"));
      }, 90000);
      pending.set(id, { resolve: resolve, reject: reject, timeout: timeout });
      try { window.AndroidNetwork.request(id, command, JSON.stringify(args || {})); }
      catch (error) { clearTimeout(timeout); pending.delete(id); reject(error); }
    });
  }
  window.__aNetworkReply = function (id, envelope) {
    var entry = pending.get(String(id));
    if (!entry) return;
    pending.delete(String(id));
    clearTimeout(entry.timeout);
    if (envelope.ok) entry.resolve(envelope.result);
    else entry.reject(new Error(envelope.error || "网络读取失败"));
  };
  function invoke(command, args) {
    args = args || {};
    var path = args.path || args.videoPath || args.dir;
    if (command.indexOf("network_") === 0) return request(command, args);
    if (command === "sidecar_cache_files" && window.AndroidAudioTasks && window.AndroidAudioTasks.currentSession) {
      return window.AndroidAudioTasks.request("audio_cache_files", { videoPath: args.videoPath, session: window.AndroidAudioTasks.currentSession });
    }
    if (!isNetwork(path)) return window.__TAURI__.core.invoke(command, args);
    if (command === "probe_mkv_tracks") return Promise.resolve({ tracks: [], duration_us: null });
    if (command === "clean_sidecar_tmp") return Promise.resolve(0);
    if (command === "sidecar_cache_files") return Promise.resolve([]);
    if (["list_dir", "fs_stat", "read_text", "read_bytes", "scan_folder", "pair_danmaku", "scan_subtitles"].includes(command)) {
      return request(command, args);
    }
    return Promise.reject(new Error("网络文件暂不支持此操作"));
  }
  function mediaUrl(path) {
    if (isNetwork(path)) {
      if (!window.AndroidNetwork) throw new Error("网络存储桥未就绪");
      return window.AndroidNetwork.mediaUrl(path);
    }
    return window.__TAURI__.core.convertFileSrc(path);
  }
  function prettyPath(path) {
    if (!isNetwork(path)) return path.replace(/^\/storage\/emulated\/0|^\/sdcard/, "手机存储");
    var source = sourceFor(path);
    return (source ? source.name : "网络存储") + (path.slice(rootFor(path).length) || " / ");
  }
  function sizeText(size) {
    if (!size) return "";
    var units = ["B", "KB", "MB", "GB", "TB"];
    var index = 0;
    while (size >= 1024 && index < units.length - 1) { size /= 1024; index++; }
    return size.toFixed(index && size < 10 ? 1 : 0) + " " + units[index];
  }
  function ensure() {
    if (mask) return;
    var style = node("style");
    style.textContent =
      "#aFileMask{position:fixed;inset:0;z-index:200000;display:flex;justify-content:center;background:rgba(5,7,12,.9);padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px);box-sizing:border-box}" +
      "#aFileMask[hidden],#aFileMask [hidden]{display:none!important}" +
      "#aFileBox{width:100%;max-width:860px;min-width:0;min-height:0;display:flex;flex-direction:column;color:#eef0fa;background:linear-gradient(150deg,#171925,#0e111a);font:14px system-ui,sans-serif}" +
      "#aFileMask *{box-sizing:border-box}#aFileMask button,#aFileMask input,#aFileMask select{font:inherit}" +
      "#aFileMask button{cursor:pointer;min-height:44px;border:1px solid #ffffff20;border-radius:12px;padding:9px 14px;color:inherit;background:#ffffff08}" +
      "#aFileMask button:active{background:#ffffff20}#aFileMask button:disabled{opacity:.38;cursor:default}" +
      "#aFileMask button:focus-visible,#aFileMask input:focus-visible,#aFileMask select:focus-visible{outline:2px solid #ac96ff;outline-offset:2px}" +
      ".aTitleBar{display:flex;align-items:center;gap:12px;padding:14px 16px 8px}.aTitleBar h2{flex:1;margin:0;font-size:19px}.aIcon{width:44px;padding:0!important;font-size:20px!important}" +
      ".aTabs{display:flex;gap:6px;margin:4px 16px 10px;padding:4px;background:#ffffff06;border-radius:15px}.aTabs button{flex:1;border-color:transparent!important;color:#929bb3!important}.aTabs button[aria-selected=true]{color:#f1eaff!important;background:#8b68ef30!important;border-color:#a184ed40!important}" +
      "#aQuick{display:flex;gap:8px;overflow-x:auto;padding:0 16px 10px;flex-shrink:0}#aQuick button{white-space:nowrap;min-height:38px;font-size:12px;border-radius:20px}" +
      "#aFileHead{display:flex;gap:8px;align-items:center;padding:8px 16px;border-top:1px solid #ffffff08;border-bottom:1px solid #ffffff08}" +
      "#aFilePath{flex:1;min-width:0;color:#aeb8d4;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      "#aFileList{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:8px 10px;-webkit-overflow-scrolling:touch}" +
      "#aFileMask .aRow{display:flex;align-items:center;gap:12px;width:100%;min-height:58px;padding:8px 12px;text-align:left;background:none;border:0;border-radius:12px}" +
      ".aFileIcon{flex:none;width:36px;height:36px;border-radius:10px;display:grid;place-items:center;color:#bda6ff;background:#8b68ef18;font-size:18px}.aName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.aMeta{font-size:12px;color:#7f8aa3;flex:none}.aArrow{color:#7f8aa3}" +
      "#aFileBar{padding:12px 16px;border-top:1px solid #ffffff10;background:#151823}.aSelection{color:#b5bed5;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin:0 0 9px}#aPickHere{width:100%;font-weight:600;background:linear-gradient(110deg,#d25a87,#8061da)!important;border-color:transparent!important}" +
      ".aStatus{padding:30px 14px;text-align:center;color:#8d99b3;line-height:1.7;white-space:pre-line;overflow-wrap:anywhere}.aStatus button{display:block;margin:16px auto 0}" +
      ".aSource{display:flex;gap:8px;margin:6px 2px 10px;padding:10px;border:1px solid #ffffff12;border-radius:15px;background:#ffffff04}.aSource .aSourceOpen{flex:1;min-width:0;border:0!important;background:none!important;text-align:left;padding:4px!important}.aSource strong,.aSource small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.aSource small{color:#8d99b3;font-size:12px;margin-top:5px}.aSource .aEdit{font-size:12px;align-self:center}.aAdd{width:100%;border-style:dashed!important;color:#c6b4ff!important}.aNote{font-size:12px;color:#8894ad;line-height:1.65;margin:12px 8px}" +
      "#aSourceForm{flex:1;min-height:0;overflow:auto;padding:8px 16px 16px}.aFormGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.aField{display:flex;flex-direction:column;gap:6px;font-size:12px;color:#a9b4cd}.aField.wide{grid-column:1/-1}.aField input,.aField select{width:100%;min-height:46px;border:1px solid #ffffff20;border-radius:10px;padding:10px;background:#0c101b;color:#edf0fa;outline:none}.aField input::placeholder{color:#5e6a84;font-size:12px}.aField input[type=checkbox]{width:20px;min-height:20px;flex:none}.aFormActions{display:flex;gap:10px;margin-top:16px}.aFormActions button{flex:1}.aSave{background:#8b68ef44!important}.aDanger{color:#ff9caf!important}.aFormMessage{font-size:14px;line-height:1.7;white-space:pre-line;overflow-wrap:anywhere;margin:14px 0;padding:12px 14px;border:1px solid #8290b044;border-radius:12px;color:#c9d5ee;background:#8290b012}.aFormMessage:empty{display:none}.aFormMessage[data-kind=error]{border:2px solid #ff6d8d;color:#ffd5de;background:#ef426b24;font-weight:600}.aFormMessage[data-kind=success]{border-color:#64cda0;color:#b9f3d8;background:#64cda015}.aDiscovery{margin-top:10px;width:100%;color:#c6b4ff!important}.aDiscovered{margin-top:14px;padding-top:12px;border-top:1px solid #ffffff18}.aFingerprint{padding:12px;border:1px solid #a38cdd55;border-radius:12px;background:#8b68ef12}.aFingerprint code{display:block;word-break:break-all;user-select:text;font-size:12px;margin:8px 0}.aTrust{display:flex;gap:8px;align-items:flex-start;font-size:12px;line-height:1.6}.aTrust input{margin-top:3px}.aDangerConfirm{margin-top:12px;padding:12px;background:#f9779010;border-radius:12px}" +
      ".aFileLayout{flex:1;min-height:0;display:flex;flex-direction:column;}.aFileMain{flex:1;min-height:0;display:flex;flex-direction:column;}" +
      "#aFileTools{display:flex;gap:8px;align-items:center;padding:7px 16px;border-bottom:1px solid #ffffff10;}#aFileTools label{font-size:12px;color:#aeb8d4;display:flex;align-items:center;gap:6px;}#aFileSort{min-height:40px;max-width:130px;background:#171e2e;color:#eef0fa;border:1px solid #ffffff20;border-radius:10px;padding:4px 8px;}#aFileTools button{min-height:40px;font-size:12px;padding:6px 10px;}#aFileView{margin-left:auto;}" +
      ".aFileDetail{flex:1;min-width:0;display:flex;flex-direction:column;gap:5px;}.aFileDetail .aMeta{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;}" +
      /* 「弹幕」标识：flex:0 0 auto 保证超长文件名只压缩 .aName（min-width:0 + 省略号）而不会把标签挤掉。 */
      ".aDanmaku{flex:0 0 auto;display:inline-flex;align-items:center;padding:1px 7px;border:1px solid #a184ed55;border-radius:7px;background:#8b68ef1c;color:#c9b7ff;font-size:10.5px;line-height:1.65;font-weight:600;letter-spacing:.02em;white-space:nowrap}" +
      ".aFileThumb{display:none;width:100%;aspect-ratio:16/9;object-fit:cover;background:#202a3d;border-radius:10px;}.aFileThumb:not([src]){visibility:hidden;}" +
      "#aFileList.is-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(145px,1fr));grid-auto-rows:max-content;gap:10px;align-content:start;}#aFileList.is-grid .aRow{position:relative;display:block;height:auto;min-width:0;align-self:start;overflow:hidden;padding:9px;background:#ffffff06;}#aFileList.is-grid .aFileDetail{margin-top:8px;}#aFileList.is-grid .aFileThumb{display:block;opacity:0;}#aFileList.is-grid .aFileThumb.thumbnail-ready{opacity:1;}#aFileList.is-grid .aFileIcon{width:100%;aspect-ratio:16/9;height:auto;font-size:30px;}#aFileList.is-grid .aFileThumb+.aFileIcon{position:absolute;left:9px;top:9px;width:calc(100% - 18px);}#aFileList.is-grid .aFileThumb.thumbnail-ready+.aFileIcon{display:none;}#aFileList.is-grid .aArrow{display:none;}#aFileList.is-grid .aName{width:100%;}#aFileList.is-grid .aStatus{grid-column:1/-1;}#aFileList.is-grid .aDanmaku{position:absolute;right:9px;top:9px;z-index:1;margin:0;padding:0 6px;font-size:10px;background:#231b3fe0;border-color:#b6a3f580;}" +
      "@media(min-width:720px) and (min-height:540px){#aFileBox{max-width:1180px}.aFileLayout{flex-direction:row;}.aFileSidebar{flex:0 0 160px;border-right:1px solid #ffffff10;padding-top:12px;}#aFileMask .aTabs{flex-direction:column;margin:0 10px 14px;}#aFileMask #aQuick{flex-direction:column;overflow:auto;padding:0 10px;}#aFileMask .aTabs button{flex:none;text-align:left;}#aFileMask #aQuick button{text-align:left;}.aField.wide{grid-column:auto;}.aField:first-child{grid-column:1/-1;}}" +
      "@media(min-width:900px){#aFileMask{padding-top:calc(10px + env(safe-area-inset-top,0px));padding-bottom:calc(10px + env(safe-area-inset-bottom,0px))}#aFileBox{border:1px solid #ffffff15;border-radius:20px}}" +
      "@media(max-height:480px){.aTitleBar{padding-top:6px;padding-bottom:4px}.aTabs{margin-bottom:4px}.aTabs button{min-height:36px!important;padding:4px!important}#aQuick{padding-bottom:4px}#aFileHead{padding-top:4px;padding-bottom:4px}#aFileBar{padding-top:8px;padding-bottom:8px}}" +
      /* 宽且矮的横屏（外屏折叠态 931×415）：问题不在宽度而在纵向——标题/存储切换/快捷路径/
         路径栏/排序栏 5 层堆掉可用高的 74%，列表只剩 76px。这里把宽度换成高度：tabs 与
         快捷路径挪成左侧 rail、路径栏与排序栏并成一行，列表拿回约 250px。
         规则全锁在 max-height:520px，内屏展开（845×919）与竖屏外屏（415×931）都不会命中。 */
      "@media(min-width:700px) and (max-height:520px){" +
      "#aFileMask{padding:calc(env(safe-area-inset-top,0px) + 4px) 6px calc(env(safe-area-inset-bottom,0px) + 4px);}" +
      "#aFileBox{max-width:none;width:100%;height:100%;border-radius:12px;}" +
      ".aTitleBar{padding:0 12px;min-height:48px;}.aTitleBar h2{font-size:16px;}.aTitleBar .aIcon{width:48px;}" +
      ".aFileLayout{flex-direction:row;}" +
      ".aFileSidebar{flex:0 0 96px;border-right:1px solid #ffffff10;padding-top:6px;}" +
      "#aFileMask .aTabs{flex-direction:column;margin:0 6px 8px;gap:4px;}" +
      "#aFileMask .aTabs button{flex:none;min-height:48px!important;font-size:13px;padding:6px 8px!important;text-align:left;}" +
      "#aFileMask #aQuick{flex-direction:column;overflow-y:auto;padding:0 6px;gap:4px;}" +
      "#aFileMask #aQuick button{min-height:48px;font-size:12px;text-align:left;white-space:normal;}" +
      ".aFileMain{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-rows:48px minmax(0,1fr);grid-template-areas:'head tools' 'list list';}" +
      "#aFileHead{grid-area:head;padding:0 10px;border:0;}" +
      "#aFileTools{grid-area:tools;padding:0 10px 0 0;border:0;}" +
      "#aFileList{grid-area:list;padding:6px 8px;}" +
      "#aSourceForm{grid-column:1/-1;grid-row:2;min-height:0;}" +
      "#aFileBar{grid-column:1/-1;}" +
      "#aFileList.is-grid{grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;}" +
      ".aMeta{font-size:12px;}" +
      "#aFileMask button,#aFileMask select{min-height:48px;}" +
      "}";
    document.head.appendChild(style);
    mask = node("div"); mask.id = "aFileMask"; mask.hidden = true;
    mask.setAttribute("role", "dialog"); mask.setAttribute("aria-modal", "true"); mask.setAttribute("aria-labelledby", "aPickerTitle");
    var box = node("div"); box.id = "aFileBox";
    var title = node("div", "aTitleBar");
    var heading = node("h2"); heading.id = "aPickerTitle";
    var closeButton = button("×", function () { close(null); }, "aIcon");
    closeButton.setAttribute("aria-label", "取消选择");
    title.append(heading, closeButton);
    var tabs = node("div", "aTabs"); tabs.setAttribute("role", "tablist");
    var localTab = button("手机存储", function () { showLocal(); }); localTab.id = "aLocalTab";
    var netTab = button("网络存储", showNetwork); netTab.id = "aNetworkTab";
    [localTab, netTab].forEach(function (tab) { tab.setAttribute("role", "tab"); tabs.appendChild(tab); });
    shortcuts = node("div"); shortcuts.id = "aQuick";
    [["下载", "/sdcard/Download"], ["视频", "/sdcard/Movies"], ["内部存储", "/sdcard"]].forEach(function (item) {
      shortcuts.appendChild(button(item[0], function () { navigate(item[1]); }));
    });
    var head = node("div"); head.id = "aFileHead";
    var up = button("‹", goUp, "aIcon"); up.id = "aFileUp"; up.setAttribute("aria-label", "返回上一级");
    pathLabel = node("div"); pathLabel.id = "aFilePath";
    var refresh = button("↻", function () { if (page === "directory") navigate(requestedDir); else showSources(); }, "aIcon");
    refresh.setAttribute("aria-label", "刷新目录");
    head.append(up, pathLabel, refresh);
    var tools = node("div"); tools.id = "aFileTools"; tools.hidden = true;
    var sortLabel = node("label", "", "排序");
    var sort = node("select"); sort.id = "aFileSort";
    [["name", "文件名"], ["modified", "修改时间"], ["type", "类型"]].forEach(function (item) {
      var option = node("option", "", item[1]); option.value = item[0]; sort.appendChild(option);
    });
    sort.value = sortKey;
    sort.addEventListener("change", function () { sortKey = sort.value; sortDescending = sortKey === "modified"; saveView(); renderEntries(currentEntries); });
    sortLabel.appendChild(sort);
    var direction = button("", function () { sortDescending = !sortDescending; saveView(); renderEntries(currentEntries); }); direction.id = "aFileDirection";
    var view = button("", function () { if (attachmentMode()) return; gridView = !gridView; saveView(); renderEntries(currentEntries); }); view.id = "aFileView";
    tools.append(sortLabel, direction, view);
    list = node("div"); list.id = "aFileList"; list.setAttribute("role", "region"); list.setAttribute("aria-label", "文件列表");
    list.setAttribute("aria-live", "polite");
    list.addEventListener("scroll", rememberPosition, { passive: true });
    form = node("div"); form.id = "aSourceForm"; form.hidden = true;
    footer = node("div"); footer.id = "aFileBar";
    var layout = node("div", "aFileLayout");
    var sidebar = node("div", "aFileSidebar"); sidebar.append(tabs, shortcuts);
    var main = node("div", "aFileMain"); main.append(head, tools, list, form, footer);
    layout.append(sidebar, main); box.append(title, layout); mask.appendChild(box);
    document.body.appendChild(mask);
  }
  /* 非播放页的就地错误：显示在文件浏览器自己的列表状态区（复用既有 .aStatus 样式），
     不用紫色浮条，也不新增任何样式/占位块。返回 true 表示调用方不必再找别的落点。
     归属当前这次目录会话（noticeTicket）：选目录失败时壳层会先把浏览器恢复到那个目录，
     回包比对 generation 之后才认领，所以这里只排队，真正的插入在 renderEntries 末尾——
     否则会被 navigate 回包里的 list.replaceChildren() 抹掉。 */
  function notice(message) {
    if (!mask || mask.hidden) return false;
    noticeText = String(message || "");
    if (!noticeText) return false;
    noticeTicket = generation;
    paintNotice();
    return true;
  }
  function paintNotice() {
    if (noticeEl && noticeEl.parentNode) noticeEl.parentNode.removeChild(noticeEl);
    noticeEl = null;
    if (!noticeText || !list) return;
    noticeEl = node("div", "aStatus", noticeText);
    noticeEl.setAttribute("role", "alert");
    list.insertBefore(noticeEl, list.firstChild);
  }
  // 只清「比当前这次目录读取更早」的提示：它讲的是上一个目录的事。
  function clearStaleNotice() {
    if (!noticeText || noticeTicket >= generation) return;
    noticeText = "";
    if (noticeEl && noticeEl.parentNode) noticeEl.parentNode.removeChild(noticeEl);
    noticeEl = null;
  }
  function setSection(value) {
    section = value;
    document.getElementById("aLocalTab").setAttribute("aria-selected", String(value === "local"));
    document.getElementById("aNetworkTab").setAttribute("aria-selected", String(value === "network"));
    shortcuts.hidden = value !== "local";
  }
  function clearForm() {
    formVersion++;
    form.replaceChildren(); form.hidden = true; editing = null;
    list.hidden = false;
  }
  function status(message, retry) {
    clearThumbnails();
    list.classList.remove("is-grid");
    list.replaceChildren();
    var element = node("div", "aStatus", message);
    if (retry) element.appendChild(button("重试", retry));
    list.appendChild(element);
  }
  function updateFooter(ready) {
    footer.replaceChildren();
    footer.hidden = mode !== "dir" || !cwd || !form.hidden;
    if (footer.hidden) return;
    var name = ["/sdcard", "/storage/emulated/0"].includes(cwd) ? "手机存储" : cwd.split("/").pop();
    if (isNetwork(cwd) && cwd === rootFor(cwd)) name = (sourceFor(cwd) || {}).name || "共享根目录";
    footer.appendChild(node("p", "aSelection", "当前文件夹：" + name));
    var pick = button("使用此文件夹", function () { if (!pick.disabled) close(cwd); });
    pick.id = "aPickHere"; pick.disabled = !ready;
    footer.appendChild(pick);
  }
  function showLocal() { navigate(localDir); }
  function showNetwork() {
    if (networkDir) navigate(networkDir); else showSources();
  }
  function goUp() {
    if (!mask || mask.hidden) return;
    if (!form.hidden) { showSources(); return; }
    if (page === "sources") { close(null); return; }
    var dir = requestedDir;
    if (!dir || ["/sdcard", "/storage/emulated/0", "/storage", "/"].includes(dir)) { close(null); return; }
    if (isNetwork(dir)) {
      if (dir === rootFor(dir)) { showSources(); return; }
      navigate(dir.slice(0, dir.lastIndexOf("/"))); return;
    }
    navigate(dir.replace(/\/[^/]+\/?$/, "") || "/");
  }
  async function navigate(dir) {
    ensure(); rememberPosition(); clearForm();
    var ticket = ++generation;
    clearStaleNotice();   // 进入新目录：上一个目录留下的错误行不再适用
    dir = String(dir).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
    requestedDir = dir; cwd = ""; page = "directory"; pageReady = false;
    persistDirectory(dir);
    setSection(isNetwork(dir) ? "network" : "local");
    pathLabel.textContent = prettyPath(dir); pathLabel.title = pathLabel.textContent;
    document.getElementById("aFileHead").hidden = false;
    document.getElementById("aFileTools").hidden = true;
    updateFooter(false); status("正在读取目录…");
    try {
      var result = await invoke("list_dir", { dir: dir });
      if (ticket !== generation || mask.hidden) return;
      cwd = result.dir || dir;
      requestedDir = cwd; persistDirectory(cwd);
      pathLabel.textContent = prettyPath(cwd); pathLabel.title = pathLabel.textContent;
      renderEntries(result.entries || [], positions.get(positionKey(cwd))); pageReady = true; updateFooter(true);
    } catch (error) {
      if (ticket !== generation || mask.hidden) return;
      cwd = ""; updateFooter(false);
      status("无法读取目录\n" + (error.message || String(error)), function () { navigate(dir); });
    }
  }
  var thumbnailCleanups = [];
  function clearThumbnails() {
    thumbnailCleanups.forEach(function (cleanup) { cleanup(); });
    thumbnailCleanups = [];
  }
  function renderEntries(entries, position) {
    if (!position && pageReady) position = capturePosition();
    clearThumbnails();
    currentEntries = entries;
    var danmakuStems = danmakuStemSet(entries);
    list.replaceChildren(); list.scrollTop = 0;
    var displayedGrid = useGrid();
    list.classList.toggle("is-grid", displayedGrid);
    document.getElementById("aFileTools").hidden = false;
    document.getElementById("aFileView").hidden = attachmentMode();
    document.getElementById("aFileView").textContent = displayedGrid ? "列表" : "预览图";
    document.getElementById("aFileView").setAttribute("aria-label", displayedGrid ? "切换为列表" : "切换为预览图");
    document.getElementById("aFileView").setAttribute("aria-pressed", String(displayedGrid));
    document.getElementById("aFileDirection").textContent = sortKey === "modified" ? (sortDescending ? "新→旧" : "旧→新") : (sortDescending ? "降序 ↓" : "升序 ↑");
    entries = entries.filter(function (entry) { return entry.is_dir || acceptsFile(entry.name); });
    entries = window.AndroidFileOrder.sort(entries, sortKey, sortDescending);
    if (!entries.length) {
      var empty = mode === "subtitle" ? "此文件夹没有字幕或子文件夹（SRT / ASS / SSA / VTT）" :
        mode === "danmaku" ? "此文件夹没有弹幕或子文件夹（XML / JSON）" :
        "此文件夹没有视频或子文件夹" + (mode === "dir" ? "\n仍可使用下方按钮选择它" : "");
      status(empty);
      paintNotice();
      return;
    }
    entries.forEach(function (entry) {
      var row = button("", function () { if (entry.is_dir) navigate(entry.path); else if (mode !== "dir") close(entry.path); }, "aRow");
      row.dataset.path = entry.path;
      if (!entry.is_dir && displayedGrid) {
        var image = node("img", "aFileThumb"); image.alt = ""; row.appendChild(image);
        if (window.AndroidThumbnailsView) thumbnailCleanups.push(window.AndroidThumbnailsView.observe(image, entry.path, { size: entry.size, modified_ms: entry.modified_ms }));
      }
      row.appendChild(node("span", "aFileIcon", entry.is_dir ? "▰" : mode === "subtitle" ? "字" : mode === "danmaku" ? "弹" : "▷"));
      var detail = node("span", "aFileDetail");
      detail.appendChild(node("span", "aName", entry.name)); row.title = entry.name;
      var modified = window.AndroidFileOrder.timestamp(entry);
      var date = modified ? new Date(modified).toLocaleDateString("zh-CN") : "时间未知";
      detail.appendChild(node("span", "aMeta", entry.is_dir ? "文件夹" : [sizeText(entry.size), date].filter(Boolean).join(" · ")));
      row.appendChild(detail);
      if (!entry.is_dir && VIDEO.test(entry.name) && danmakuStems.has(baseName(entry.name))) {
        var badge = node("span", "aDanmaku", "弹幕");
        badge.setAttribute("aria-label", "有同名弹幕");
        row.appendChild(badge);
      }
      if (entry.is_dir) row.appendChild(node("span", "aArrow", "›"));
      if (!entry.is_dir && mode === "dir") row.disabled = true;
      list.appendChild(row);
    });
    restorePosition(position);
    if (pageReady) rememberPosition();
    // 列表刚被整体替换过：把排队中的就地错误插回列表顶部（选目录失败就靠这一步落位）
    paintNotice();
  }
  async function showSources() {
    ensure(); rememberPosition(); clearForm(); var ticket = ++generation;
    clearStaleNotice();
    page = "sources"; pageReady = false; requestedDir = ""; networkDir = "";
    try { localStorage.setItem("bplayer.android.networkDir", ""); } catch (error) {}
    setSection("network"); cwd = ""; updateFooter(false);
    document.getElementById("aFileHead").hidden = true;
    document.getElementById("aFileTools").hidden = true;
    clearThumbnails();
    status("正在读取已保存的连接…");
    try {
      var result = await request("network_sources");
      if (ticket !== generation || mask.hidden) return;
      sources = result;
      list.replaceChildren(); list.scrollTop = 0;
      sources.forEach(function (source) {
        var card = node("div", "aSource"); card.dataset.path = "source:" + source.id;
        var open = button("", function () { navigate(PREFIX + source.id); }, "aSourceOpen");
        open.appendChild(node("strong", "", source.name));
        open.appendChild(node("small", "", protocolName(source.protocol) + " · " + (source.protocol === "webdav" ? source.url : source.host + (source.share ? " / " + source.share : ""))));
        card.append(open, button("编辑", function () { openForm(source); }, "aEdit")); list.appendChild(card);
      });
      var add = button("＋ 添加网络存储", function () { openForm(null); }, "aAdd"); add.dataset.path = "source:add"; list.appendChild(add);
      var found = node("div", "aDiscovered"); found.hidden = true;
      var discover = button("⌕ 发现局域网 SMB", async function () {
        if (discover.disabled) return;
        discover.disabled = true; found.hidden = false; found.replaceChildren();
        var progress = node("div", "aFormMessage", "正在发现局域网 SMB…\n约需 7 秒，请保持连接同一 Wi-Fi。");
        found.appendChild(progress);
        try {
          var devices = await request("network_discover_smb");
          if (ticket !== generation || mask.hidden) return;
          found.replaceChildren();
          found.appendChild(node("p", "aNote", devices.length ? "发现 " + devices.length + " 台设备，点击后填写账号；共享名留空可浏览服务器共享。" : "没有发现设备。发现依赖服务器公告，同一网络的设备也可能不回应；仍可使用上方按钮填写 IP。"));
          devices.forEach(function (device) {
            var card = button("", function () {
              openForm({ name: device.name || device.host, protocol: "smb", host: device.host, port: device.port || 445 });
            }, "aRow");
            card.appendChild(node("span", "aName", device.name || device.host));
            card.appendChild(node("span", "aMeta", device.host)); found.appendChild(card);
          });
        } catch (error) {
          if (ticket !== generation || mask.hidden) return;
          progress.dataset.kind = "error"; progress.setAttribute("role", "alert");
          progress.textContent = "⚠ 发现失败\n" + (error.message || String(error));
        } finally { discover.disabled = false; }
      }, "aDiscovery");
      discover.id = "aDiscoverSmb"; list.append(discover, found);
      list.appendChild(node("p", "aNote", "SMB 2.1 / 3 · HTTPS WebDAV · SFTP\n连接信息加密保存在本机；播放按需读取。音轨兼容处理会读取整段影片，并在有写权限时将 AAC 缓存保存到视频同目录；原视频不修改。"));
      restorePosition(positions.get(positionKey("sources"))); pageReady = true;
    } catch (error) {
      if (ticket !== generation || mask.hidden) return;
      status(error.message, showSources);
    }
  }
  function protocolName(protocol) { return { smb: "SMB", webdav: "WebDAV", sftp: "SFTP" }[protocol] || protocol; }
  function openForm(source) {
    rememberPosition(); ++generation; page = "form"; pageReady = false;
    clearForm(); editing = source || {}; var version = formVersion;
    var existing = !!(source && source.id);
    setSection("network"); cwd = ""; list.hidden = true; form.hidden = false; footer.hidden = true;
    document.getElementById("aFileHead").hidden = true;
    document.getElementById("aFileTools").hidden = true;
    clearThumbnails();
    form.appendChild(button("‹ 返回连接列表", showSources));
    form.appendChild(node("h3", "", existing ? "编辑网络存储" : "添加网络存储"));
    var grid = node("div", "aFormGrid"); form.appendChild(grid);
    var fields = {};
    function field(key, label, placeholder, wide, type) {
      var wrapper = node("label", "aField" + (wide ? " wide" : ""));
      wrapper.appendChild(node("span", "", label));
      var input = node("input"); input.type = type || "text"; input.placeholder = placeholder || "";
      input.value = editing[key] || ""; input.name = key; input.autocomplete = "off";
      input.spellcheck = false; if (type === "number") { input.min = "1"; input.max = "65535"; input.inputMode = "numeric"; }
      wrapper.appendChild(input); grid.appendChild(wrapper); fields[key] = input;
      return wrapper;
    }
    var protocolWrapper = node("label", "aField wide"); protocolWrapper.appendChild(node("span", "", "连接协议"));
    var protocol = node("select"); protocol.name = "protocol";
    [["smb", "SMB 2.1 / 3（局域网共享）"], ["webdav", "WebDAV（HTTPS）"], ["sftp", "SFTP（SSH 2）"]].forEach(function (item) {
      var option = node("option", "", item[1]); option.value = item[0]; protocol.appendChild(option);
    });
    protocol.value = editing.protocol || "smb"; protocolWrapper.appendChild(protocol); grid.appendChild(protocolWrapper);
    field("name", "连接名称", "例如：家里的 NAS", true);
    var host = field("host", "服务器地址", "IP 或主机名", false);
    var port = field("port", "端口", "445", false, "number");
    var url = field("url", "WebDAV 地址", "https://nas.example.com/dav/", true, "url");
    var share = field("share", "共享名称（可选）", "留空列出服务器共享；也可填写共享名直达", true);
    if (existing && editing.protocol === "smb" && editing.scope === "server") fields.share.readOnly = true;
    var root = field("root", "起始文件夹（可选）", "留空从根目录浏览", true);
    field("username", "用户名", "服务器用户名", false);
    field("password", "密码", source && source.hasPassword ? "留空保留原密码" : "服务器密码", false, "password");
    var domain = field("domain", "域（可选）", "一般留空", true);
    var hint = node("p", "aNote"); form.appendChild(hint);
    var fingerprint = node("div", "aFingerprint"); fingerprint.hidden = true;
    fingerprint.appendChild(node("strong", "", "核对 SSH 服务器指纹"));
    fingerprint.appendChild(node("p", "aNote", "请与服务器管理员提供的 SHA256 指纹核对。匹配后再勾选；不匹配不要保存。"));
    var fingerprintValue = node("code"); fingerprint.appendChild(fingerprintValue);
    var trustLabel = node("label", "aTrust"); var trust = node("input"); trust.type = "checkbox";
    trustLabel.append(trust, node("span", "", "我已核对上述服务器指纹，确认匹配")); fingerprint.appendChild(trustLabel); form.appendChild(fingerprint);
    var hostKey = editing.hostKey || "";
    function updateProtocol(reset) {
      var value = protocol.value;
      host.hidden = port.hidden = value === "webdav"; url.hidden = value !== "webdav";
      share.hidden = domain.hidden = value !== "smb"; root.hidden = value === "webdav";
      if (reset) { fields.port.value = ""; hostKey = ""; trust.checked = false; fingerprint.hidden = true; }
      fields.port.placeholder = value === "sftp" ? "22" : "445";
      hint.textContent = value === "smb" ? "只协商 SMB 2.1 / 3，不支持 SMB1。共享名称留空时列出服务器公布的文件共享，进入后验证读取权限；服务器不允许列举时可填写已知共享名直达。建议使用只读账号。" : value === "webdav" ? "仅接受 HTTPS，校验证书，不提供跳过证书校验。地址需指向支持列目录与 Range 的 WebDAV 服务。" : "使用 SSH 2 加密传输。首次连接必须核对服务器指纹；当前支持用户名和密码登录。";
    }
    protocol.addEventListener("change", function () { updateProtocol(true); }); updateProtocol(false);
    [fields.host, fields.port].forEach(function (input) { input.addEventListener("input", function () { hostKey = ""; trust.checked = false; fingerprint.hidden = true; }); });
    var message = node("div", "aFormMessage"); message.setAttribute("role", "status"); form.appendChild(message);
    function showMessage(text, kind) {
      message.dataset.kind = kind || "info";
      message.setAttribute("role", kind === "error" ? "alert" : "status");
      message.textContent = (kind === "error" ? "⚠ 连接失败\n" : kind === "success" ? "✓ " : "") + text;
      message.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
    var actions = node("div", "aFormActions"); var busy = false;
    function config() {
      var value = { id: editing.id || "", protocol: protocol.value };
      Object.keys(fields).forEach(function (key) { value[key] = key === "password" ? fields[key].value : fields[key].value.trim(); });
      value.port = value.port ? Number(value.port) : (value.protocol === "sftp" ? 22 : 445);
      if (!value.name) throw new Error("请填写连接名称");
      if (value.protocol === "webdav") {
        if (!/^https:\/\//i.test(value.url)) throw new Error("WebDAV 地址必须以 https:// 开头");
        value.root = "";
      } else if (!value.host) throw new Error("请填写服务器地址");
      if (value.protocol === "smb") {
        value.scope = existing && editing.protocol === "smb" ? (editing.scope || "share") : (value.share ? "share" : "server");
        if (value.scope === "share" && !value.share) throw new Error("原连接绑定了指定共享，不能清空；请新建连接以浏览服务器共享");
        if (value.scope === "server" && value.root) throw new Error("浏览服务器共享时请留空起始文件夹；需要直达目录可填写共享名新建连接");
      }
      if (value.port < 1 || value.port > 65535 || !Number.isInteger(value.port)) throw new Error("端口必须是 1–65535 的整数");
      if (value.protocol === "sftp") {
        if (!fingerprint.hidden && !trust.checked) throw new Error("请先核对并确认服务器指纹");
        value.hostKey = hostKey;
      }
      return value;
    }
    async function run(save) {
      if (busy) return;
      try {
        var value = config(); busy = true; testButton.disabled = saveButton.disabled = true;
        Array.from(grid.querySelectorAll("input,select")).forEach(function (input) { input.disabled = true; });
        showMessage(save ? "正在验证并保存连接…" : "正在测试连接…");
        var result = await request(save ? "network_save" : "network_test", { source: value });
        if (version !== formVersion || mask.hidden) return;
        if (result && result.fingerprintRequired) {
          hostKey = result.hostKey; fingerprintValue.textContent = hostKey; fingerprint.hidden = false; trust.checked = false;
          showMessage("已读取服务器指纹。请先核对，再点击测试或保存。");
          fingerprint.scrollIntoView({ block: "nearest", behavior: "smooth" });
          return;
        }
        if (save) { fields.password.value = ""; await showSources(); }
        else if (value.protocol === "smb" && value.scope === "server") {
          var shared = result.entries || [];
          showMessage("已认证，服务器公布了 " + shared.length + " 个文件共享。\n" + shared.slice(0, 12).map(function (entry) { return entry.name; }).join("、") + "\n共享可见不代表有读取权限，保存后进入共享时验证。", "success");
        } else showMessage("连接成功，可以浏览文件。点击“保存连接”后才会记住。", "success");
      } catch (error) { if (version === formVersion && !mask.hidden) showMessage(error.message || String(error), "error"); }
      finally {
        busy = false;
        if (version === formVersion) {
          testButton.disabled = saveButton.disabled = false;
          Array.from(grid.querySelectorAll("input,select")).forEach(function (input) { input.disabled = false; });
        }
      }
    }
    var testButton = button("测试连接", function () { run(false); });
    var saveButton = button("保存连接", function () { run(true); }, "aSave");
    actions.append(testButton, saveButton); form.appendChild(actions);
    if (existing) {
      var confirm = node("div", "aDangerConfirm"); confirm.hidden = true;
      confirm.appendChild(node("p", "aNote", "只移除此设备保存的连接，不会删除服务器上的文件。"));
      confirm.appendChild(button("确认移除连接", async function () {
        if (busy) return;
        busy = true; this.disabled = true;
        try {
          await request("network_remove", { id: source.id });
          if (version === formVersion && !mask.hidden) await showSources();
        } catch (error) { if (version === formVersion) { showMessage(error.message || String(error), "error"); this.disabled = false; } }
        finally { busy = false; }
      }, "aDanger"));
      confirm.appendChild(button("取消", function () { confirm.hidden = true; }));
      form.appendChild(button("移除此连接", function () { confirm.hidden = false; }, "aDanger")); form.appendChild(confirm);
    }
    form.scrollTop = 0;
  }
  function beginPicker(value) {
    ensure();
    if (window.AndroidNavigation && window.AndroidNavigation.invalidate) window.AndroidNavigation.invalidate();
    if (resolvePicker) close(null);
    selection = null;
    mode = MODES.includes(value) ? value : "file"; mask.hidden = false;
    pageReady = false;
    document.getElementById("aPickerTitle").textContent = pickerTitle();
    document.getElementById("aFileView").hidden = attachmentMode();
    return new Promise(function (resolve) { resolvePicker = resolve; });
  }
  function open(value, startSection, startDir) {
    var result = beginPicker(value);
    if (startDir) navigate(startDir);
    else if (startSection === "network") showNetwork(); else showLocal();
    return result;
  }
  function takeSelection(path) {
    if (!selection || selection.selectedPath !== String(path || "")) return null;
    var selected = selection; selection = null;
    return selected;
  }
  function restore(saved) {
    if (!saved || saved.version !== 1 || !MODES.includes(saved.mode) ||
      !["local", "network"].includes(saved.section) || typeof saved.requestedDir !== "string") {
      return Promise.resolve(null);
    }
    var result = beginPicker(saved.mode);
    sortKey = ["name", "modified", "type"].includes(saved.sort) ? saved.sort : "name";
    sortDescending = saved.descending === true;
    if (!attachmentMode()) gridView = saved.grid === true;
    document.getElementById("aFileSort").value = sortKey; saveView();
    if (typeof saved.localDir === "string" && saved.localDir && !isNetwork(saved.localDir)) localDir = saved.localDir;
    if (typeof saved.networkDir === "string" && (!saved.networkDir || isNetwork(saved.networkDir))) networkDir = saved.networkDir;
    positions.set(positionKey("sources"), copyPosition(saved.sourcesPosition));
    if (saved.requestedDir) {
      positions.set(positionKey(saved.requestedDir), copyPosition(saved.position));
      navigate(saved.requestedDir);
    } else if (saved.section === "network") showSources(); else showLocal();
    return result;
  }
  function close(value) {
    rememberPosition();
    selection = value && resolvePicker ? snapshot(String(value)) : null;
    ++generation;
    pageReady = false;
    clearThumbnails();
    noticeText = "";   // 关掉浏览器就收掉这条就地错误，下次打开不该看见上次的失败
    if (noticeEl && noticeEl.parentNode) noticeEl.parentNode.removeChild(noticeEl);
    noticeEl = null;
    if (mask) { mask.hidden = true; clearForm(); }
    var resolve = resolvePicker; resolvePicker = null;
    if (resolve) resolve(value || null);
  }
  function back() {
    if (!mask || mask.hidden) return false;
    goUp();
    return true;
  }
  window.AndroidFiles = { open: open, close: close, back: back, takeSelection: takeSelection, restore: restore,
    notice: notice,
    get active() { return !!(mask && !mask.hidden); },
    invoke: invoke, mediaUrl: mediaUrl, isNetwork: isNetwork };
})();
