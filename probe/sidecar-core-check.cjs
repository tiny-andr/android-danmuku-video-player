const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sidecars = require('../bplayer-android/ui/android-sidecars.js');

let groups = 0;
function group(name, test) {
  test(); groups++;
  console.log('PASS ' + name);
}
function utf8(text) { return new Uint8Array(Buffer.from(text, 'utf8')); }
function ass(body, format = 'Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text') {
  return '[Script Info]\nScriptType: v4.00+\n[V4+ Styles]\nStyle: Default,Arial,56,&H00FF00\n[Events]\nFormat: ' + format + '\n' + body;
}
function textCue(body) { return '1\n00:00:01,000 --> 00:00:03,000\n' + body; }

group('UMD exports work without a DOM', () => {
  const context = vm.createContext({ Uint8Array, TextDecoder, Set });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../bplayer-android/ui/android-sidecars.js'), 'utf8'), context);
  assert.equal(typeof context.AndroidSidecars.decode, 'function');
  assert.equal(context.AndroidSidecars.decode(utf8('字幕')), '字幕');
  assert.deepEqual(Object.keys(sidecars).sort(), ['cueText', 'decode', 'language', 'pickSubtitle', 'preferences', 'toVtt']);
});
group('UTF-8, BOM, UTF-16LE/BE and GBK decoding', () => {
  assert.equal(sidecars.decode(utf8('字幕 😀')), '字幕 😀');
  assert.equal(sidecars.decode(new Uint8Array([239, 187, 191, ...utf8('字幕')])), '字幕');
  const little = Buffer.from('字幕 😀', 'utf16le');
  assert.equal(sidecars.decode(new Uint8Array([255, 254, ...little])), '字幕 😀');
  const big = Buffer.from(little); big.swap16();
  assert.equal(sidecars.decode(new Uint8Array([254, 255, ...big])), '字幕 😀');
  assert.equal(sidecars.decode(new Uint8Array([214, 208, 206, 196])), '中文');
  assert.equal(sidecars.decode(new Uint8Array()), '');
});
group('Decode rejects NUL, malformed BOM encodings and over-budget data', () => {
  assert.throws(() => sidecars.decode(utf8('hello\0world')), /NUL/);
  assert.throws(() => sidecars.decode(new Uint8Array([255, 254, 0])), /encoding/);
  assert.throws(() => sidecars.decode(new Uint8Array([239, 187, 191, 255])), /encoding/);
  assert.throws(() => sidecars.decode(new Uint8Array([129])), /encoding/);
  assert.throws(() => sidecars.decode(new Uint8Array(32 * 1024 * 1024 + 1)), /32 MiB/);
  assert.throws(() => sidecars.decode('not bytes'), /bytes/);
});
group('SRT emits proper header, cue separators, sorted timestamps and multiline text', () => {
  const output = sidecars.toVtt('2\r\n00:00:04,5 --> 00:00:05,55\r\nLater\r\n\r\n1\r\n00:00:01,000 --> 00:00:03,000\r\n中文\r\nSecond line', 'srt');
  assert.equal(output, 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\n中文\nSecond line\n\n2\n00:00:04.500 --> 00:00:05.550\nLater\n');
  assert.equal(sidecars.toVtt('00:01.0 --> 00:02.0\nNo index', '.SRT'), 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nNo index\n');
});
group('VTT strips style, region, note and cue positioning while retaining text', () => {
  const input = 'WEBVTT subtitle file\nLanguage: en\n\nSTYLE\n::cue { color: red; }\n\nREGION\nid:example\n\nNOTE ignored\nanything\n\ncue-id\n00:01.000 --> 00:03.000 align:start position:20%\n<c.red>Hello</c> <00:01.500><b>world</b>\n';
  assert.equal(sidecars.toVtt(input, 'vtt'), 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\nHello world\n');
});
group('ASS accepts multi-digit layers and preserves text commas and line breaks', () => {
  const output = sidecars.toVtt(ass('Dialogue: 10,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\an8\\pos(10,20)\\c&HFF0000&\\k20}Hello, friend\\N中文\\h字幕'), 'ass');
  assert.equal(output, 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\nHello, friend\n中文\u00a0字幕\n');
});
group('SSA accepts Marked and custom Events field order including Text in the middle', () => {
  const ssa = '[Script Info]\nScriptType: v4.00\n[Events]\nFormat: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: Marked=0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Traditional SSA';
  assert.match(sidecars.toVtt(ssa, 'ssa'), /\nTraditional SSA\n$/);
  const reordered = ass('Dialogue: 0:00:03.00,Hello, comma text,0:00:01.00,12', 'End, Text, Start, Layer');
  assert.equal(sidecars.toVtt(reordered, 'ass'), 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\nHello, comma text\n');
});
group('ASS drawings are discarded and p0 text resumes; script/style metadata is ignored', () => {
  const output = sidecars.toVtt(ass('Comment: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Hidden\nDialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\p1}m 0 0 l 100 100{\\p0}Actual text'), 'ass');
  assert.match(output, /\nActual text\n$/);
  assert(!output.includes('m 0 0')); assert(!output.includes('Hidden')); assert(!output.includes('Arial'));
  assert.throws(() => sidecars.toVtt(ass('Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\p1}m 0 0 l 10 10'), 'ass'), /no text cues/);
});
group('Pure text VTT strips executable markup and escapes literal syntax safely', () => {
  const output = sidecars.toVtt(textCue('<b>Visible</b><script>alert(1)</script><style>bad</style><img src=x onerror=alert(2)>\nA &amp; B &lt; C &gt; D\n&lt;img src=x onerror=literal&gt;'), 'srt');
  assert(!output.includes('<script')); assert(!output.includes('<img')); assert(!output.includes('alert(1)'));
  assert(output.includes('Visible\nA &amp; B &lt; C &gt; D'));
  assert(output.includes('&lt;img src=x onerror=literal&gt;'));
  assert.equal(sidecars.cueText(output.split('\n')[5]), 'A & B < C > D');
});
group('Cue entity decoding is exactly one pass with bounded Unicode scalar values', () => {
  assert.equal(sidecars.cueText('&amp;lt; &lt; &gt; &quot; &apos; &nbsp; &#65; &#x1F600;'), '&lt; < > " \' \u00a0 A 😀');
  assert.equal(sidecars.cueText('&unknown; &AMP; &#0; &#xD800; &#x110000;'), '&unknown; & � � �');
  const output = sidecars.toVtt(textCue('&amp;lt; literal'), 'srt');
  assert.match(output, /&amp;lt; literal/);
  assert.equal(sidecars.cueText(output.split('\n')[4]), '&lt; literal');
});
group('Malformed, empty, unsupported and invalid-timing subtitles fail explicitly', () => {
  for (const [input, type] of [['', 'srt'], ['plain text', 'srt'], ['WEBVTT\n\nNOTE only', 'vtt'], ['not WEBVTT\n\n00:01 --> 00:02\nX', 'vtt'],
    [textCue('X'), 'png'], ['1\n00:60:01,000 --> 00:61:01,000\nX', 'srt'], ['1\n00:00:03,000 --> 00:00:01,000\nX', 'srt'],
    ['1\n00:00:01,000 --> 00:00:01,000\nX', 'srt'], ['[Events]\nFormat: Layer, Start, Text\nDialogue: 0,0:00:01.00,X', 'ass'],
    ['[Events]\nFormat: Start, End, Text, Text', 'ass'], [textCue('\0'), 'srt']]) assert.throws(() => sidecars.toVtt(input, type));
});
group('Language detection recognizes only bracket labels and trailing canonical tags', () => {
  for (const [name, expected] of [['Movie.zh-Hans.srt', 'zh-Hans'], ['Movie.zh_cn.ass', 'zh-Hans'], ['Movie.CHS.forced.srt', 'zh-Hans'],
    ['Movie.[繁體中文].srt', 'zh-Hant'], ['Movie.zh-TW.srt', 'zh-Hant'], ['Movie.en.sdh.vtt', 'en'], ['Movie.ENG.srt', 'en'],
    ['Movie.[English].ass', 'en'], ['Movie.jpn.srt', 'ja'], ['Movie.ko.srt', 'ko'], ['The.English.Patient.1996.srt', 'unknown'],
    ['Japanese.Story.srt', 'unknown'], ['The.en.Movie.srt', 'unknown'], ['Movie.zh.srt', 'unknown'], ['Movie.srt', 'unknown']]) {
    assert.equal(sidecars.language(name), expected, name);
  }
});
group('Preferences are a fresh normalized whitelist without injected CSS', () => {
  assert.deepEqual(sidecars.preferences(null), { fontSize: 18, color: '#ffffff', outline: 0, position: 'inside', language: 'auto' });
  assert.deepEqual(sidecars.preferences({ fontSize: 36, color: '#FFFF00', outline: 4, position: 'below', language: 'zh-Hant', hidden: true }), { fontSize: 36, color: '#ffff00', outline: 4, position: 'below', language: 'zh-Hant' });
  assert.deepEqual(sidecars.preferences({ fontSize: '30', color: 'red;display:none', outline: -1, language: 'xx' }), { fontSize: 18, color: '#ffffff', outline: 0, position: 'inside', language: 'auto' });
  for (const fontSize of [18, 24, 30, 36]) assert.equal(sidecars.preferences({ fontSize }).fontSize, fontSize);
  for (const outline of [0, 2, 4]) assert.equal(sidecars.preferences({ outline }).outline, outline);
  assert.equal(sidecars.preferences({ color: '#00ffff' }).color, '#00ffff');
});
group('Automatic selection uses filename ownership, preference, default and stable order', () => {
  const exact = { kind: 'ext', name: 'Movie.srt' };
  const english = { kind: 'ext', name: 'Movie.en.srt' };
  const chinese = { kind: 'ext', name: 'Movie.zh-Hans.srt' };
  const embedded = { kind: 'embedded', name: 'Embedded', lang: 'eng', default: true };
  const unrelated = { kind: 'ext', name: 'Unrelated.en.srt' };
  assert.equal(sidecars.pickSubtitle([unrelated, embedded, chinese, english, exact], 'Movie.mkv', 'en'), english);
  assert.equal(sidecars.pickSubtitle([exact, english, chinese], 'Movie.mkv', 'zh-Hans'), chinese);
  assert.equal(sidecars.pickSubtitle([exact, english, chinese], 'Movie.mkv', 'auto'), exact);
  assert.equal(sidecars.pickSubtitle([unrelated, exact], 'Movie.mkv', 'en'), exact);
  assert.equal(sidecars.pickSubtitle([unrelated, chinese], 'Movie.mkv', 'en'), chinese);
  assert.equal(sidecars.pickSubtitle([chinese, english], 'Movie.mkv', 'en'), english);
  assert.equal(sidecars.pickSubtitle([chinese, english], 'Movie.mkv', 'auto'), chinese);
  assert.equal(sidecars.pickSubtitle([unrelated, embedded], 'Movie.mkv', 'en'), embedded);
  const secondEmbedded = { kind: 'embedded', name: 'Other', lang: 'jpn' };
  assert.equal(sidecars.pickSubtitle([embedded, secondEmbedded], 'Movie.mkv', 'ja'), secondEmbedded);
  assert.equal(sidecars.pickSubtitle([{ kind: 'ext', name: 'Movie.srt', disabled: true }, english], 'Movie.mkv', 'auto'), english);
  assert.equal(sidecars.pickSubtitle([], 'Movie.mkv', 'auto'), null);
  assert.equal(sidecars.pickSubtitle(null, 'Movie.mkv', 'auto'), null);
});
console.log('Sidecar core: ' + groups + ' groups passed');
