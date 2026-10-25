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

const docPathB = path.join(work, 'crash-target-b.md');

function crashEnv() {
  return {
    ...process.env,
    MDPAD_USERDATA: profile,
    MDPAD_CRASH_FILE: docPath,
    MDPAD_CRASH_FILE_B: docPathB,
  };
}
fs.writeFileSync(docPathB, '# second target\n\noriginal b\n', 'utf8');

function run(phase, timeoutMs) {
  return new Promise((resolve) => {
    const bin = process.env.MDPAD_CRASH_BIN;
    const child = bin
      ? spawn(bin, [`--crash-phase=${phase}`], {
          cwd: root,
          env: crashEnv(),
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      : spawn(electronPath, ['.', `--crash-phase=${phase}`], {
          cwd: root,
          env: crashEnv(),
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

  // Second scenario: type and die 120 ms later, with no explicit draft write and no wait for the
  // debounce. The leading-edge draft must have reached the disk already.
  const fastWrite = await run('fast', 30000);
  const fastKept = /CRASH_FAST \{"token":"[^"]+","kept":true/.test(fastWrite.out);
  console.log(`crash: fast phase exit=${fastWrite.code} signal=${fastWrite.signal} kept=${fastKept}`);
  console.log(fastWrite.out.split('\n').filter((l) => l.includes('CRASH_FAST')).join('\n'));

  const fastVerify = await run('fast-verify', 30000);
  const fastVerified = /CRASH_FAST_VERIFY \{"hasDraft":true,"kept":true/.test(fastVerify.out);
  console.log(`crash: fast-verify kept=${fastVerified}`);
  console.log(fastVerify.out.split('\n').filter((l) => l.includes('CRASH_FAST_VERIFY')).join('\n'));

  // Third scenario: two tabs edited, one kill, both drafts must survive separately.
  const tabsWrite = await run('tabs', 30000);
  const tabsKept = /CRASH_TABS \{"tokenA":"[^"]+","tokenB":"[^"]+","keptA":true,"keptB":true/.test(tabsWrite.out);
  console.log(`crash: tabs phase exit=${tabsWrite.code} signal=${tabsWrite.signal} kept=${tabsKept}`);
  console.log(tabsWrite.out.split('\n').filter((l) => l.includes('CRASH_TABS')).join('\n'));

  const tabsVerify = await run('tabs-verify', 30000);
  const tabsVerified = /CRASH_TABS_VERIFY \{"hasA":true,"hasB":true,"keptA":true,"keptB":true,"distinct":true/.test(tabsVerify.out);
  console.log(`crash: tabs-verify kept=${tabsVerified}`);
  console.log(tabsVerify.out.split('\n').filter((l) => l.includes('CRASH_TABS_VERIFY')).join('\n'));

  fs.rmSync(work, { recursive: true, force: true });
  const allOk = verified && fastKept && fastVerified && tabsKept && tabsVerified;
  console.log(allOk ? 'crash: ok' : 'crash: FAIL');
  process.exit(allOk ? 0 : 1);
})();
