'use strict';

// Smoke runner: Electron can keep the process alive after process.exit() once a
// second window (and its helper processes) exists, so the run is observed from
// outside: wait for the result, then force the tree down.

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const electronPath = require('electron');

const root = path.join(__dirname, '..');
const TIMEOUT_MS = 300000;

// Allow the same suite to run against a packaged build:
//   MDPAD_SMOKE_BIN=release/win-unpacked/mdpad.exe node scripts/smoke.js
const packaged = process.env.MDPAD_SMOKE_BIN;
// --json keeps stdout machine-readable: the app's own log lines are suppressed and a
// single JSON document is printed at the end.
const jsonMode = process.argv.includes('--json');
const child = packaged
  ? spawn(packaged, ['--smoke-test'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  : spawn(electronPath, ['.', '--smoke-test'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

let stdout = '';
let stderr = '';
let finishing = false;
let timer = null;

function finish() {
  if (finishing) return;
  finishing = true;
  clearTimeout(timer);
  const report = reportFromOutput();
  killTree();
  if (!report) {
    console.error('smoke: no SMOKE_RESULT in output');
    if (stderr.trim()) console.error(stderr.trim().slice(-2000));
    process.exit(1);
  }
  if (jsonMode) {
    let checks = [];
    try {
      checks = JSON.parse(fs.readFileSync(path.join(report.dir, 'smoke-result.json'), 'utf8')).checks || [];
    } catch {
      /* counts only */
    }
    console.log(
      JSON.stringify(
        {
          ok: report.ok,
          checks: report.checks,
          failed: report.failed,
          dir: report.dir,
          results: checks.map((check) => ({ step: check.step, ok: check.ok })),
        },
        null,
        2
      )
    );
    process.exit(report.ok ? 0 : 1);
  }
  for (const check of report.failedChecks) {
    console.error(`  FAIL ${check.step} ${JSON.stringify(check).slice(0, 200)}`);
  }
  console.log(`\nsmoke: ${report.ok ? 'ok' : 'FAIL'} (${report.checks - report.failed}/${report.checks})`);
  process.exit(report.ok ? 0 : 1);
}

child.stdout.on('data', (chunk) => {
  const text = chunk.toString('utf8');
  stdout += text;
  if (!jsonMode) process.stdout.write(text);
  // Electron may keep the process alive after the run; finish as soon as the
  // result line is complete instead of waiting for the process to exit.
  if (text.includes('SMOKE_RESULT')) setTimeout(finish, 300);
});
child.stderr.on('data', (chunk) => {
  const text = chunk.toString('utf8');
  stderr += text;
  if (!jsonMode) process.stderr.write(text);
});

function killTree() {
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

function reportFromOutput() {
  const match = /SMOKE_RESULT (ok|FAIL) checks=(\d+) failed=(\d+) dir=(.+)/.exec(stdout);
  if (!match) return null;
  const dir = match[4].trim();
  const file = path.join(dir, 'smoke-result.json');
  let failedChecks = [];
  try {
    const report = JSON.parse(fs.readFileSync(file, 'utf8'));
    failedChecks = (report.checks || []).filter((c) => !c.ok);
  } catch {
    /* fall back to the counts in the line */
  }
  return {
    ok: match[1] === 'ok',
    checks: Number(match[2]),
    failed: Number(match[3]),
    dir,
    failedChecks,
  };
}

child.on('exit', finish);

timer = setTimeout(() => {
  console.error(`smoke: timed out after ${TIMEOUT_MS}ms; killing the electron tree`);
  finish();
}, TIMEOUT_MS);
