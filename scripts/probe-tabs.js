'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = 'E:/code/mdpad';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mdpad-tabs-probe-'));
const profile = path.join(work, 'profile');
const a = path.join(work, 'a.md');
const b = path.join(work, 'b.md');
fs.writeFileSync(a, '# A\n\noriginal\n', 'utf8');
fs.writeFileSync(b, '# B\n\noriginal\n', 'utf8');

const run = (phase) =>
  spawnSync(
    path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
    ['.', `--crash-phase=${phase}`],
    {
      cwd: root,
      env: { ...process.env, MDPAD_USERDATA: profile, MDPAD_CRASH_FILE: a, MDPAD_CRASH_FILE_B: b },
      encoding: 'utf8',
      timeout: 60000,
    }
  );

const write = run('tabs');
console.log('write stdout:', (write.stdout || '').slice(-500));
console.log('write code/signal:', write.status, write.signal);

const draftsDir = path.join(profile, 'drafts');
console.log('draft files:', fs.existsSync(draftsDir) ? fs.readdirSync(draftsDir) : 'MISSING');
if (fs.existsSync(draftsDir)) {
  for (const name of fs.readdirSync(draftsDir)) {
    const body = fs.readFileSync(path.join(draftsDir, name), 'utf8');
    console.log(name, body.slice(0, 120));
  }
}

const verify = run('tabs-verify');
console.log('verify stdout:', (verify.stdout || '').slice(-500));
fs.rmSync(work, { recursive: true, force: true });
