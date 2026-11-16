const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const directory = path.resolve(__dirname, '../tmp/audio-device-fixtures');
fs.mkdirSync(directory, { recursive: true });
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
function run(args) { const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', ...args], { stdio: 'inherit' }); if (result.error) throw result.error; if (result.status !== 0) throw new Error('FFmpeg fixture generation failed: ' + result.status); }
const video = ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=8'];
const first = ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=8'];
const second = ['-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=8'];
const dts = path.join(directory, 'dts-default.mkv');
if (!fs.existsSync(dts)) run([...video, ...first, ...second, '-map', '0:v:0', '-map', '1:a:0', '-map', '2:a:0', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a:0', 'dca', '-strict', '-2', '-ac:a:0', '2', '-b:a:0', '768k', '-c:a:1', 'aac', '-ac:a:1', '2', '-b:a:1', '128k', '-metadata:s:a:0', 'language=zho', '-metadata:s:a:1', 'language=eng', '-disposition:a:0', 'default', '-disposition:a:1', '0', dts]);
const truehd = path.join(directory, 'truehd.mkv');
if (!fs.existsSync(truehd)) run([...video, ...first, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'truehd', '-strict', '-2', '-ac', '2', truehd]);
const ac3 = path.join(directory, 'ac3.mp4');
if (!fs.existsSync(ac3)) run([...video, ...first, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'ac3', '-ac', '2', '-b:a', '192k', '-movflags', '+faststart', ac3]);
const manifest = [dts, truehd, ac3].map(file => ({ name: path.basename(file), bytes: fs.statSync(file).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }));
fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
if (process.argv.includes('--cancel')) {
  const cancellationDirectory = path.resolve(__dirname, '../tmp/audio-cancel-fixtures');
  fs.mkdirSync(cancellationDirectory, { recursive: true });
  const cancellationVideo = path.join(cancellationDirectory, 'cancel.mkv');
  if (!fs.existsSync(cancellationVideo)) run(['-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=10:d=120', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=120', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'dca', '-strict', '-2', '-ac', '2', '-b:a', '768k', '-shortest', cancellationVideo]);
  const exitVideo = path.join(cancellationDirectory, 'exit.mkv');
  if (!fs.existsSync(exitVideo)) fs.copyFileSync(cancellationVideo, exitVideo);
}
console.log(JSON.stringify({ directory, manifest }, null, 2));
