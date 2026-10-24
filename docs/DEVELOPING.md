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
npm run smoke          # 304 end-to-end checks against a real window
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
- AI endpoints go through `src/ai-endpoint.js`: a bare host gets `/chat/completions`, a
  full endpoint is kept, and a 404 from a bare host is retried once with `/v1`. The smoke
  suite runs the client against a local mock server, including that fallback.
- The AI target highlight is a ProseMirror decoration driven by `aiTargetDecoration`. Setting
  it is not enough: decorations are recomputed on transactions, so the panel dispatches a
  meta-only transaction (`aiTargetRefresh`) when it opens or clears.
- Programmatic edits (AI insert/replace) must call `closeHistory(tr)` in a first transaction,
  otherwise ProseMirror merges them with the typing before them and one undo wipes both.
- Tab switching caches the ProseMirror state, which restores the selection but not the scroll
  position: `editorStateCache` also stores `tabScroll`, restored in a `requestAnimationFrame`
  after the new content is laid out and clamped to the new height.
- Drafts rows are `div[role=button]`: a `<button>` inside a `<button>` is invalid HTML and the
  inner click is swallowed. The row keeps an Enter/Space handler for keyboard use.
- `step(name, ok, extra)` spreads `extra` over the result, so an `ok` key inside the details
  silently replaces the assertion. Pass diagnostics only.
- The smoke suite has two watchdogs: 330 s inside the app and 360 s in `scripts/smoke.js`.
  Adding checks pushed the run past the old 240 s, which killed the app after every step had
  already passed and produced "no SMOKE_RESULT" with no failure listed.
- `process.exit()` right after the result line can truncate piped stdout on Windows; the runner
  sets `process.exitCode` and exits a tick later instead.
- The save conflict guard compares the file against `diskRaw` (the bytes we last read or
  wrote), not against `savedContents`: the editor normalizes markdown on load, so the stored
  baseline and the file differ by design and comparing them reports a conflict on every save.
- Draft writes have a leading edge: the first change of a burst is written synchronously in
  `doc:syncChange`, later ones are coalesced. Blur, visibility change, `before-quit` and
  `powerMonitor` suspend flush the buffer, so an Alt-F4 or a sleep does not wait for a debounce.
  A change that arrives for a background tab is stored in that tab; it is never dropped and never
  written over the newly active document.
- `clipboard.readText()` returns a promise in this Electron version; a synchronous call yields
  a pending Promise, not a string.
- `nativeTheme` must be imported from `electron`: referencing it without the import throws
  while registering IPC, and Electron then shows a blocking error dialog — the app looks like it
  hangs at startup with no stdout at all.
- `nativeTheme` must be imported from `electron`: referencing it without the import throws while
  registering IPC, and Electron then shows a blocking error dialog — the app looks like it hangs
  at startup with no stdout at all.

- `npm run shot-export` renders an exported HTML document in a window and captures it to
  `docs/images/10-export-page.png`; use it to eyeball export typography without opening a PDF.
- The export thumbnail is a real render: `export:thumbnail` builds the same HTML the export
  would, loads it in one reusable hidden window (420×560, JavaScript off) and returns
  `capturePage()` as a PNG data URL. It is debounced by 260 ms and guarded by a token so a slow
  older render cannot overwrite a newer one.
- Export appearance lives in `exportFont` / `exportMargin`: the HTML path gets a font-family
  override and `body[data-margin]` padding, the PDF path converts the same choice into
  `printToPDF` margins (inches). DOCX and EPUB ignore them by design and the panel disables the
  controls for those formats.
- `applyI18n()` rewrites `textContent`, which wipes an SVG inside a button that also carries
  `data-i18n`; it re-runs `applyStaticIcons()` afterwards.
- Theme changes add `theme-swap` for two frames: without it every transitioned colour interpolates
  during the swap, and a contrast measurement taken immediately after sees the old palette.
- Diagrams reach exports through `doc:diagrams`: the renderer renders each Mermaid fence with
  the light theme (exports are light documents) and sends a `{ source: svg }` map; `renderHtml`
  swaps a matching fence for `<figure class="mermaid-figure">`. Word export cannot use this
  path because docx needs a raster image.
