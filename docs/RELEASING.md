# Releasing mdpad

The pipeline is automated end to end. Two things still need a human: a code-signing certificate
that Windows trusts, and an HTTPS endpoint for the update feed.

## What `npm run ship` does

1. renderer build (esbuild) and unit tests
2. package the app into `release/win-unpacked`
3. packaged smoke (250+ checks), crash recovery, real quit/relaunch restore
4. NSIS installer, portable exe, `latest.yml`, release notes from `CHANGELOG.md`
5. **signature check** when a certificate is configured (see below)
6. silent install → smoke the installed app → uninstall → verify user data survived
7. write `SHA256SUMS.txt`

If any step fails the pipeline stops; nothing is published.

## Signing

### With a real certificate

1. Obtain an OV or EV code-signing certificate and export it as a `.pfx`.
2. Put the secret in the shell that runs the release (never commit it):

   ```powershell
   $env:CSC_LINK = 'C:\path\to\mdpad.pfx'
   $env:CSC_KEY_PASSWORD = '...'
   ```

3. Run `npm run ship`. electron-builder signs the app exe, the portable exe, the installer and the
   uninstaller; because `CSC_LINK` is set, the pipeline runs
   `node scripts/verify-sign.js --require` and **fails the build** if any artifact lost its
   signature.
4. Check what Windows thinks:

   ```powershell
   npm run sign-check                       # report
   node scripts/verify-sign.js --require-trusted   # fail unless Status = Valid
   ```

   `Get-AuthenticodeSignature` must report `Valid` and the subject must name you.

### Trying the signing path without a CA certificate

For local verification of the mechanism (not for distribution):

```powershell
npm run cert          # creates build/certs/mdpad-dev.pfx and prints the env block
$env:CSC_LINK = 'E:\code\mdpad\build\certs\mdpad-dev.pfx'
$env:CSC_KEY_PASSWORD = '<printed>'
npm run ship
```

`npm run cert` uses `New-SelfSignedCertificate` in `Cert:\CurrentUser\My`, exports a PFX and
records the thumbprint in `build/certs/dev-cert.json` (git-ignored). Remove it with
`node scripts/make-dev-cert.js --remove`.

A self-signed signature is real but **not trusted**: `Get-AuthenticodeSignature` reports
`UnknownError`, and SmartScreen still says "Unknown publisher". That is the difference the
certificate purchase buys, and the reason `verify-sign.js` separates "signed" from "trusted":

| Output | Meaning | `--require` | `--require-trusted` |
| --- | --- | --- | --- |
| `signed, trusted` | a CA the machine trusts signed it | pass | pass |
| `signed, untrusted` | signature present, signer unknown (self-signed) | pass | fail |
| `UNSIGNED` | no signature at all | fail | fail |

Without a signature, Windows SmartScreen warns on first run ("Unknown publisher"), which is a
trust problem no amount of in-app polish fixes.

## Update feed

`electron-updater` is wired to a generic feed and the check path is tested against a local server.
To make updates installable:

1. Host the contents of `release/` (`latest.yml`, `*.exe`, `*.blockmap`) on an HTTPS endpoint.
2. Point `build.publish` at it in `package.json`:

   ```json
   "publish": [{ "provider": "generic", "url": "https://updates.example.com/mdpad/" }]
   ```

3. Ship a **signed** build with a higher version than the installed one.
4. From an installed older build, Help → Check for updates reports the version, downloads it and
   offers to restart. electron-updater refuses unsigned downloads, so signing comes first.

## Publishing to GitHub Releases

The repository is private (`AICCer1/mdpad`) and the installers are **not** committed — GitHub
rejects files over 100 MB, and keeping 110 MB binaries in history would bloat every clone. The
artefacts are attached to a release instead:

```powershell
node scripts/publish.js
```

The script commits any pending change, pushes `main`, creates and pushes the tag, creates the
GitHub release with the notes from `release/RELEASE_NOTES.md` and uploads
`mdpad Setup <version>.exe`, `mdpad <version>.exe`, the blockmap, `latest.yml` and
`SHA256SUMS.txt`. Credentials come from `~/.git-credentials`, the same account `git push` uses. It
is idempotent: an existing release is reported instead of duplicated.

**Gotcha:** GitHub rewrites spaces in asset names (`mdpad Setup 1.1.7.exe` becomes
`mdpad.Setup.1.1.7.exe`). `latest.yml` still names the original file, so pointing
`electron-updater` at the GitHub release URL would 404. Either host `release/` yourself behind a
generic feed (names preserved) or set `"artifactName": "mdpad-${version}-setup.${ext}"` and
regenerate `latest.yml` so names match.

## Release checklist

- [ ] `CHANGELOG.md` has a section for the version being shipped
- [ ] `package.json` version matches that section
- [ ] unit tests green (`node --test`)
- [ ] `npm run ship` completed without a FAILED line
- [ ] `node scripts/verify-sign.js --require-trusted` passes for a public release
- [ ] `release/SHA256SUMS.txt` regenerated after the last artefact change
- [ ] old version artefacts deleted from `release/` before regenerating checksums
- [ ] `docs/` screenshots refreshed if the UI changed (`npm run shots`)
- [ ] README "known limitations" still true
- [ ] `node scripts/publish.js` uploaded the new release
