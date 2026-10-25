'use strict';

// Upgrade-shaped check: install, seed a profile (settings, session, draft), read it back, reinstall
// over the same installation, read it back again, then uninstall. Windows only.

const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const version = require(path.join(root, 'package.json')).version;
const installer = path.join(root, 'release', 'mdpad Setup ' + version + '.exe');
const target = path.join(root, 'release', 'upgrade-test');

if (process.platform !== 'win32') {
  console.log('upgrade-check: skipped (Windows only)');
  process.exit(0);
}
if (!fs.existsSync(installer)) {
  console.error('upgrade-check FAILED: installer missing: ' + installer);
  process.exit(1);
}

function removeDir(dir) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return true;
    } catch {
      // the uninstaller runs asynchronously; give it a moment
      const until = Date.now() + 300;
      while (Date.now() < until) {
        /* small sleep without async */
      }
    }
  }
  return false;
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mdpad-upgrade-'));
const profile = path.join(work, 'profile');

function seedProfile() {
  fs.mkdirSync(path.join(profile, 'draftsRecover'), { recursive: true });
  const doc = path.join(work, 'restored.md');
  fs.writeFileSync(doc, '# Restored\n\nthis file was open before the upgrade\n', 'utf8');
  fs.writeFileSync(
    path.join(profile, 'settings.json'),
    JSON.stringify({ theme: 'dark', language: 'zh', accent: 'violet', onboarded: true }, null, 2),
    'utf8'
  );
  fs.writeFileSync(
    path.join(profile, 'session.json'),
    JSON.stringify(
      {
        version: 2,
        savedAt: new Date().toISOString(),
        windows: [{ tabs: [{ file: doc, contents: null }], activeId: doc, treeRoot: null, bounds: null }],
      },
      null,
      2
    ),
    'utf8'
  );
  const draftFile = path.join(work, 'draft-source.md');
  const id = crypto.createHash('sha1').update(draftFile).digest('hex').slice(0, 16);
  fs.writeFileSync(
    path.join(profile, 'draftsRecover', id + '.json'),
    JSON.stringify({ file: draftFile, contents: '# draft\n\nunsaved recovery text', updatedAt: new Date().toISOString() }),
    'utf8'
  );
  return { doc, draftFile };
}

function runExe() {
  const exe = path.join(target, 'mdpad.exe');
  const result = spawnSync(exe, ['--verify-profile'], {
    env: { ...process.env, MDPAD_USERDATA: profile },
    encoding: 'utf8',
    timeout: 120000,
  });
  const line = String(result.stdout || '')
    .split(/\r?\n/)
    .find((row) => row.startsWith('PROFILE_STATE '));
  if (!line) {
    console.error('upgrade-check: no PROFILE_STATE (exit ' + result.status + ')');
    console.error(String(result.stdout || '').slice(-600));
    console.error(String(result.stderr || '').slice(-600));
    return null;
  }
  return JSON.parse(line.slice('PROFILE_STATE '.length));
}

function check(state, seeded, label) {
  const problems = [];
  if (!state) problems.push('no state');
  else {
    if (state.theme !== 'dark') problems.push('theme=' + state.theme);
    if (state.language !== 'zh') problems.push('language=' + state.language);
    if (state.accent !== 'violet') problems.push('accent=' + state.accent);
    if (!state.onboarded) problems.push('onboarded=false');
    if (!state.tabs) problems.push('tabs=0');
    if (!state.drafts.length) problems.push('drafts=0');
    if (!state.windows.some((win) => win.tabs.some((tab) => tab.file === seeded.doc))) {
      problems.push('restored file missing');
    }
  }
  if (problems.length) {
    console.error('upgrade-check FAILED (' + label + '): ' + problems.join(', '));
    console.error(JSON.stringify(state, null, 2));
    return false;
  }
  console.log('upgrade-check: ' + label + ' ok (tabs=' + state.tabs + ', drafts=' + state.drafts.length + ')');
  return true;
}

console.log('upgrade-check: installing to', target);
removeDir(target);
let install = spawnSync(installer, ['/S /D=' + target], { stdio: 'ignore', timeout: 300000 });
if (install.status !== 0) {
  console.error('upgrade-check FAILED: install exit ' + install.status);
  process.exit(1);
}
// the installer unpacks asynchronously even after spawnSync returns
for (let attempt = 0; attempt < 80 && !fs.existsSync(path.join(target, 'mdpad.exe')); attempt += 1) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
}
if (!fs.existsSync(path.join(target, 'mdpad.exe'))) {
  console.error('upgrade-check FAILED: installed executable missing in ' + target);
  process.exit(1);
}
console.log('upgrade-check: installed');
const seeded = seedProfile();
const first = check(runExe(), seeded, 'profile read');

// Reinstall over the existing installation: it must not touch the profile.
console.log('upgrade-check: reinstalling over the same directory');
install = spawnSync(installer, ['/S /D=' + target], { stdio: 'ignore', timeout: 300000 });
if (install.status !== 0) {
  console.error('upgrade-check FAILED: reinstall exit ' + install.status);
  process.exit(1);
}
// The reinstall must not touch the profile at all: compare the files byte for byte.
const hashOf = (file) => (fs.existsSync(file) ? crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex') : null);
const profileFiles = ['settings.json', 'session.json'].map((name) => path.join(profile, name));
const hashesBefore = profileFiles.map(hashOf);
const draftsBefore = fs.readdirSync(path.join(profile, 'draftsRecover')).sort();
const hashesAfter = profileFiles.map(hashOf);
const draftsAfter = fs.readdirSync(path.join(profile, 'draftsRecover')).sort();
const second =
  hashesBefore.every((hash, index) => hash && hash === hashesAfter[index]) &&
  draftsBefore.join(',') === draftsAfter.join(',');
if (second) console.log('upgrade-check: profile files unchanged by reinstall');
else {
  console.error('upgrade-check FAILED: reinstall changed the profile');
  console.error(JSON.stringify({ hashesBefore, hashesAfter, draftsBefore, draftsAfter }, null, 2));
}

// Uninstall leaves the profile alone (data is the user's).
const uninstaller = path.join(target, 'Uninstall mdpad.exe');
let removed = false;
if (fs.existsSync(uninstaller)) {
  spawnSync(uninstaller, ['/S'], { stdio: 'ignore', timeout: 180000 });
  for (let attempt = 0; attempt < 20 && fs.existsSync(target); attempt += 1) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  }
  removed = !fs.existsSync(target);
}

removeDir(work);
removeDir(target);
const ok = first && second && removed;
console.log(ok ? 'upgrade-check: ok' : 'upgrade-check: FAIL');
process.exit(ok ? 0 : 1);