- Mermaid node views own a preview/edit mode. Toggling `pre.hidden` must be declared in
  `ignoreMutation`, otherwise ProseMirror rebuilds the node view (losing the mode) on the next
  transaction.
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

- `npm run feed` serves `release/` as a generic feed with the version raised by one
  patch level, for exercising the update path by hand.
- `scripts/feed.js` keeps the served file name unchanged, so the sha512 in `latest.yml` still
  matches while the version looks newer.

## Images

Inserted images are decoded with `createImageBitmap`, downscaled to 2200 px on the long edge and
encoded twice (JPEG 0.85 unless the bitmap has alpha, and PNG); the smaller blob wins and the
original file is kept when neither beats it. JPEG wins on photos, PNG wins on screenshots of text —
a fixed format choice would have inflated one of the two.

## Exported links

`src/exporters/links.js` marks relative anchors in exported HTML/EPUB: a missing target gets
`data-link-missing="1"` plus a title, so the reader sees why nothing happens. The HTML export
needs `baseDir` (the document folder) to resolve targets; EPUB marks every relative `.md` link
because the container never carries the file. Word gets `ExternalHyperlink` for http/mailto.

## Links

`doc:openRelative` resolves `href` against the session file, strips `#…`/`?…`, decodes it and
tries `.md`; it answers `{ opened: false, reason }` for `missing` and `unsaved` instead of
throwing. Anchor links are handled entirely in the renderer by slugifying heading text.

## Recent files

`recent:entries` returns the stored list unfiltered with an `exists` flag, while the menu and
palette keep using the filtered `recentFiles()`; `recent:open` answers
`{ opened: false, reason: "missing" }` instead of throwing, so the panel can explain the failure.

## Jump history

Positions are pushed **before** the selection moves (`pushNav(from)` in `stepFind` and the find
input handler) — recording after `focusMatch` stores the destination and makes Alt+Left a no-op.
Outline clicks focus `pos + 1` so the caret lands inside the heading rather than at its boundary.

## Outline

Folding is a `Set` of `level:text` keys; `renderOutline` walks a flat list and skips items deeper
than a folded heading. Scroll-follow resolves the caret position at the top of the pane with
`posAtCoords` inside a `requestAnimationFrame`, so it does not fight the caret-based highlight.

## Blocks

`replaceBlocks` rebuilds the document and sets the selection with `Selection.near(tr.doc.resolve(pos))`.
Resolving against a separately built document throws "Selection passed to setSelection must point
at the current document" — the selection must be resolved against the transaction's own doc.

## Quotes

`indentBlockquote` wraps with `wrapIn(blockquote)` or lifts with `lift`; the key handler checks
whether the caret sits in a list item first, so Tab in a list still reaches ProseMirror's
sink/lift keymap and only quotes get the new behaviour.

## Task lists

Task state lives on the TaskItem node and serialises to `- [ ]` / `- [x]`. HTML and EPUB exports
use marked's checkbox rendering; the Word exporter has no checkbox primitive, so it prefixes the
item text with ☐ or ☑ (`taskPrefix` in `exporters/docx.js`).

## Find and replace

`collectMatches` applies the case / whole-word / regex options in one pass over text nodes and caps
results at 2000. Replace-all runs in reverse order so earlier positions stay valid, inside a single
transaction; `isolateHistoryStep` (`closeHistory`) makes that transaction its own undo step, otherwise
ProseMirror merges it into the typing batch and one undo removes both.

## Input rules and paste

`inlineMarkdownInputRules` uses `markInputRule` for bold, italic, strike and code. The italic
pattern carries a negative lookbehind so it does not swallow the closing `**` of bold. The paste
guard (`looksLikeMarkdown`) parses a pasted block only on a strong signal, so prose and `#tag`
stay literal.

## Export templates

`npm run shot-export` renders all three templates to `docs/images/10..12`. `tocHtml` reuses
`outline()` so heading ids match the rendered document (duplicate titles get `-1` suffixes);
the title is passed in as `tocTitle` so a Chinese UI exports `目录`.

## Multiple windows

`broadcastSettings()` sends `settings:applied` to **all** windows after a settings write (the
sender included: a programmatic change must not leave the origin window stale). The renderer
applies theme, language, typography, file-tree state and find options in `applyRemoteSettings`.

## Recovery paths

