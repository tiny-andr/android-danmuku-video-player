const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../tmp/sidecar-device-fixtures-a6d93182');
fs.mkdirSync(root, { recursive: true });
const srt = '1\n00:00:01,000 --> 00:00:04,000\n第一行：字幕测试\n第二行 & 中文\n\n2\n00:00:05,000 --> 00:00:08,000\n稍后的字幕\n';
const fixtures = {
  'dialog.zh-Hans.srt': srt,
  'dialog.en.srt': '1\n00:00:01,000 --> 00:00:04,000\nEnglish subtitle\n',
  'dialog.vtt': 'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nVTT subtitle &amp; text\n',
  'dialog.ass': '[Script Info]\nScriptType: v4.00+\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 10,0:00:01.00,0:00:04.00,Default,,0,0,0,,ASS 字幕\\N第二行,保留逗号\n',
  'dialog.ssa': '[Events]\nFormat: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: Marked=0,0:00:01.00,0:00:04.00,Default,,0,0,0,,SSA subtitle\n',
  'comments.json': JSON.stringify([{ time: 1, mode: 0, color: '#ffffff', text: '手选弹幕一' }, { time: 2, mode: 1, color: '#ffff00', text: '手选弹幕二' }]),
  'comments.xml': '<i><d p="1,1,25,16777215,0,0,0,0">XML 弹幕一</d><d p="2,5,25,16776960,0,0,0,0">XML 弹幕二</d></i>',
  'invalid.srt': 'not a subtitle', 'invalid.json': '{"wrong":"format"}', 'invalid.xml': '<not-danmaku/>',
};
for (const [name, text] of Object.entries(fixtures)) fs.writeFileSync(path.join(root, name), text, 'utf8');
fs.writeFileSync(path.join(root, 'utf16.srt'), Buffer.concat([Buffer.from([255, 254]), Buffer.from(srt, 'utf16le')]));
const oversized = path.join(root, 'oversized.srt');
const descriptor = fs.openSync(oversized, 'w'); fs.ftruncateSync(descriptor, 32 * 1024 * 1024 + 1); fs.closeSync(descriptor);
console.log(JSON.stringify({ directory: root, count: Object.keys(fixtures).length + 2 }));
