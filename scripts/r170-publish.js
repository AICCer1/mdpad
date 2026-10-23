'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');

const root = 'E:\\code\\mdpad';
const version = '1.24.0';
const git = (...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

git('add', '-A');
git('-c', 'core.autocrlf=false', 'commit', '-q', '-m', `feat: tab context menu and Ctrl+Tab cycling (${version})`);
console.log('commit:', git('log', '--oneline', '-1').trim());
git('push', 'origin', 'main');
git('tag', '-a', `v${version}`, '-m', `mdpad ${version}`);
git('push', 'origin', `v${version}`);

const store = path.join(os.homedir(), '.git-credentials');
const line = fs
  .readFileSync(store, 'utf8')
  .split(/\r?\n/)
  .find((row) => row.includes('github.com') && row.trim());
const url = new URL(line.trim());
const auth = Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64');
const owner = decodeURIComponent(url.username);

function api(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = https.request(
      {
        hostname: 'api.github.com',
        path: pathname,
        method,
        headers: {
          authorization: `Basic ${auth}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'mdpad-release',
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode, text }));
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function upload(uploadUrl, file) {
  const name = path.basename(file);
  const size = fs.statSync(file).size;
  const target = new URL(uploadUrl.replace('{?name,label}', `?name=${encodeURIComponent(name)}`));
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: target.hostname,
        path: target.pathname + target.search,
        method: 'POST',
        headers: {
          authorization: `Basic ${auth}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'mdpad-release',
          'content-type': 'application/octet-stream',
          'content-length': size,
        },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode, text }));
      }
    );
    req.on('error', reject);
    fs.createReadStream(file).pipe(req);
  });
}

(async () => {
  const notes = fs.readFileSync(path.join(root, 'release', 'RELEASE_NOTES.md'), 'utf8');
  const created = await api('POST', `/repos/${owner}/mdpad/releases`, {
    tag_name: `v${version}`,
    name: `mdpad ${version}`,
    body: notes,
    draft: false,
    prerelease: false,
  });
  if (created.status !== 201) {
    console.error('release failed', created.status, created.text.slice(0, 300));
    process.exit(1);
  }
  const release = JSON.parse(created.text);
  console.log('release:', release.html_url);
  for (const asset of [
    `mdpad Setup ${version}.exe`,
    `mdpad ${version}.exe`,
    `mdpad Setup ${version}.exe.blockmap`,
    'latest.yml',
    'SHA256SUMS.txt',
  ]) {
    const file = path.join(root, 'release', asset);
    if (!fs.existsSync(file)) {
      console.log('skip missing:', asset);
      continue;
    }
    const result = await upload(release.upload_url, file);
    console.log(`uploaded ${asset} -> ${result.status}`);
  }
})();
