'use strict';

// Install → run → uninstall hygiene check. Windows only.
// Verifies: the installer lands the app, the installed app runs the smoke suite,
// the uninstaller removes the program directory and its registry entry, and the
// user data directory is left alone.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const installer = path.join(root, 'release', `mdpad Setup ${version}.exe`);
const target = path.join(root, 'release', 'install-test');
const userData = path.join(process.env.APPDATA || os.homedir(), 'mdpad');

function fail(message) {
  console.error(`install-check FAILED: ${message}`);
  process.exit(1);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

if (process.platform !== 'win32') {
  console.log('install-check: skipped (Windows only)');
  process.exit(0);
}
if (!fs.existsSync(installer)) fail(`installer missing: ${installer}`);

const userDataExisted = fs.existsSync(userData);

if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });

console.log('install-check: installing to', target);
const install = spawnSync(installer, [`/S /D=${target}`], { cwd: root, stdio: 'ignore', timeout: 180000 });
if (install.status !== 0) fail(`installer exit ${install.status}`);

for (let i = 0; i < 40 && !fs.existsSync(path.join(target, 'mdpad.exe')); i += 1) sleepSync(500);
const exe = path.join(target, 'mdpad.exe');
if (!fs.existsSync(exe)) fail('installed executable is missing');
console.log('install-check: installed');

const smoke = spawnSync(process.execPath, ['scripts/smoke.js'], {
  cwd: root,
  env: { ...process.env, MDPAD_SMOKE_BIN: exe },
  stdio: 'inherit',
  timeout: 420000,
});
if (smoke.status !== 0) fail(`installed app smoke exit ${smoke.status}`);

const uninstaller = fs
  .readdirSync(target)
  .filter((name) => /^Uninstall .*\.exe$/i.test(name))
  .map((name) => path.join(target, name))[0];
if (!uninstaller) fail('uninstaller not found');

console.log('install-check: uninstalling');
spawnSync(uninstaller, ['/S'], { stdio: 'ignore', timeout: 180000 });
for (let i = 0; i < 40 && fs.existsSync(exe); i += 1) sleepSync(500);
if (fs.existsSync(exe)) fail('program directory survived uninstall');

// The uninstaller deletes the registry entry slightly after the files; polling avoids a
// spurious failure when the cleanup lands a moment later.
let registryText = 'mdpad';
for (let i = 0; i < 20; i += 1) {
  const registry = spawnSync(
    'reg',
    ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s', '/f', 'mdpad'],
    { encoding: 'utf8' }
  );
  registryText = registry.stdout || '';
  if (!registryText.includes('mdpad')) break;
  sleepSync(500);
}
if (registryText.includes('mdpad')) fail('uninstall registry entry survived');

if (userDataExisted && !fs.existsSync(userData)) {
  fail('user data directory was removed by uninstall');
}

console.log('install-check: ok (installed, ran, uninstalled cleanly, user data preserved)');
