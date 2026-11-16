const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const directory = path.resolve(process.argv[2] || path.join(__dirname, '../tmp/audio-device-results'));
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
function run(tool, args) { const result = spawnSync(tool, args, { maxBuffer: 8 * 1024 * 1024 }); if (result.error) throw result.error; if (result.status !== 0) throw new Error(result.stderr.toString('utf8')); return result.stdout; }
const report = [];
for (const item of manifest) {
  const source = path.join(directory, item.name);
  const digest = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  assert.equal(digest, item.sha256, 'Original fixture video must remain byte-identical');
  const cache = path.join(directory, item.name.replace(/\.[^.]+$/, ' (音轨1).mka'));
  const probe = JSON.parse(run(process.env.FFPROBE || 'ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', cache]));
  assert.equal(probe.streams.length, 1); assert.equal(probe.streams[0].codec_name, 'aac'); assert.equal(probe.streams[0].channels, 2);
  assert(Math.abs(Number(probe.format.duration) - 8) < 0.2);
  const tags = Object.fromEntries(Object.entries(probe.format.tags || {}).map(([key, value]) => [key.toLowerCase(), value]));
  assert.equal(tags.bplayer_version, '1'); assert.equal(tags.bplayer_track, '0'); assert.match(tags.bplayer_source, /^[a-f0-9]{64}$/);
  const pcm = run(process.env.FFMPEG || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', '0.5', '-i', cache, '-t', '1', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1']);
  let energy = 0, crossings = 0, previous = 0; const count = pcm.length / 4;
  for (let index = 0; index < count; index++) { const sample = pcm.readFloatLE(index * 4); energy += sample * sample; if (index && previous <= 0 && sample > 0) crossings++; previous = sample; }
  const rms = Math.sqrt(energy / count); const frequency = crossings / (count / 48000);
  assert(rms > 0.001); assert(Math.abs(frequency - 440) < 5, 'Default audio must be the 440 Hz target, not the 880 Hz alternate');
  report.push({ source: item.name, sourceByteIdentical: true, cacheAudioOnly: true, channels: 2, duration: Number(probe.format.duration), rms, frequency });
}
console.log(JSON.stringify({ passed: true, report }, null, 2));
