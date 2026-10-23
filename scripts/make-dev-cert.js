'use strict';

// Creates a self-signed code-signing certificate for local Windows builds and exports it as a
// PFX that electron-builder can consume. This is for testing the signing path only: SmartScreen
// still warns for an unknown publisher, and Windows only trusts the certificate on machines that
// installed it. A real release must use a certificate from a public CA.
//
//   node scripts/make-dev-cert.js            create (or reuse) build/certs/mdpad-dev.pfx
//   node scripts/make-dev-cert.js --print    print the environment block to paste into a shell
//   node scripts/make-dev-cert.js --remove   delete the certificate from the user store

const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const certDir = path.join(root, 'build', 'certs');
const pfxPath = path.join(certDir, 'mdpad-dev.pfx');
const metaPath = path.join(certDir, 'dev-cert.json');
const subject = 'CN=mdpad Development, O=mdpad, C=CN';

function powershell(script) {
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'powershell failed').trim());
  }
  return result.stdout.trim();
}

function remove() {
  const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : null;
  if (meta && meta.thumbprint) {
    powershell(`Remove-Item -Path 'Cert:\\CurrentUser\\My\\${meta.thumbprint}' -Force -ErrorAction SilentlyContinue`);
    console.log('removed certificate', meta.thumbprint);
  }
  for (const file of [pfxPath, metaPath]) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}

function create() {
  fs.mkdirSync(certDir, { recursive: true });
  if (fs.existsSync(pfxPath) && fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    console.log('reusing', pfxPath);
    console.log('thumbprint', meta.thumbprint);
    return meta;
  }
  const password = crypto.randomBytes(18).toString('base64url');
  const script = [
    `$ErrorActionPreference = 'Stop'`,
    `$cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject '${subject}' ` +
      `-CertStoreLocation 'Cert:\\CurrentUser\\My' -KeyExportPolicy Exportable ` +
      `-KeyUsage DigitalSignature -NotAfter (Get-Date).AddYears(3)`,
    `$pwd = ConvertTo-SecureString -String '${password}' -Force -AsPlainText`,
    `Export-PfxCertificate -Cert $cert -FilePath '${pfxPath}' -Password $pwd | Out-Null`,
    `$cert.Thumbprint`,
  ].join('\n');
  const thumbprint = powershell(script).split(/\r?\n/).pop().trim();
  const meta = {
    subject,
    thumbprint,
    password,
    created: new Date().toISOString(),
    note: 'development certificate only; replace with a CA-issued certificate before release',
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
  console.log('created', pfxPath);
  console.log('thumbprint', thumbprint);
  return meta;
}

if (process.argv.includes('--remove')) {
  remove();
  process.exit(0);
}

const meta = create();

if (process.argv.includes('--print')) {
  console.log('\nPowerShell:');
  console.log(`  $env:CSC_LINK = '${pfxPath}'`);
  console.log(`  $env:CSC_KEY_PASSWORD = '${meta.password}'`);
  console.log('\ncmd.exe:');
  console.log(`  set CSC_LINK=${pfxPath}`);
  console.log(`  set CSC_KEY_PASSWORD=${meta.password}`);
}
