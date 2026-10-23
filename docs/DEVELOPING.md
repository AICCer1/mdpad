# mdpad — development and release

## Layout

```
src/storage.js          atomic write, backup rotation, drafts        (unit-tested)
src/markdown.js         markdown -> HTML for export, outline helpers (unit-tested)
src/i18n.js             en/zh dictionary shared by main + renderer   (unit-tested)
src/session-restore.js  pure restore planning (windows/tabs caps)    (unit-tested)
src/preflight.js        writable-data-dir check at startup             (unit-tested)
src/cli.js              command-line file argument parsing            (unit-tested)
src/window-bounds.js    keeps saved bounds on a connected display    (unit-tested)
src/export-limits.js    large-export threshold + size formatting    (unit-tested)
src/filename.js         export name template + sanitising            (unit-tested)
src/drafts.js           recovery-draft enumeration                   (unit-tested)
src/dirty.js            close-guard summary text                     (unit-tested)
src/retry.js            one retry for EBUSY/EACCES on writes        (unit-tested)
src/startup-guard.js    skip restore after repeated crashes         (unit-tested)
src/color.js            WCAG contrast math                           (unit-tested)
src/ai-history.js       AI turn pruning (age + count)                 (unit-tested)
src/ai-errors.js        maps request errors to actionable hints        (unit-tested)
src/ai-scope.js         context-scope defaults and auto-narrowing     (unit-tested)
src/link-guard.js       safe URL schemes and modifier-click rules     (unit-tested)
src/ai-models.js        GET /models parsing with a timeout            (unit-tested)
test/shortcuts.test.js  accelerator/menu consistency                  (unit-tested)
src/ai.js               OpenAI-compatible chat + SSE streaming       (unit-tested)
src/errors.js           errno -> message key mapping                 (unit-tested)
src/diff.js             word-level LCS diff for AI review            (unit-tested)
src/updater.js          electron-updater wrapper with a timeout
src/exporter.js         standalone HTML + PDF (+ templates)
src/exporters/          docx and EPUB writers
src/main.js             sessions, tabs, IPC, watchers, smoke runner
src/preload.js          contextBridge surface; no Node in the renderer
src/renderer/app.js     Tiptap editor, tabs, tree, palette, AI panel (ESM source)
scripts/                build, smoke, crash, install, release tooling
```

## Editing model

The editor holds a ProseMirror document; markdown is its serialization.

```
keystroke -> transaction -> editor.getMarkdown() (300 ms debounce)
          -> doc:syncChange -> main stores markdown, drafts it, autosaves it
```

The main process never parses the document; it only sees markdown. That keeps storage,
backup, export and the editor independent.

Tab switches keep per-tab undo history by caching the ProseMirror `EditorState` keyed by
tab id. The cached markdown is compared with the contents main sends: if the file changed on
disk (or another window saved it), the cache is dropped and the content reloaded.

On load the editor sends its own serialization back (`doc:normalize`) so whitespace
normalization does not mark a freshly opened file as dirty.

## Commands

```bash
npm install            # deps + vendor assets
npm start              # build renderer, open the window
npm run dev            # esbuild --watch
npm test               # 142 unit tests, no Electron
npm run smoke          # 201 end-to-end checks against a real window
npm run crash          # SIGKILL mid-edit, restart, verify draft recovery
npm run restart-check  # clean quit, relaunch, verify windows/tabs came back
npm run dist           # NSIS installer + portable exe
npm run dist:dir       # unpacked build only
npm run notes          # release/RELEASE_NOTES.md from CHANGELOG
npm run shots          # capture docs/images/*.png from the real UI
npm run release-check  # build -> package -> packaged smoke -> crash -> portable
npm run install-check  # silent install -> smoke installed app -> uninstall
npm run ship           # everything above, then SHA256SUMS.txt
```

`MDPAD_SMOKE_BIN` / `MDPAD_CRASH_BIN` point the suites at a packaged binary:

```bash
MDPAD_SMOKE_BIN=release/win-unpacked/mdpad.exe node scripts/smoke.js
node scripts/smoke.js --json   # single JSON document on stdout, for CI
```

