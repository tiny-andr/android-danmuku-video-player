const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Server, utils } = require(path.join(__dirname, '../tmp/network-fixture/node_modules/ssh2'));
const { STATUS_CODE } = utils.sftp;
const work = path.join(__dirname, '../tmp/network-fixture');
const password = crypto.randomBytes(24).toString('base64url');
const privateKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
const video = fs.readFileSync(path.join(work, 'sample.mp4'));
const videoName = '第 01 集 + %.mp4';
const files = new Map([
  [`/${videoName}`, { data: video }],
  ['/第 01 集 + %.xml', { data: Buffer.from('<?xml version="1.0" encoding="UTF-8"?><i><d p="1,1,25,16777215,0,0,0,0">Network fixture</d></i>') }],
  ['/第 01 集 + %.zh.srt', { data: Buffer.from('1\n00:00:00,000 --> 00:00:05,000\nNetwork subtitle fixture\n') }],
  ['/large.mp4', { size: 5 * 1024 ** 3 + 123 }],
  ['/empty.mp4', { data: Buffer.alloc(0) }],
  ['/folder', { directory: true }],
  ['/folder/episode 02.mp4', { data: video }]
]);
function clean(value) {
  const result = path.posix.normalize('/' + value);
  return result === '/.' ? '/' : result;
}
function metadata(file) {
  return { mode: file.directory ? 0o40555 : 0o100444, uid: 1000, gid: 1000, size: file.directory ? 0 : file.size ?? file.data.length, atime: 1700000000, mtime: 1700000000 };
}
const server = new Server({
  hostKeys: [privateKey],
  algorithms: { kex: ['curve25519-sha256', 'ecdh-sha2-nistp256'], cipher: ['aes128-gcm@openssh.com', 'aes128-ctr'], hmac: ['hmac-sha2-256'] }
}, client => {
  client.on('error', error => console.log('CLIENT_ERROR', error.message));
  client.on('authentication', context => {
    if (context.method === 'password' && context.username === 'fixture' && context.password === password) context.accept();
    else context.reject();
  });
  client.on('ready', () => client.on('session', accept => {
    accept().on('sftp', acceptSftp => {
      const sftp = acceptSftp();
      const handles = new Map();
      let serial = 0;
      function handle(value) { const token = Buffer.alloc(4); token.writeUInt32BE(++serial); handles.set(token.toString('hex'), value); return token; }
      function lookup(value) { return handles.get(value.toString('hex')); }
      function missing(id) { sftp.status(id, STATUS_CODE.NO_SUCH_FILE); }
      sftp.on('REALPATH', (id, value) => sftp.name(id, [{ filename: clean(value), longname: clean(value), attrs: {} }]));
      function stat(id, value) {
        const normalized = clean(value);
        const file = normalized === '/' ? { directory: true } : files.get(normalized);
        if (file) sftp.attrs(id, metadata(file)); else missing(id);
      }
      sftp.on('STAT', stat); sftp.on('LSTAT', stat);
      sftp.on('FSTAT', (id, token) => { const value = lookup(token); if (value && value.file) sftp.attrs(id, metadata(value.file)); else missing(id); });
      sftp.on('OPENDIR', (id, value) => {
        const normalized = clean(value);
        if (normalized !== '/' && !files.get(normalized)?.directory) { missing(id); return; }
        const entries = Array.from(files).filter(([name]) => path.posix.dirname(name) === normalized).map(([name, file]) => ({ filename: path.posix.basename(name), longname: path.posix.basename(name), attrs: metadata(file) }));
        sftp.handle(id, handle({ entries }));
      });
      sftp.on('READDIR', (id, token) => {
        const directory = lookup(token);
        if (!directory) { missing(id); return; }
        if (directory.done) sftp.status(id, STATUS_CODE.EOF);
        else { directory.done = true; sftp.name(id, directory.entries); }
      });
      sftp.on('OPEN', (id, value, flags) => {
        if (flags !== 1) { sftp.status(id, STATUS_CODE.PERMISSION_DENIED); return; }
        const file = files.get(clean(value));
        if (!file || file.directory) { missing(id); return; }
        sftp.handle(id, handle({ file }));
      });
      sftp.on('READ', (id, token, offset, length) => {
        const entry = lookup(token);
        if (!entry?.file) { missing(id); return; }
        const file = entry.file;
        const size = file.size ?? file.data.length;
        if (offset >= size) { sftp.status(id, STATUS_CODE.EOF); return; }
        const count = Math.min(length, size - offset, 65536);
        if (file.data) sftp.data(id, file.data.subarray(offset, offset + count));
        else {
          const buffer = Buffer.alloc(count);
          for (let index = 0; index < count; index++) buffer[index] = (offset + index) % 251;
          sftp.data(id, buffer);
        }
      });
      sftp.on('CLOSE', (id, token) => { handles.delete(token.toString('hex')); sftp.status(id, STATUS_CODE.OK); });
    });
  }));
});
server.on('error', error => { console.error(error); process.exitCode = 1; });
server.listen(22345, '127.0.0.1', () => {
  fs.writeFileSync(path.join(work, 'source.json'), JSON.stringify({ name: 'Protocol fixture', protocol: 'sftp', host: '127.0.0.1', port: 22345, root: '', username: 'fixture', password }));
  console.log('SFTP fixture listening only on 127.0.0.1:22345');
});
process.on('SIGTERM', () => { server.close(); process.exit(0); });
