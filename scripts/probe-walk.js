'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = 'E:/code/mdpad';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mdpad-walk-probe-'));
const profile = path.join(work, 'profile');
const r = spawnSync(path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.', '--walkthrough'], {
  cwd: root,
  env: { ...process.env, MDPAD_USERDATA: profile },
  encoding: 'utf8',
  timeout: 30000,
});
console.log('status', r.status, 'signal', r.signal);
console.log('stdout:', (r.stdout || '').slice(-600));
console.log('stderr:', (r.stderr || '').slice(-600));
const log = path.join(profile, 'logs', 'mdpad.log');
if (fs.existsSync(log)) console.log('log:', fs.readFileSync(log, 'utf8').slice(-1200));
fs.rmSync(work, { recursive: true, force: true });
