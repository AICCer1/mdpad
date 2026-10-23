'use strict';

// Real restart check: one process writes a two-window session and quits cleanly, the next
// process starts with the same profile and must reopen both windows and their tabs.
// This is the only place where the write/read path is exercised through an actual exit.

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const electronPath = require('electron');

const root = path.join(__dirname, '..');
const userData = path.join(os.tmpdir(), `mdpad-restart-${Date.now()}`);
const bin = process.env.MDPAD_RESTART_BIN || null;

function launch(phase, timeoutMs = 60000) {
  const args = ['.', `--restart-phase=${phase}`];
  const child = bin
    ? spawn(bin, args.slice(1), {
        cwd: root,
        env: { ...process.env, MDPAD_USERDATA: userData },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    : spawn(electronPath, args, {
        cwd: root,
        env: { ...process.env, MDPAD_USERDATA: userData },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => {
    out += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk) => {
    err += chunk.toString('utf8');
  });

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      killTree(child);
      resolve({ ok: false, out, err, timedOut: true });
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      killTree(child);
      resolve({ ok: true, code, out, err });
    });
  });
}

function killTree(child) {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    /* already gone */
  }
}

(async () => {
  console.log('restart: writing a session with two windows…');
  const write = await launch('write');
  if (!write.out.includes('RESTART_WRITE_OK')) {
    console.error('restart: write phase failed');
    console.error((write.err || write.out).slice(-1500));
    process.exit(1);
  }

  const sessionFile = path.join(userData, 'session.json');
  if (!fs.existsSync(sessionFile)) {
    console.error('restart: session.json was not written on quit');
    process.exit(1);
  }
  const saved = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  console.log(`restart: session saved with ${saved.windows.length} window(s)`);

  console.log('restart: starting again…');
  const verify = await launch('verify');
  const match = /RESTART_VERIFY (\{.*\})/.exec(verify.out);
  if (!match) {
    console.error('restart: verify phase produced no result');
    console.error((verify.err || verify.out).slice(-1500));
    process.exit(1);
  }
  const result = JSON.parse(match[1]);
  if (!result.ok) {
    console.error('restart: FAILED ' + JSON.stringify(result));
    process.exit(1);
  }
  console.log(`restart: ok (${result.windows.length} windows, ${result.windows.map((w) => w.tabs.join('+')).join(' | ')})`);
  fs.rmSync(userData, { recursive: true, force: true });
})();