`drafts:restore` opens a new untitled tab when the draft points at a file that no longer exists
(`missingOriginal`) — sending it to the active tab would overwrite the user's current document.
The backup round-trip test restores, saves and asserts the replaced version became the newest
backup.

`storage.saveDocument` treats the backup as optional: a failing rotation returns
`backupError` and the atomic write still runs. `listBackups` returns `[]` for a non-directory
path instead of throwing, because it is called while reporting a save that already succeeded.
The backup warning is sent **after** the `saved` status — sending it before let the save handler
hide the banner it had just raised.

`writeDraftNow` catches its own storage errors: the first failure sets `draftBroken` and sends
`draftError` once; the next successful write sends `draftOk`. The renderer turns that into a
banner that clears itself, so a broken drafts folder cannot masquerade as protection.

`runExportSafely` converts a throwing export into `{ exported: false, error }`; the renderer shows
a Retry banner. `readSettings` copies an unreadable file aside before returning defaults.

**Line endings:** the source files are CRLF in the working tree, so line-exact patching scripts
must normalise `\r\n` to `\n` before comparing lines — otherwise every exact-match replacement
silently misses.

## Export consistency

`npm run export-probe` exports one document to HTML, Word and EPUB in plain Node and prints which
blocks each format kept. The smoke suite runs the same document through all four formats
(`export-consistency`), including the PDF's structure (header, image XObject, fonts) because PDF
text is not readable without a parser.

## Performance

`npm run perf` runs the app with `--perf-report`, builds a 14k-word document, measures load,
outline, find, typing and both exports, prints JSON and writes the artefacts to `%TEMP%`. The
smoke suite keeps a lighter guard (`perf-long-doc`). Numbers and caveats live in
[PERFORMANCE.md](PERFORMANCE.md).

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

## Export inspection

`export:inspect` counts images/links/tables/diagrams/math/tasks in the current buffer and resolves
relative image and link targets against the document folder; the panel renders it under the
format summary and refreshes on every open.

## Dialogs and keyboards

`prepareDialogs()` adds `role="dialog"`, `aria-modal` and `aria-labelledby` to every modal card;
`trapModalFocus` is a capturing Tab handler that keeps focus inside the topmost open modal, and a
MutationObserver moves focus in when a modal becomes visible. The smoke test presses Tab 18 times
and asserts focus never leaves the dialog.

## Document semantics

`labelEditor()` gives the ProseMirror content a `textbox` role, `aria-multiline` and a localised
name (re-applied by `applyI18n`). `markCurrentOutline` sets `aria-current="location"` on the
active heading and clears it elsewhere; twisties already carried `aria-expanded`. One smoke check
(`a11y-document`) asserts the editor attributes, the current section after a real caret move, and
that folding flips `aria-expanded` to `false`.

## Tabs

`#tab-list` carries `role="tablist"`; each tab gets `role="tab"`, `aria-selected` and a roving
`tabindex` (active 0, others -1). `moveTabFocus` handles Left/Right, the strip handles Home/End and
Delete. `renderTabs` remembers which tab had focus (`focusedTabId`) and restores it after the
rebuild — without that, every tab switch dropped focus to the document and the keyboard model
silently stopped working.

## Large documents

`setMarkdown` stays the synchronous path for small content (tabs, drafts, AI apply). Files above
128 KB go through `setMarkdownProgressive`, which splits at `\n\n` boundaries, inserts one chunk
per `setTimeout(0)` and suppresses change emission with `applying`. The smoke check
`large-doc-open` opens an 800 KB file, waits for the last section and asserts the outline has all
1201 headings — chunking must never drop a block.

## Typing performance

`markLargeDocument()` toggles `is-large` on the editor above 200k characters; the stylesheet then
applies `content-visibility: auto` to top-level blocks. `scheduleChange` skips the leading-edge
sync for those documents. `large-doc-typing` inserts 18 characters through the real editor and
asserts average under 25 ms and worst under 60 ms — the numbers regressed badly once, so they are
guarded.

## Table reordering

`moveTableRow` and `moveTableColumn` rebuild the table node and replace it in one transaction —
never by position arithmetic inside the table. Columns are rebuilt per row; a merged cell aborts
the move with a message, because column identity is undefined there. `table-move` asserts the
resulting markdown after a real row move and column move.