## Testing philosophy

- Unit tests cover pure logic only (storage, markdown, diff, i18n, errno mapping).
- The smoke suite drives the real renderer through IPC and DOM: draft/backup/recovery,
  toolbar, tables, math, images, exports, tabs, windows, tree, palette, AI streaming,
  settings, updates, performance gates.
- Each suite runs against a packaged binary in CI-style checks, because asar packing
  changes path resolution.
- Crash recovery is verified by a real SIGKILL, not by calling the storage API.
- Session persistence is verified by a real quit and relaunch (`scripts/restart-check.js`),
  so the write-on-quit path is exercised too.

The suite takes roughly three minutes: the in-app watchdog is 240 s and the external runner
300 s. Both have been raised twice as checks and deliberate waits accumulated — when a run
stops without SMOKE_RESULT, check these numbers before hunting for a logic bug.

Smoke runs use an isolated `userData` directory (`MDPAD_USERDATA` or a temp folder) and
pin the UI language to English so assertions do not depend on the host locale.

## Startup budget

Cold start to first paint is measured at 258 ms packaged and ~644 ms in dev (esbuild
output plus no asar). The smoke suite budgets 5 s packaged and 10 s in dev, because CI
machines are noisy; `app:info.startupMs` exposes the number.

## Visual checks

Screenshots are captured from the real UI (`npm run shots`). Because a class like
`.modal { display: flex }` silently overrides the `hidden` attribute, the smoke suite
asserts `getComputedStyle(...).display === "none"` for every overlay at startup and that
opening/closing the settings panel flips it between `flex` and `none`.

## Platform notes (Windows)

- `printToPDF` on a hidden window hangs unless `backgroundThrottling: false`.
- After `loadURL` resolves, `isLoading()` can still be true; do not add a second wait.
- `fs.renameSync` over an open file can fail; `atomicWrite` falls back to copy+unlink.
- Electron may keep the process alive after `process.exit()` once a second window
  exists; `scripts/smoke.js` observes the result and kills the process tree.
- `String.replace` expands `$` in the replacement string (`$&`, `$'`, backtick-dollar),
  which once duplicated the user guide and this file into several copies. Use a replacer
  function for text containing `$`; `test/docs.test.js` rejects duplicated headings.
- PowerShell rewrites of UTF-8 files can inject a BOM or GBK mojibake. Never use
  `Set-Content -Encoding utf8` on JSON/Markdown; `test/encoding.test.js` guards this.
- Mermaid renders into a cache, never into a node view: ProseMirror re-creates node views on
  most transactions, so an async render writing into the then-detached element lands nowhere.
  Node views paint from the cache and a repaint pass updates live previews when a render ends.
- Focus mode marks the *top-level* block with a decoration (depth 1): decorating the textblock
  inside a table cell leaves the table wrapper dimmed, so the caret looks unfocused.
- Editor decorations are the only reliable way to style a live block: classes added by hand
  are wiped on the next ProseMirror render. Also never dispatch a transaction from inside an
  `update` handler that the transaction itself triggers — it recurses forever.
- Side columns use `flex-basis`, so a narrow-window media query must override `flex`, not
  `width` — setting `width` silently does nothing.
- Tiptap renders block math into `[data-type="block-math"]`, not KaTeX's `.katex-display`;
  style that element instead.
- electron-builder fails with `"name"... is not valid JSON` if package.json gains a BOM.

## Release steps

1. Bump `package.json` version and add the CHANGELOG section.
2. `npm run release-check` — build, package, packaged smoke, crash recovery, portable.
3. `npm run install-check` — install, smoke the installed app, uninstall, verify clean.
4. `npm run dist` — installer and portable artifacts in `release/`.
5. `npm run notes` — release notes from the changelog.

**Signing gap:** the installer is unsigned, so Windows SmartScreen warns and
auto-update cannot install. Both need a code-signing certificate and a real update feed;
the update *check* path is implemented and tested against a local feed.

See [RELEASING.md](RELEASING.md) for the signing and update-feed steps that `npm run ship`
cannot do on its own.
