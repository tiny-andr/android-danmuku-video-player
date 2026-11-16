(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.AndroidSidecars = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var MAX_BYTES = 32 * 1024 * 1024;
  var LANGUAGES = ["auto", "zh-Hans", "zh-Hant", "en", "ja", "ko"];
  var COLORS = ["#ffffff", "#ffff00", "#00ffff"];

  function decode(bytes) {
    if (!(bytes instanceof Uint8Array)) throw new Error("Sidecar input must be bytes");
    if (bytes.byteLength > MAX_BYTES) throw new Error("Sidecar exceeds 32 MiB");
    var encoding = "utf-8";
    var offset = 0;
    if (bytes.length >= 3 && bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191) offset = 3;
    else if (bytes.length >= 2 && bytes[0] === 255 && bytes[1] === 254) { encoding = "utf-16le"; offset = 2; }
    else if (bytes.length >= 2 && bytes[0] === 254 && bytes[1] === 255) { encoding = "utf-16be"; offset = 2; }
    var text;
    try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(offset)); }
    catch (error) {
      if (offset || encoding !== "utf-8") throw new Error("Invalid sidecar text encoding");
      try { text = new TextDecoder("gbk", { fatal: true }).decode(bytes); }
      catch (fallbackError) { throw new Error("Invalid sidecar text encoding"); }
    }
    text = text.replace(/^\uFEFF/, "");
    if (text.indexOf("\0") !== -1) throw new Error("Sidecar contains NUL characters");
    return text;
  }

  function normalizeText(text) {
    if (typeof text !== "string" || text.length > MAX_BYTES || text.indexOf("\0") !== -1) throw new Error("Invalid subtitle text");
    return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  }

  function entities(text) {
    var named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
    return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, function (match, entity) {
      if (entity.charAt(0) !== "#") return named[entity.toLowerCase()];
      var value = entity.charAt(1).toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return value > 0 && value <= 1114111 && !(value >= 55296 && value <= 57343) ? String.fromCodePoint(value) : "\ufffd";
    });
  }

  function plainText(text) {
    return entities(text.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>\n]*>/g, ""))
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
      .split("\n").map(function (line) { return line.trim(); }).filter(Boolean).join("\n").trim();
  }

  function escapeVtt(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function milliseconds(value) {
    var match = String(value).trim().match(/^(?:(\d{1,6}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/);
    if (!match || Number(match[2]) >= 60 || Number(match[3]) >= 60) return null;
    var fraction = (match[4] || "").padEnd(3, "0");
    return ((Number(match[1] || 0) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000 + Number(fraction);
  }

  function timestamp(value) {
    var hours = Math.floor(value / 3600000);
    var minutes = Math.floor(value / 60000) % 60;
    var seconds = Math.floor(value / 1000) % 60;
    return String(hours).padStart(2, "0") + ":" + String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0") + "." + String(value % 1000).padStart(3, "0");
  }

  function cue(start, end, text) {
    var first = milliseconds(start);
    var last = milliseconds(end);
    if (first == null || last == null || last <= first) throw new Error("Invalid subtitle cue time");
    var body = plainText(text);
    return body ? { start: first, end: last, text: body } : null;
  }

  function parseTimed(text, type) {
    if (type === "vtt") {
      if (!/^WEBVTT(?:[ \t].*)?(?:\n|$)/.test(text)) throw new Error("Invalid WebVTT header");
      var headerEnd = text.indexOf("\n\n");
      text = headerEnd < 0 ? "" : text.slice(headerEnd + 2);
    }
    var output = [];
    text.split(/\n[ \t]*\n/).forEach(function (block) {
      var lines = block.trim().split("\n");
      if (!lines[0]) return;
      if (type === "vtt" && /^(?:NOTE(?:[ \t]|$)|STYLE$|REGION$)/.test(lines[0])) return;
      var timingIndex = lines[0].indexOf("-->") >= 0 ? 0 : 1;
      var timing = lines[timingIndex] || "";
      var match = timing.match(/^\s*(\S+)\s+-->\s+(\S+)(?:[ \t].*)?$/);
      if (!match) throw new Error("Invalid subtitle cue block");
      var entry = cue(match[1], match[2], lines.slice(timingIndex + 1).join("\n").replace(/\{[^}]*\}/g, ""));
      if (entry) output.push(entry);
    });
    return output;
  }

  function assText(text) {
    var drawing = false;
    var output = "";
    var expression = /\{([^}]*)\}|([^{}]+)/g;
    var match;
    while ((match = expression.exec(text))) {
      if (match[1] !== undefined) {
        var commands = match[1].match(/\\p\s*\d+(?![a-z])/gi) || [];
        commands.forEach(function (command) { drawing = Number(command.replace(/^\\p\s*/i, "")) > 0; });
      } else if (!drawing) output += match[2];
    }
    return output.replace(/\\[Nn]/g, "\n").replace(/\\h/g, "\u00a0");
  }

  function parseAss(text, type) {
    var section = "";
    var fields = type === "ssa" ? ["marked", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text"]
      : ["layer", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text"];
    var output = [];
    text.split("\n").forEach(function (line) {
      var header = line.trim().match(/^\[([^\]]+)\]$/);
      if (header) { section = header[1].toLowerCase(); return; }
      if (section !== "events") return;
      var format = line.match(/^\s*Format\s*:\s*(.*)$/i);
      if (format) {
        fields = format[1].split(",").map(function (field) { return field.trim().toLowerCase(); });
        if (new Set(fields).size !== fields.length || ["start", "end", "text"].some(function (field) { return fields.indexOf(field) < 0; })) throw new Error("Invalid ASS event format");
        return;
      }
      var dialogue = line.match(/^\s*Dialogue\s*:\s*(.*)$/i);
      if (!dialogue) return;
      var parts = dialogue[1].split(",");
      if (parts.length < fields.length) throw new Error("Invalid ASS dialogue");
      var textIndex = fields.indexOf("text");
      var trailing = fields.length - textIndex - 1;
      var values = parts.slice(0, textIndex).concat([parts.slice(textIndex, parts.length - trailing).join(",")], trailing ? parts.slice(-trailing) : []);
      var entry = cue(values[fields.indexOf("start")], values[fields.indexOf("end")], assText(values[textIndex]));
      if (entry) output.push(entry);
    });
    return output;
  }

  function toVtt(text, type) {
    text = normalizeText(text);
    type = String(type || "").replace(/^\./, "").toLowerCase();
    if (["srt", "vtt", "ass", "ssa"].indexOf(type) < 0) throw new Error("Unsupported subtitle type");
    var cues = type === "ass" || type === "ssa" ? parseAss(text, type) : parseTimed(text, type);
    if (!cues.length) throw new Error("Subtitle has no text cues");
    if (cues.length > 100000) throw new Error("Subtitle has too many cues");
    cues.sort(function (left, right) { return left.start - right.start || left.end - right.end; });
    return "WEBVTT\n\n" + cues.map(function (entry, index) {
      return String(index + 1) + "\n" + timestamp(entry.start) + " --> " + timestamp(entry.end) + "\n" + escapeVtt(entry.text);
    }).join("\n\n") + "\n";
  }

  function canonicalLanguage(value) {
    value = String(value || "").trim().toLowerCase().replace(/_/g, "-");
    if (/^(?:zh-hans|zh-cn|zh-sg|chs|sc|简中|简体|简体中文)$/.test(value)) return "zh-Hans";
    if (/^(?:zh-hant|zh-tw|zh-hk|zh-mo|cht|tc|繁中|繁体|繁體|繁体中文|繁體中文)$/.test(value)) return "zh-Hant";
    if (/^(?:en|eng|english)$/.test(value)) return "en";
    if (/^(?:ja|jpn|japanese|日语|日語)$/.test(value)) return "ja";
    if (/^(?:ko|kor|korean|韩语|韓語)$/.test(value)) return "ko";
    return "unknown";
  }

  function stem(name) {
    return String(name || "").replace(/\\/g, "/").split("/").pop().replace(/\.(?:srt|ass|ssa|vtt|mp4|m4v|webm|mov|mkv|avi|ts|flv|wmv|mpg|mpeg)$/i, "");
  }

  function language(name) {
    var base = stem(name);
    var bracketed = base.match(/\[[^\]]+\]|\([^)]*\)|【[^】]+】/g) || [];
    for (var index = bracketed.length - 1; index >= 0; index--) {
      var candidate = canonicalLanguage(bracketed[index].slice(1, -1));
      if (candidate !== "unknown") return candidate;
    }
    base = base.replace(/(?:[._ -](?:forced|sdh|cc|default|字幕))+$/i, "");
    var suffix = base.match(/[._\s-](zh[-_]hans|zh[-_]hant|zh[-_](?:cn|sg|tw|hk|mo)|chs|cht|eng|en|jpn|ja|kor|ko|简中|简体|繁中|繁体|繁體)$/i);
    return suffix ? canonicalLanguage(suffix[1]) : "unknown";
  }

  function preferences(value) {
    value = value && typeof value === "object" ? value : {};
    var color = typeof value.color === "string" ? value.color.toLowerCase() : "";
    return { fontSize: [18, 24, 30, 36].indexOf(value.fontSize) >= 0 ? value.fontSize : 18,
      color: COLORS.indexOf(color) >= 0 ? color : "#ffffff",
      outline: [0, 2, 4].indexOf(value.outline) >= 0 ? value.outline : 0,
      position: value.position === "below" ? "below" : "inside",
      language: LANGUAGES.indexOf(value.language) >= 0 ? value.language : "auto" };
  }

  function pickSubtitle(items, videoName, preferred) {
    var video = stem(videoName).toLowerCase();
    preferred = LANGUAGES.indexOf(preferred) >= 0 ? preferred : "auto";
    var ranked = (Array.isArray(items) ? items : []).filter(function (item) { return item && !item.disabled; }).map(function (item, index) {
      var name = stem(item.name).toLowerCase();
      var external = item.kind === "ext";
      var match = external && name === video ? 0 : external && video && name.indexOf(video + ".") === 0 ? 1 : item.kind === "embedded" ? 2 : external ? 3 : 4;
      var detected = canonicalLanguage(item.lang);
      if (detected === "unknown") detected = language(item.name);
      return { item: item, index: index, match: match, preferred: preferred !== "auto" && detected === preferred ? 0 : 1 };
    });
    ranked.sort(function (left, right) {
      var leftGroup = left.match <= 1 ? 0 : left.match;
      var rightGroup = right.match <= 1 ? 0 : right.match;
      return leftGroup - rightGroup || left.preferred - right.preferred || left.match - right.match || Number(!!right.item.default) - Number(!!left.item.default) || left.index - right.index;
    });
    return ranked.length ? ranked[0].item : null;
  }

  return { decode: decode, toVtt: toVtt, cueText: entities, language: language, preferences: preferences, pickSubtitle: pickSubtitle };
});
