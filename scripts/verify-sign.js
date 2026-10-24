'use strict';

// Checks the Authenticode signature of the built executables. With --require it fails when an
// artifact is unsigned, which is what `npm run ship` does when signing was requested.
//
//   node scripts/verify-sign.js                     report only, never fails
//   node scripts/verify-sign.js --require           fail on artifacts without a signature
//   node scripts/verify-sign.js --require-trusted   also fail when the signer is not trusted
//   node scripts/verify-sign.js --require a.exe b.exe

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const required = args.includes('--require');
const requireTrusted = args.includes('--require-trusted');
const explicit = args.filter((arg) => !arg.startsWith('--'));

function targets() {
  if (explicit.length) return explicit.map((file) => path.resolve(file));
  const release = path.join(root, 'release');
  if (!fs.existsSync(release)) return [];
  return fs
    .readdirSync(release)
    .filter((name) => /\.exe$/i.test(name))
    .map((name) => path.join(release, name))
    .concat([path.join(release, 'win-unpacked', 'mdpad.exe')])
    .filter((file) => fs.existsSync(file));
}

function signature(file) {
  const script = [
    `$ErrorActionPreference = 'Stop'`,
    `$sig = Get-AuthenticodeSignature -LiteralPath '${file}'`,
    `$thumb = if ($sig.SignerCertificate) { $sig.SignerCertificate.Thumbprint } else { '' }`,
    `$subject = if ($sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { '' }`,
    `Write-Output ($sig.Status.ToString() + [char]9 + $thumb + [char]9 + $subject)`,
  ].join('\n');
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
  });
  if (result.status !== 0) return { status: 'ERROR', thumbprint: '', subject: (result.stderr || '').trim() };
  const [status, thumbprint, subject] = result.stdout.trim().split('\t');
  return { status, thumbprint, subject };
}

const files = targets();
if (!files.length) {
  console.log('sign: no executables found (build first)');
  if (required) process.exit(1);
  process.exit(0);
}

let unsigned = 0;
let untrusted = 0;
for (const file of files) {
  const sig = signature(file);
  const relative = path.relative(root, file);
  const hasSignature = sig.status !== 'NotSigned' && sig.status !== 'ERROR' && Boolean(sig.thumbprint);
  const trusted = sig.status === 'Valid';
  if (!hasSignature) unsigned += 1;
  else if (!trusted) untrusted += 1;
  const label = trusted ? 'signed, trusted ' : hasSignature ? 'signed, untrusted' : 'UNSIGNED         ';
  console.log(`${label}  ${relative}  ${sig.status}${sig.thumbprint ? '  ' + sig.thumbprint : ''}`);
  if (sig.subject) console.log(`                  ${sig.subject}`);
}

console.log(`\nsign: ${files.length} file(s), ${unsigned} unsigned, ${untrusted} signed but not trusted`);
if (unsigned) {
  console.log('note: a self-signed certificate produces a valid signature that Windows reports as');
  console.log('      untrusted until the certificate is installed as a trusted root.');
}
if (requireTrusted && untrusted) process.exit(1);
if (required && unsigned) process.exit(1);
