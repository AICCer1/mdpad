'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = 'E:/code/mdpad';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mdpad-tabs-probe2-'));
const profile = path.join(work, 'profile');
const a = path.join(work, 'a.md');
const b = path.join(work, 'b.md');
fs.writeFileSync(a, '# A\n\noriginal\n', 'utf8');
fs.writeFileSync(b, '# B\n\noriginal\n', 'utf8');
const r = spawnSync(path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.', '--crash-phase=tabs'], {
  cwd: root,
  env: { ...process.env, MDPAD_USERDATA: profile, MDPAD_CRASH_FILE: a, MDPAD_CRASH_FILE_B: b },
  encoding: 'utf8',
  timeout: 25000,
});
console.log('status', r.status, 'signal', r.signal);
console.log('stdout:', (r.stdout || '').slice(-800));
console.log('stderr:', (r.stderr || '').slice(-1200));
const log = path.join(profile, 'log.txt');
if (fs.existsSync(log)) console.log('log tail:', fs.readFileSync(log, 'utf8').slice(-1200));
fs.rmSync(work, { recursive: true, force: true });
