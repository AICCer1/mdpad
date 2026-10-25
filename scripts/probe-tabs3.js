'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = 'E:/code/mdpad';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mdpad-tabs-logs-'));
const profile = path.join(work, 'profile');
const a = path.join(work, 'a.md');
const b = path.join(work, 'b.md');
fs.writeFileSync(a, '# A\n', 'utf8');
fs.writeFileSync(b, '# B\n', 'utf8');
spawnSync(path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.', '--crash-phase=tabs'], {
  cwd: root,
  env: { ...process.env, MDPAD_USERDATA: profile, MDPAD_CRASH_FILE: a, MDPAD_CRASH_FILE_B: b },
  encoding: 'utf8',
  timeout: 15000,
});
const logs = path.join(profile, 'logs');
if (fs.existsSync(logs)) {
  for (const name of fs.readdirSync(logs)) {
    const p = path.join(logs, name);
    console.log('==', name);
    console.log(fs.readFileSync(p, 'utf8').slice(-1500));
  }
}
console.log('drafts:', fs.existsSync(path.join(profile, 'drafts')) ? fs.readdirSync(path.join(profile, 'drafts')) : 'none');
console.log('work:', work);
