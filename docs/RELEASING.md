# Releasing mdpad

The artefacts in `release/` are unsigned. Two things are therefore still on the release
manager: a code-signing certificate, and a real update feed. Everything else is automated.

## What `npm run ship` does

1. renderer build (esbuild) and unit tests
2. package the app into `release/win-unpacked`
3. packaged smoke (180+ checks), crash recovery, real quit/relaunch restore
4. NSIS installer, portable exe, `latest.yml`, release notes from `CHANGELOG.md`
5. silent install → smoke the installed app → uninstall → verify user data survived
6. write `SHA256SUMS.txt`

If any step fails the pipeline stops; nothing is published.

## Adding a certificate

1. Obtain a code-signing certificate (OV or EV) and export it as a `.pfx`.
2. Export the secret in the shell that runs the release (never commit it):

   ```powershell
   $env:CSC_LINK = 'C:\path\to\mdpad.pfx'
   $env:CSC_KEY_PASSWORD = '...'
   ```

3. Re-run `npm run ship`. electron-builder signs the installer and the portable exe when
   `CSC_LINK` is present; `latest.yml` then carries the signature.
4. Verify:

   ```powershell
   Get-AuthenticodeSignature 'release\mdpad Setup <version>.exe' | Format-List
   ```

   `Status` must be `Valid`, and `SignerCertificate.Subject` must name you.

Without this step Windows SmartScreen warns on first run ("Unknown publisher"), which is a
trust problem no amount of in-app polish fixes.

## Switching on auto-update

`electron-updater` is already wired to a generic feed and the *check* path is tested against a
local feed. To make updates installable:

1. Host the contents of `release/` (`latest.yml`, `*.exe`, `*.blockmap`) on an HTTPS endpoint.
2. Point `build.publish` at it in `package.json`:

   ```json
   "publish": [{ "provider": "generic", "url": "https://updates.example.com/mdpad/" }]
   ```

3. Ship a signed build whose version is higher than the installed one.
4. Verify from an installed older build: Help → Check for updates should report the new
   version, download it and offer to restart. An unsigned download is refused by the updater,
   which is why step 1 of this document comes first.

## Publishing to GitHub Releases

The repository is private (`AICCer1/mdpad`) and the installers are **not** committed — GitHub
rejects files over 100 MB, and keeping 110 MB binaries in history would bloat every clone. The
artefacts are attached to a release instead:

```powershell
git tag -a v1.1.7 -m "mdpad 1.1.7"
git push origin main --tags
# then create the release and upload
#   mdpad Setup <version>.exe, mdpad <version>.exe, *.blockmap, latest.yml, SHA256SUMS.txt
```

**Gotcha:** GitHub rewrites spaces in asset names to dots (`mdpad Setup 1.1.7.exe` becomes
`mdpad.Setup.1.1.7.exe`). `latest.yml` still names the original file, so pointing
`electron-updater` at the GitHub release URL would 404. Two ways out:

- host `release/` yourself behind a generic feed (names preserved), or
- rename artefacts before packaging, e.g. `"artifactName": "mdpad-${version}-setup.${ext}"`,
  and regenerate `latest.yml` so the names match.

## Release checklist

- [ ] `CHANGELOG.md` has a section for the version being shipped
- [ ] `package.json` version matches that section
- [ ] unit tests green (`node --test`)
- [ ] `npm run ship` completed without a FAILED line
- [ ] installer signed and `Get-AuthenticodeSignature` reports `Valid`
- [ ] `release/SHA256SUMS.txt` regenerated after the last artefact change
- [ ] `docs/` screenshots refreshed if the UI changed (`npm run shots`)
- [ ] README "known limitations" still true
