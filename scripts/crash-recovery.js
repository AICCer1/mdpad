'use strict';

// Crash-recovery test: run the app, let it write a draft, SIGKILL it, then start it
// again against the same profile and check the draft is offered back.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const electronPath = require('electron');

const root = path.join(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mdpad-crash-'));
const profile = path.join(work, 'profile');
const docPath = path.join(work, 'crash-target.md');
fs.writeFileSync(docPath, '# crash target\n\noriginal text\n', 'utf8');

function run(phase, timeoutMs) {
  return new Promise((resolve) => {
    const bin = process.env.MDPAD_CRASH_BIN;
    const child = bin
      ? spawn(bin, [`--crash-phase=${phase}`], {
          cwd: root,
          env: { ...process.env, MDPAD_USERDATA: profile, MDPAD_CRASH_FILE: docPath },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      : spawn(electronPath, ['.', `--crash-phase=${phase}`], {
          cwd: root,
          env: { ...process.env, MDPAD_USERDATA: profile, MDPAD_CRASH_FILE: docPath },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      out += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      err += d.toString('utf8');
    });
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, out, err });
    });
  });
}

(async () => {
  const write = await run('write', 30000);
  const wroteDraft = /CRASH_DRAFT_OK/.test(write.out);
  console.log(`crash: write phase exit=${write.code} signal=${write.signal} draft=${wroteDraft}`);

  if (!wroteDraft) {
    console.error(write.out.trim().slice(-800));
    console.error(write.err.trim().slice(-800));
    process.exit(1);
  }

  const verify = await run('verify', 30000);
  const verified = /CRASH_VERIFY \{"ok":true/.test(verify.out);
  console.log(`crash: verify phase exit=${verify.code} restored=${verified}`);
  console.log(verify.out.split('\n').filter((l) => l.includes('CRASH_VERIFY')).join('\n'));

  fs.rmSync(work, { recursive: true, force: true });
  console.log(verified ? 'crash: ok' : 'crash: FAIL');
  process.exit(verified ? 0 : 1);
})();
