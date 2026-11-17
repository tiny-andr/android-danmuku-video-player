// P2-1 回归：破损 SRT 必须按时间轴行锚定分块，不能把下一条的时间轴当正文。
// 只依赖 node 核心模块，直接 require 前端 UMD 模块跑真实解析。
const assert = require('node:assert/strict');
const sidecars = require('../bplayer-android/ui/android-sidecars.js');

let groups = 0;
function group(name, test) {
  test(); groups++;
  console.log('PASS ' + name);
}

function cues(output) {
  assert.ok(output.startsWith('WEBVTT\n\n'), '缺少 WEBVTT 头');
  return output.slice(8).trimEnd().split('\n\n').map((block) => {
    const lines = block.split('\n');
    const timing = lines[1].match(/^(\d{2}:\d{2}:\d{2}\.\d{3}) --> (\d{2}:\d{2}:\d{2}\.\d{3})$/);
    assert.ok(timing, '时间轴不是合法 WebVTT：' + lines[1]);
    return { index: lines[0], start: timing[1], end: timing[2], text: lines.slice(2).join('\n') };
  });
}
function bodies(output) {
  return cues(output).map((cue) => sidecars.cueText(cue.text));
}
function assertNoTimelineInsideText(output) {
  for (const body of bodies(output)) assert.ok(!/-->/.test(body), '正文里混进了时间轴：' + JSON.stringify(body));
}

group('正常 SRT 保持原契约（排序、编号、毫秒点号、多行正文）', () => {
  const input = '2\n00:00:04,500 --> 00:00:05,500\nLater\n\n1\n00:00:01,000 --> 00:00:03,000\n中文\nSecond line\n';
  assert.equal(sidecars.toVtt(input, 'srt'),
    'WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\n中文\nSecond line\n\n2\n00:00:04.500 --> 00:00:05.500\nLater\n');
});

group('缺空行：下一块的序号不能粘进上一块正文', () => {
  const output = sidecars.toVtt('1\n00:00:01,000 --> 00:00:02,000\nHello\n2\n00:00:03,000 --> 00:00:04,000\nWorld\n', 'srt');
  assert.deepEqual(bodies(output), ['Hello', 'World']);
  assert.deepEqual(cues(output).map((cue) => [cue.start, cue.end]), [['00:00:01.000', '00:00:02.000'], ['00:00:03.000', '00:00:04.000']]);
});

group('时间轴紧贴上一块正文（无空行、无序号）不会显示时间轴文本', () => {
  const output = sidecars.toVtt('00:00:01,000 --> 00:00:02,000\nHello\n00:00:03,000 --> 00:00:04,000\nWorld\n', 'srt');
  assert.deepEqual(bodies(output), ['Hello', 'World']);
  assertNoTimelineInsideText(output);
});

group('正文里含 --> 但不是时间轴时原样保留', () => {
  const output = sidecars.toVtt('1\n00:00:01,000 --> 00:00:02,000\na --> b\n100 --> 200\n\n2\n00:00:03,000 --> 00:00:04,000\nHi\n', 'srt');
  assert.deepEqual(bodies(output), ['a --> b\n100 --> 200', 'Hi']);
  assert.equal(cues(output).length, 2);
});

group('毫秒用 . 的 SRT 与粘连箭头都能锚定', () => {
  assert.deepEqual(cues(sidecars.toVtt('1\n00:00:01.500 --> 00:00:02.250\nDot\n', 'srt')),
    [{ index: '1', start: '00:00:01.500', end: '00:00:02.250', text: 'Dot' }]);
  const glued = sidecars.toVtt('1\n00:00:01,000-->00:00:02,000\nGlued\n\n2\n00:00:03,000 --> 00:00:04,000\nNext\n', 'srt');
  assert.deepEqual(bodies(glued), ['Glued', 'Next']);
});

group('只有正文没有时间轴的残块整块丢弃，且不接到相邻字幕上', () => {
  const leading = sidecars.toVtt('no timing here\njust text\n\n00:00:01,000 --> 00:00:02,000\nGood\n', 'srt');
  assert.deepEqual(bodies(leading), ['Good']);
  const trailing = sidecars.toVtt('1\n00:00:01,000 --> 00:00:02,000\nGood\n\n2\nTrailing residue without timing\n', 'srt');
  assert.deepEqual(bodies(trailing), ['Good']);
  const brokenMiddle = sidecars.toVtt(
    '1\n00:00:01,000 --> 00:00:02,000\nFirst\n2\n00:00:0X,000 --> 00:00:04,000\nBroken body\n3\n00:00:05,000 --> 00:00:06,000\nThird\n', 'srt');
  assert.deepEqual(bodies(brokenMiddle), ['First', 'Third']);
  assertNoTimelineInsideText(brokenMiddle);
  assert.throws(() => sidecars.toVtt('this is not a subtitle at all\n', 'srt'), /no text cues/);
});

group('<3 与 a < b 不被当成标签吞掉', () => {
  const output = sidecars.toVtt('1\n00:00:01,000 --> 00:00:02,000\nI <3 you\na < b\n', 'srt');
  assert.deepEqual(bodies(output), ['I <3 you\na < b']);
  assert.ok(!output.includes('<3') && output.includes('&lt;3'));
});

group('VTT 也用时间轴锚定，NOTE/STYLE 块仍被跳过', () => {
  const input = 'WEBVTT\n\nNOTE broken\n00:00:09,000 --> 00:00:10,000\nignored\n\ncue-1\n00:00:01.000 --> 00:00:02.000 align:start\nHello\n00:00:03.000 --> 00:00:04.000\nWorld\n';
  const output = sidecars.toVtt(input, 'vtt');
  assert.deepEqual(bodies(output), ['Hello', 'World']);
  assertNoTimelineInsideText(output);
});

console.log('SRT broken tolerance: ' + groups + ' groups passed');
