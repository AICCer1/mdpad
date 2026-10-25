'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = 'E:/code/mdpad';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mdpad-fast-probe-'));
const profile = path.join(work, 'profile');
const a = path.join(work, 'a.md');
fs.writeFileSync(a, '# A\n\noriginal\n', 'utf8');
const mk = (phase) => spawnSync(path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.', `--crash-phase=${phase}`], {
  cwd: root,
  env: { ...process.env, MDPAD_USERDATA: profile, MDPAD_CRASH_FILE: a },
  encoding: 'utf8',
  timeout: 20000,
});
const fast = mk('fast');
console.log('fast status', fast.status, 'signal', fast.signal);
console.log('fast stdout:', (fast.stdout || '').slice(-300));
console.log('fast stderr:', (fast.stderr || '').slice(-500));
console.log('profile exists:', fs.existsSync(profile), fs.existsSync(profile) ? fs.readdirSync(profile) : '');
fs.rmSync(work, { recursive: true, force: true });
