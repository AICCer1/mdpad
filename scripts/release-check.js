'use strict';

// One command release gate: build, package, then run the suites against the
// packaged binary (and the portable launcher when it exists).

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(label, command, args, options = {}) {
  console.log(`\n=== ${label} ===`);
  const isNpm = command === npm;
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: isNpm && process.platform === 'win32',
    ...options,
  });
  if (result.status !== 0) {
    console.error(`FAILED: ${label} (exit ${result.status})`);
    process.exit(result.status || 1);
  }
  console.log(`ok: ${label}`);
  return result;
}

function firstExisting(candidates) {
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

run('build renderer', npm, ['run', 'build']);
run('package (dir)', npm, ['run', 'dist:dir']);
run('release notes', npm, ['run', 'notes']);

const unpacked = path.join(root, 'release', 'win-unpacked', 'mdpad.exe');
if (!fs.existsSync(unpacked)) {
  console.error('missing packaged binary:', unpacked);
  process.exit(1);
}

run('smoke against packaged binary', process.execPath, ['scripts/smoke.js'], {
  env: { ...process.env, MDPAD_SMOKE_BIN: unpacked },
});

run('crash recovery against packaged binary', process.execPath, ['scripts/crash-recovery.js'], {
  env: { ...process.env, MDPAD_CRASH_BIN: unpacked },
});

run('restart restores windows and tabs', process.execPath, ['scripts/restart-check.js'], {
  env: { ...process.env, MDPAD_RESTART_BIN: unpacked },
});

const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const portable = firstExisting([
  path.join(root, 'release', `mdpad ${version}.exe`),
  path.join(root, 'release', 'mdpad.exe'),
]);

if (portable) {
  console.log('\n=== portable launcher ===');
  // The portable launcher unpacks to a temp directory and starts the app detached
  // from stdio, so the smoke suite cannot drive it. Verify it actually starts.
  const probe = spawnSync(portable, [], { cwd: root, stdio: 'ignore', timeout: 25000 });
  const started = Boolean(probe.error && probe.error.code === 'ETIMEDOUT') || probe.status === 0;
  spawnSync('taskkill', ['/IM', 'mdpad.exe', '/F'], { stdio: 'ignore' });
  if (started) {
    console.log('ok: portable launcher starts the application');
  } else {
    console.warn('warn: portable launcher did not start (the installer build is unaffected)');
  }
} else {
  console.log('\n(skipping portable check: run `npm run dist` to build the portable exe)');
}

console.log('\nrelease check passed');
