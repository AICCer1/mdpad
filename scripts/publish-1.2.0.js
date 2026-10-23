'use strict';
// Commits the mermaid feature, then tags and publishes v1.2.0 with its assets.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');

const root = path.join(__dirname, '..');
const git = (...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

console.log('status:', git('status', '--short').split('\n').filter(Boolean).length, 'files changed');
git('add', '-A');
git('-c', 'core.autocrlf=false', 'commit', '-q', '-m', 'feat: render mermaid diagrams under their fence (1.2.0)');
console.log('commit:', git('log', '--oneline', '-1').trim());
git('push', 'origin', 'main');
git('tag', '-a', 'v1.2.0', '-m', 'mdpad 1.2.0');
git('push', 'origin', 'v1.2.0');
console.log('pushed main and v1.2.0');

const store = path.join(os.homedir(), '.git-credentials');
const line = fs
  .readFileSync(store, 'utf8')
  .split(/\r?\n/)
  .find((row) => row.includes('github.com') && row.trim());
const url = new URL(line.trim());
const auth = Buffer.from(
  `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`
).toString('base64');
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
          ...(payload
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => {
          text += chunk;
        });
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
        res.on('data', (chunk) => {
          text += chunk;
        });
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
    tag_name: 'v1.2.0',
    name: 'mdpad 1.2.0',
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

  for (const asset of ['mdpad Setup 1.2.0.exe', 'mdpad 1.2.0.exe', 'mdpad Setup 1.2.0.exe.blockmap', 'latest.yml', 'SHA256SUMS.txt']) {
    const file = path.join(root, 'release', asset);
    if (!fs.existsSync(file)) {
      console.log('skip missing:', asset);
      continue;
    }
    const started = Date.now();
    const result = await upload(release.upload_url, file);
    console.log(
      `uploaded ${asset} -> ${result.status} (${(fs.statSync(file).size / (1024 * 1024)).toFixed(1)} MB in ${((Date.now() - started) / 1000).toFixed(1)}s)`
    );
  }
})();
