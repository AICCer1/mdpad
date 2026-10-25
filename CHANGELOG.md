# Changelog

## 2.6.0

A hypothesis about PDF batching, tested and rejected.

- **`--bench-pdf` measures print scaling**: 0.5 → 1 → 2 → 4 MB costs 943 → 1854 → 3964 → 9934 ms, i.e.
  ~2.0–2.5× per doubling. Batching into halves and merging would save ~6% at 2 MB and ~20% at 4 MB, at
  the cost of a PDF merge dependency, broken page numbering and no single table of contents — so it was
  rejected and the numbers recorded in `docs/PERFORMANCE.md`.
- **Two real fixes came out of running the benchmark**: the print temp file had one name per process,
  so two windows exporting a PDF at the same time would overwrite each other (now unique per export),
  and a transient `ERR_FAILED` while loading that file failed the whole export (now retried once).
- 343 smoke checks unchanged, 183 unit tests.

## 2.5.0

PDF export, measured before it was changed.

- **`toPdf` now reports its phases** and `--bench-export` prints them. On a 2 MB document: build 201 ms,
  write 5 ms, load 557 ms, **print 3253 ms** — printing is 81% of the export and is where the time
  actually goes.
- **Page numbers became a setting** after measuring what they cost: `displayHeaderFooter` adds 445 ms
  per export (14%); `printBackground` costs nothing measurable, so it stays on. The new **Page numbers**
  checkbox (on by default) lets a large PDF export finish ~14% faster.
- 343 smoke checks (one new: `export-page-numbers` exports the same document both ways, asserts the
  footer-less file is smaller, and that the setting and the panel checkbox agree), 183 unit tests.
- `docs/PERFORMANCE.md` now carries the phase table and the two experiments, so the next improvement
  starts from numbers rather than guesses.

## 2.4.0

The window comes back where it can be seen.

- **A window saved on an unplugged monitor is moved into the primary work area with its size kept** —
  before, the whole position was discarded and the app reopened at the default size.
- **Oversized windows are shrunk to the display** they mostly occupy, so their edges and resize handles
  stay reachable; before, a 3000×2000 window was restored as such on a 1920×1040 screen.
- **A title bar that would sit above the screen comes back down**, and a window with only a one-pixel
  sliver visible is treated as unreachable. Multi-monitor windows that are genuinely reachable stay put.
- 183 unit tests (nine new bounds cases, including a single 800×600 display and non-finite values);
  342 smoke checks unchanged.

## 2.3.0

A tab that cannot come back says so.

- **Missing files are reported, not dropped silently.** Restoring a session used to skip deleted files
  with only a log line; now a notice names up to three of them ("2 tabs were not reopened: notes.md,
  plan.md") so the disappearance is explained.
- **The caret now survives a restart too**: `planRestore` used to rebuild tabs without their view, so
  the position was lost exactly when it mattered. It travels with the tab.
- **Maximised windows reopen maximised** — the snapshot records the flag, not only the bounds.
- 342 smoke checks (one new: `restore-missing-tabs` checks the wording for one, several and no files),
  177 unit tests (three new for the planner: view, missing list, maximised).

## 2.2.0

Long documents reopen where you left them.

- **Each tab remembers its caret and scroll.** The renderer reports them (debounced after a selection
  change), `session.json` stores them per tab, and `doc:loaded` puts the caret back — clamped when the
  document has become shorter.
- 341 smoke checks (one new: `view-restore` moves the caret into a 40-paragraph document, persists a
  scroll, reloads the document and asserts the caret returned to the same offset and the scroll reached
  the tab state), 174 unit tests.
- The hidden smoke window has no viewport, so the check asserts the persisted scroll value rather than
  pixels; that limitation is documented in the developer notes.

## 2.1.0

Exports are remembered.

- **The export panel lists the last ten exports** with format and age; clicking one opens it. A file
  that has since moved is marked "file not found" rather than appearing to open, and **Clear** empties
  the list. Entries are de-duplicated by path and recorded for every format, including sections.
- 340 smoke checks (one new: `export-history` clears the list, exports a section, asserts the stored
  entry and the rendered row, then clears it from the panel and checks both storage and UI are empty),
  174 unit tests.
- The panel needed an explicit `renderExportHistory()` call on open; without it the list was built but
  never inserted, which the new check caught immediately.

## 2.0.2

An export ends with something you can act on.

- **Every finished export offers Open, Show in folder and Copy path** — documents, sections, statistics
  and structure reports now share one toast instead of four different ones, two of which only offered
  "Show in folder" and one of which flashed a name and nothing else.
- **Actions report their own failure**: a moved file says "Could not open the file: file not found", a
  folder that cannot be revealed says so, instead of the click appearing to work.
- **The 50k-character edit check no longer measures luck**: it takes the median of five inserts (with a
  generous ceiling on the slowest), because a single cold insert after an install could read 445 ms on a
  machine that settles at 240 ms.
- 339 smoke checks (one new: `export-actions` asserts the three buttons, that Copy puts the real path on
  the clipboard, that Open works for an existing file and that both failure messages appear), 174 unit
  tests.

## 2.0.1

Documentation that cannot drift.

- **The README admitted 155 unit tests while the suite had 174** — a number nobody updates. It now
  names the runner instead of a count, and a test fails if the stated number of smoke checks differs
  from the number of `step(` calls in the runner.
- **The image-audit paragraph appeared twice** in the README; removed.
- **`docs/RELEASE_NOTES-2.0.md`** collects what 2.0 means, how it is verified, the known limitations
  and how to verify a download.
- Two more doc tests: the changelog must have an entry for the current version, and the 2.0 notes must
  name the 2.0.0 installer.
- 338 smoke checks, 174 unit tests.

## 2.0.0

The export panel learns to narrow its scope — and a silent watcher failure is fixed.

- **The export panel has a range switch**: whole document or the section at the caret, with the
  heading named in a hint and the section option politely unavailable outside a heading. Every format
  follows it; a section export is no longer something only the palette knows about.
- **External changes are detected even when `fs.watch` goes quiet** (from 1.99.0): a stat poll runs
  beside the handle and both paths share one handler, so ask/auto/ignore cannot diverge.
- **Sections export on their own** (1.99.0): fenced code cannot split a section, duplicate titles are
  matched by occurrence, and the session buffer is untouched.
- 338 smoke checks, 171 unit tests, and the packaged pipeline still passes crash, first-run, restart,
  install and upgrade before the installer is published.

## 1.99.0

Export one section, and never miss an external change.

- **The palette exports the section at the caret as HTML or PDF**: the heading and everything under it
  become a standalone file. Duplicate titles are matched by occurrence, fenced code is skipped so a
  `## ` line inside it cannot split the section, and the session buffer is untouched
  (`exportToUnsafe` now takes a contents override).
- **External changes are detected even when `fs.watch` goes quiet**: the watcher keeps its handle and
  also polls the file size and mtime every two seconds. This was found by a smoke check that started
  failing deterministically — the handle simply delivered nothing, so a clean buffer never reloaded.
  Both paths share one handler, so the ask/auto/ignore rules cannot diverge.
- 337 smoke checks (one new: `export-section` asserts the slice excludes the next section, that the
  written HTML excludes it too, and that a different caret produces the other section), 171 unit tests.

## 1.98.0

The outline counts words.

- **Every outline row shows the words under that heading**, and a folded row shows how many the fold is
  hiding: `2,140 (+980)`. Long sections are visible at a glance without selecting them.
- Counts are **inclusive** of nested sections, so a parent never looks smaller than its children; the
  hidden total is the section size minus its own body, which avoids double counting.
- Skipped above roughly 600k characters, where walking ranges would cost more than the number is worth.
- 336 smoke checks (one new: `outline-word-counts` asserts the per-section counts, the folded `+4`, and
  that unfolding no longer shows a hidden total), 171 unit tests.

## 1.97.0

The outline and the editor share one fold state.

- **Folding from the outline folds the page**, and **Ctrl+Shift+H in the editor updates the outline** —
  both read and write the same `foldedHeadings` set instead of keeping private copies.
- **Outline folds now survive a restart**: they use the same per-document persistence as the editor
  folds, so a long manuscript reopens folded the way it was left.
- Keys are `level:text:occurrence` in both places, so duplicate titles fold independently in either
  view.
- 335 smoke checks (one new: `fold-sync` folds a section from the outline twisty, asserts the editor
  hides blocks and the outline shrinks, then unfolds with the editor command and asserts both returned),
  171 unit tests.

## 1.96.0

Headings fold in the editor.

- **Ctrl+Shift+H** (View menu, palette) folds the heading at the caret: its section hides, the heading
  gets a `▸` marker and **the markdown is untouched** — folding is a reading aid, not an edit.
- **Folds are remembered per document** in settings (`foldedHeadings[file]`) and restored when the file
  is reopened, including on the first document of a session where the settings broadcast has not
  arrived yet (the restore falls back to fetching them).
- Keys are `level:text:occurrence`, so two headings with the same title fold independently and edits
  elsewhere do not move the fold to another section.
- 334 smoke checks (one new: `heading-fold` folds, asserts hidden blocks and the marker, unfolds,
  folds again, reloads the document and asserts the fold came back), 171 unit tests.

## 1.95.0

Statistics can leave the app.

- **The statistics panel exports CSV and Markdown**: document counts, structure issues and the last
  fourteen days of writing. The CSV is one metric per row; the Markdown is a readable summary with a
  table and the streak. Both are built from the same payload as the panels, so they cannot disagree.
- `stats:save` drives the dialog; `stats:write` writes an explicit path and is what the test uses.
- 333 smoke checks (one new: `stats-export` asserts the CSV header, a document metric, a dated history
  row, the Markdown summary, both written files matching the generated text and both buttons), 171 unit
  tests.
- A self-inflicted rename (`statsExport` → `statsExportTest` to avoid a duplicate identifier) also
  renamed the **hook** `statsExportTo`, so the test called a function that did not exist. The type probe
  that finally found it is gone again.

## 1.94.0

Tips are shown once.

- **A hint strip above the editor offers three tips on first use**: the command palette, the F1 shortcut
  list, and dropping an image. Dismissing one stores it in `seenHints` and the next appears; when all
  three are seen the strip never returns.
- `settings:set` sanitises `seenHints` (booleans only, max 50 keys) and `publicSettings` exposes it, so
  the state survives restarts.
- 332 smoke checks (one new: `one-time-hints` resets the map, asserts the palette tip, dismisses through
  the queue, checks the strip disappears and reads the persisted flags back), 171 unit tests.
- Two placement mistakes on the way: the strip's markup was inserted with an anchor that did not exist,
  and `seenHints` landed inside the `findOptions` object instead of the settings result, so
  `getSettings()` never returned it.

## 1.93.0

The shortcuts list now tells the truth.

- **The help panel listed bindings that were wrong**: `Ctrl+Shift+P` appeared twice (palette and export
  PDF) and `Ctrl+K` was described as "open file" while it opens the folder. The list is rebuilt from the
  real menu accelerators and renderer handlers.
- **The actual conflict is fixed**: the palette keeps `Ctrl+Shift+P` (the convention) through a new
  View → Command Palette item, and Export PDF moves to `Ctrl+Alt+P`.
- **The panel has a filter and each runnable row has Run**, wired to the palette command of the same id.
  `shortcutsAudit()` reports ids that do not exist and the smoke check fails on them.
- 331 smoke checks (one new: `shortcuts-panel` opens the list, filters to "zoom", checks the no-match
  state, and presses Run on the Settings row), 171 unit tests.
- The unit test that validates the table needed updating for rows carrying `data-command` and for `Esc`
  as a legitimate single key.

## 1.92.0

The palette shows what it remembers.

- **With an empty search, used commands appear under a "Recently used" heading** — the learned order is
  visible instead of being an invisible sort. The header is not selectable, so keyboard indices still
  map one-to-one to commands.
- **Settings → Advanced shows "N command(s) remembered" with a Clear button**, and the row updates as
  you use the palette. Clearing resets the order and persists `{}`.
- 330 smoke checks (one new: `palette-usage-group` seeds usage, asserts the group and the first result,
  then clears it from Settings and asserts both the stored map and the row say zero), 171 unit tests.
- One patch landed inside the `for (const sub of …)` header and broke the bundle
  (`Expected ")" but found ";"`); the loop was rebuilt and the clear button inserted before it.

## 1.91.0

Headings are palette targets.

- **The palette lists the current document's headings** (levels 1–3, up to twelve) with `H2`-style
  hints; typing part of a section name and pressing Enter puts the caret in that heading and scrolls to
  it.
- **Recent files got ids and folder hints**: they now rank with the commands (including the usage
  counts from the keyboard) instead of always trailing the list, and show where they live.
- 329 smoke checks (one new: `palette-headings` loads a document, opens the palette, types "intro",
  presses Enter and asserts the caret is in the heading and the palette closed), 171 unit tests.
- The test opened the palette with Ctrl+K first; the actual shortcut is **Ctrl+Shift+P**, so the
  palette never opened and the assertion measured a closed panel. It now uses the same entry point the
  shortcut calls.

## 1.90.0

The command palette learns from the keyboard.

- **Running a command with Enter now counts as using it.** Previously only clicks updated the ranking,
  so a keyboard user's habits were invisible to the ordering.
- **Ranking is prefix first, then habit**: a command whose label starts with the query always beats a
  mere substring match, and usage breaks ties.
- **Arrow keys wrap** around the list, the active row is scrolled into view, and a search with no
  results says "No commands match." instead of showing an empty panel.
- 328 smoke checks (one new: `palette-keyboard` opens the palette with real keys, asserts the prefix
  order and the wrap from first to last, checks the empty state and closes with Escape), 171 unit
  tests.

## 1.89.0

Settings from the keyboard.

- **↓ / ↑ walk the matching fields**, the current one is outlined, and **Enter** jumps into its
  control — no mouse needed to find and change a setting.
- **Escape clears the search before it closes the panel**: after Enter the focus sits in a control, so
  Escape is handled by a document-capture listener rather than by the input. Without that, the global
  Escape closed the panel and threw the query away (the first test caught exactly this).
- 327 smoke checks (one new: `settings-keyboard` types a query, presses Down, Enter and Escape with real
  key events and asserts the marked field, the focused control, the cleared query and the later close),
  171 unit tests.

## 1.88.0

Folding survives a search.

- **A section that holds a hit opens for it** — before this, a match inside a folded section stayed
  hidden, so the search could report a field that the user could not see.
- **Clearing the query restores the exact folding you had**: one snapshot is taken before the first
  expanded result and put back afterwards, so the panel never stays rearranged after a search.
- 326 smoke checks (one new: `settings-search-collapse` folds the AI section, searches "api key",
  asserts the section opened, clears the query and asserts it is folded again), 171 unit tests.
- The first version of that test picked "Check spelling", which lives above the first section heading,
  so `sectionOfField` found nothing; it now targets "API key" inside the AI section.

## 1.87.0

Settings are findable by their labels.

- **The filter matches field labels** (it always did), but now several words narrow the list, a phrase
  like "writing goal" still finds "Daily word goal" through an any-word fallback instead of showing
  nothing, and the matched words are **highlighted** in the label.
- **A no-match state**: the panel says "No settings match." instead of silently going blank.
- **A self-check types every label** (`settingsSearchAudit`) and fails if a field hides itself, so a
  new setting with an unsearchable label breaks the suite.
- Two highlight bugs: clearing the query left `<mark>` elements behind because `textContent` cannot
  distinguish highlighted text from plain text (fixed by comparing `innerHTML` and rebuilding), and
  the first implementation used `innerHTML` with the label text — replaced by DOM node construction.
- 325 smoke checks (one new: `settings-search`), 171 unit tests.

## 1.86.0

The copy is audited now.

- **`npm run copy-audit`** checks both dictionaries: key parity, matching `{placeholders}`, `…` instead
  of `...`, no stray whitespace, no Latin prose left inside Chinese text, Title Case for short English
  menu labels (articles and the brand excepted). **Zero problems remain** after fixing what it found.
- **Nine menu labels were normalised**: "Focus Mode", "Full Screen", "Split into Two Windows", "Merge
  the Split Windows", "Copy Diagnostics", "Open Log Folder", "Welcome Guide", "Extract Embedded
  Images…", "Show All Recent Files…".
- The rules run in `node --test` (four new tests, including one that feeds the audit broken copy to
  prove it fails), so a missing translation or a mismatched placeholder breaks the build.
- Two false-positive rounds shaped the rules: placeholders and technical terms (`tokens`, `CSS`,
  `http://`, font names) were being flagged as "Latin in Chinese", and title-case checking flagged
  "About mdpad" and "Check for Updates…" until articles and the brand became stop words.
- 324 smoke checks, 171 unit tests.

## 1.85.0

Upgrades keep the profile.

- **`npm run upgrade-check`** installs the build, seeds a real profile — dark theme, Chinese UI, a
  session with one open file, one recovery draft — launches the **installed** app and asserts it
  reads all of it back: settings, restored tab, draft list. It then **reinstalls over the same
  directory** and verifies `settings.json`, `session.json` and the drafts are byte-for-byte unchanged.
- It runs inside `npm run ship` right after the install check, so a release that would wipe user data
  cannot be published.
- Four bugs found while building it: the phase dispatched **before** the normal session restore (it
  reported zero tabs until it ran `planRestore` itself), the script seeded `drafts/` while the app
  uses `draftsRecover/`, the installer unpacks asynchronously so the exe check needed a wait loop, and
  the reinstall assertion originally tried to relaunch the app (which hung) instead of comparing the
  profile files.
- 324 smoke checks, 167 unit tests.

## 1.84.0

The first minute is a test now.

- **`npm run first-run`** starts the app against an **empty profile** and asserts the first-run path
  from the rendered state: the welcome card is visible, the editor exists, the profile is not yet
  onboarded, then a document is created, saved and exported, and the opened tab is active and clean.
- **It runs inside `npm run ship`** against the packaged binary, next to the crash and restart checks,
  so a broken first launch cannot be published.
- The walkthrough hangs if it throws, so the phase now reports `{ok:false,error}` and exits; the first
  version also tried to open a file that did not exist yet (`cannot read ...`).
- 324 smoke checks, 167 unit tests.

## 1.83.0

The formats are checked against each other.

- **One smoke check exports the same document to HTML, Word and EPUB** and counts headings, tables,
  images, code blocks, list items, bold/italic runs and links in each output, comparing them with the
  source. A format that silently loses a table or an image now fails the suite.
- HTML and EPUB matched every count on the first run. **Word lists came back as 0** because the writer
  emits bullet paragraphs (`• `) rather than numbering XML — the check counts the bullet and the
  difference is documented in the user guide as a known limitation (lists keep text and indentation,
  but not Word numbering).
- 324 smoke checks (one new: `export-parity`), 167 unit tests.

## 1.82.0

Large exports are measured, and warned about first.

- **Measured with a new `--bench-export` mode** (`npm run perf-export`): a 2 MB document takes
  **8.1 s** for PDF (12.1 MB output), 1.4 s for DOCX and 481 ms for EPUB, with heap peaks around
  420–460 MB for the zip formats.
- **The export panel now warns above 300 000 characters**: "Large document — export can take several
  seconds (about 8 s for a 2 MB PDF)", next to the counts, so the wait is expected rather than
  mistaken for a hang.
- `PERFORMANCE.md` records the numbers for 0.5 MB and 2 MB documents.
- 323 smoke checks (one new: `export-large-hint` builds a 400-section document, waits for the load,
  opens the export panel and asserts the warning is rendered), 167 unit tests.

## 1.81.0

A failed export leaves nothing behind.

- **All four formats now have failure tests**: a target whose parent is a file (ENOTDIR/EEXIST) and a
  target that is a directory (EISDIR) — every one answers `{exported:false, error}` and creates no
  file.
- **`exportTo` removes a file that its own attempt created** before rethrowing; a file that existed
  before the attempt is never deleted. The read-only case is asserted explicitly: the overwrite is
  refused and the original text is intact (`refused: true, intact: true`).
- **One test insertion landed in the wrong test** — the "read-only" block was appended to the
  `input-rules` check because both end with `return results; })();`, which broke the suite with
  `jsOf is not defined`. It was moved to the right place and both checks pass.
- 322 smoke checks (one new: `export-failures-all` with nine failure paths), 167 unit tests.

## 1.80.0

Crash recovery is now tested across tabs.

- **A third crash scenario in the real SIGKILL suite**: two files open, both dirty, the process killed
  while the second tab is active. The verify phase asserts **two drafts** exist, each holds its own
  token, and they differ — guarding the round-16 regression where the background tab's draft was
  written from the active buffer.
- `scripts/crash-recovery.js` gained `tabs` / `tabs-verify` phases and a single `crashEnv()` helper;
  the previous script passed `MDPAD_CRASH_FILE_B` to only one of its two spawn branches, so the
  phase silently had no second file.
- The phase writes its result to a temp JSON **before** the kill, because a SIGKILL can drop buffered
  stdout; the verify phase reads the drafts themselves, which is the real assertion.
- Release pipeline now runs three crash scenarios (explicit write, fast typing, two tabs).
- 321 smoke checks, 167 unit tests.

## 1.79.0

Closing unsaved work is no longer silent — and Reopen keeps your text.

- **Closing a dirty tab writes a recovery draft and says so** in a toast with a **Reopen** action. The
  close result (`closedWithDraft`, `draftSaved`, `name`) drives the message; the keyboard Delete path
  and the tab context menu share it.
- **Reopen used to reload the file from disk**, quietly discarding the buffer it had just promised to
  restore. `reopenTab` now rebuilds the tab from `closedTabs[].contents`, with `savedContents` taken
  from disk so the restored text correctly shows as unsaved.
- **The first test passed `closeTab` through the API and asserted a toast that only the UI raises** —
  it now clicks the real close button, waits for the toast text and then reopens.
- 321 smoke checks (one new: `close-dirty-tab`), 167 unit tests.

## 1.78.0

External changes are your decision.

- **Settings → "When the file changes on disk"**: **Ask me** (banner with Reload / Keep editing),
  **Reload automatically**, or **Ignore**.
- **Automatic reload only applies to a clean buffer.** If the editor has unsaved text, the change
  falls through to the banner — a sync client can never quietly replace what you typed. This is the
  first policy test that mattered: it writes the file from outside and asserts the buffer still holds
  the local edit.
- The watcher used to always ask; the policy is read per event, so changing the setting takes effect
  without reopening the file.
- 320 smoke checks (one new: `external-change-policy` exercises all three modes with real disk
  writes and asserts both the buffer text and the banner), 167 unit tests.

## 1.77.0

Fourteen days of writing, at a glance.

- **Click the goal indicator** (or use the palette) for a bar chart of the last 14 days, with the
  streak, the best day and the total; bars turn accent-coloured on days that met the goal.
- **The rules are a pure module** (`src/writing.js`) with seven unit tests: a gap stops the streak, a
  missing today falls back to yesterday (writing late at night is not punished), junk values are
  ignored instead of producing `NaN`, and with no goal any day with words counts.
- 319 smoke checks (one new: `writing-history` records 140 words, opens the panel and asserts 14
  bars, the summary, the reached colour and the last bar's tooltip), 167 unit tests.

## 1.76.0

A daily writing goal.

- **Settings → "Daily word goal"** (0 = off) shows `Today 620 / 800 words` in the status bar, in the
  accent colour once reached, with one toast per day when you cross it.
- **Only positive word deltas count.** Deleting a paragraph does not take back words already written,
  so the number measures effort rather than the current file size; the ledger (`writing.json`) keeps
  30 days and remembers the last count per document so switching tabs cannot double-count.
- Recording rides the debounced stats pass (1.2 s), not every keystroke.
- 318 smoke checks (one new: `writing-goal` writes 60 words, deletes half and asserts the count does
  not shrink, then crosses a goal of 100 and asserts the status text and the reached state), 160 unit
  tests. The first version asserted `today === 120` after replacing the document; the real count is
  the sum of positive deltas (145), so the assertion now derives from the reported number.

## 1.75.0

The paragraph you are writing can be marked.

- **Settings → Appearance → "Highlight the current paragraph"** gives the block holding the caret a
  faint accent tint and a thin left rule, theme-aware and off by default.
- **Focus mode takes precedence**: the plugin returns no decoration while focus mode is on, so the
  soft tint cannot stack with the dimming and turn the text muddy.
- **The smoke check asserts exactly one highlighted block and that it follows the caret**, then turns
  focus mode on and asserts the soft highlight is gone — geometry of the behaviour, not a class name.
- A duplicated helper (from a partially applied patch) broke the bundle with "symbol has already been
  declared"; the region around `typewriterFollow` was rewritten by hand afterwards.
- 317 smoke checks, 160 unit tests.

## 1.74.0

Typewriter mode.

- **Settings → Appearance → "Keep the caret in the middle"**: while the editor has focus, the view
  scrolls so the line being typed stays near 45% of the window instead of sinking to the bottom.
- **It only reacts to caret movement**, in a `requestAnimationFrame`, so reading and manual scrolling
  are untouched; the boolean lives in settings and reaches other windows through the broadcast.
- **The test asserts geometry, not a class name**: `typewriter-scroll` focuses "Paragraph 100" in a
  120-section document and checks the caret's viewport position is between 30% and 62% of the pane,
  with `scrollTop > 0`; with the mode off it asserts the mode is inactive.

- 316 smoke checks, 160 unit tests.

## 1.73.0

The report remembers the last one.

- **Every saved structure report is summarised** (`reports.json`: issues, words, headings, time), and
  the next report shows the delta: the panel says "previous report: 2 issue(s)" and the exported
  checklist gains a line like `Previous report (2026-10-25): 2 issue(s), now 0 (−2)`.
- `doc:structure` returns that summary as `previous`, so the comparison is data, not text scraping.
- **A temporal-dead-zone bug fixed on the way**: the delta line was inserted before `issues` was
  computed, so the export threw "Cannot access 'i' before initialization" — the block now sits after
  the counting.
- 315 smoke checks (one new: `report-history` saves a report, fixes both issues through the real
  buttons and dialog, saves again, and asserts the delta line and the zero-issue checklist), 160 unit
  tests.

## 1.72.0

The structure report can leave the app.

- **"Save report…"** writes a markdown checklist next to the document: counts (headings, paragraphs,
  code blocks, tables, images, links, tasks), every issue as `- [ ]` with its line number, and the
  document's word count and reading time at the top.
- The markdown is built by a **pure function** over the `doc:structure` data; the save dialog and an
  explicit-path write are separate IPC calls (`report:save`, `report:write`), so the export is
  testable without driving a native dialog.
- After saving, a toast offers **Show in folder**.
- 314 smoke checks (one new: `structure-export` asserts the panel button exists, the generated
  markdown contains the checklist items, and the written file contains them too), 160 unit tests.

## 1.71.0

Long paragraphs can be split, not just pointed at.

- **A paragraph issue in the structure report has a "Split" button**: the paragraph is rebuilt as
  several paragraphs at sentence boundaries, grouped into chunks near 600 characters. Text and marks
  survive (`node.cut(offset, offset + length)` per chunk) and the whole split is one undo step.
- **Paragraphs containing inline images or atoms are refused with a message** rather than mangled —
  `content.size !== textContent.length` is the signal.
- The report now carries a snippet of the offending paragraph so the right node is found without
  mapping markdown line numbers to editor positions.
- 313 smoke checks (one new: `paragraph-split` builds a 1800-character paragraph, clicks the real
  Split button, asserts every resulting paragraph is under 1200 characters, the last sentence is
  still there and the text length did not shrink), 160 unit tests.

## 1.70.1

The startup check now measures the right thing.

- **`bootMs` is measured from when Electron is ready**, covering only this app's work (window,
  settings, renderer); `startupMs` keeps starting at OS process creation, which includes Electron's
  own boot and the virus scanner's first look at a freshly built binary. The packaged smoke failed
  at 5.4 s against a 5 s limit on a binary built seconds earlier, then passed at 4.9 s unchanged —
  that variance is the scanner, not the app.
- **The strict budget moved to `bootMs`** (3 s packaged, 6 s dev); `startupMs` keeps a loose 9 s /
  12 s ceiling so a gross regression still fails. Measured in dev: 291 ms boot, 314 ms total.
- `PERFORMANCE.md` records both numbers and why they differ.

## 1.70.0

The structure report can fix what it finds.

- **A heading jump gets a "Fix" button**: the heading is demoted to one level below its predecessor
  (H4 after H2 becomes H3) in a single transaction.
- **A duplicate heading gets "Rename…"**: the name dialog opens pre-filled with the current title and
  the heading text is replaced as a whole, so old marks cannot leak into the new one.
- The report refreshes after each action, so the list shrinks as you work through it.
- 312 smoke checks (one new: `structure-fix` clicks the real Fix button, asserts the markdown went
  from `####` to `###` and the report to zero jumps, then drives the rename dialog and asserts zero
  duplicates), 160 unit tests.
- Two mistakes in that test: the first version clicked a hard-coded line number instead of the
  reported one, and a `/## Notes\b/` assertion had reached the file as `/## Notes\\b/` (literal
  backslash) because of shell escaping — the same trap as earlier rounds, now avoided with
  `String.fromCharCode(92)`.

## 1.69.0

A structure report for long texts.

- **The palette has "Structure report…"**: heading jumps (H2 straight to H4), duplicate headings,
  and paragraphs over 1200 characters with their line numbers. **Go** jumps to the heading in
  question.
- **The summary is what a submission asks for**: words, headings, paragraphs, estimated reading
  time — alongside counts of code blocks, tables, images, links and tasks.
- The parser skips fenced code blocks, so a `#` inside a code sample is not mistaken for a heading.
- `doc:structure` returns the data and the panel renders it, which keeps the analysis testable
  without scraping the DOM.
- 311 smoke checks (one new: `structure-report` with a deliberate H2→H4 jump, a duplicated heading
  and a 1859-character paragraph), 160 unit tests.

## 1.68.0

A broken link can be repaired, not just deleted.

- **Local links get a "Fix…" button** in the link audit: it opens the current path in the name dialog,
  and the new one is written into **every** matching link — text and other marks survive. Renaming a
  folder now costs one dialog instead of the link.
- **`relinkHref`** replaces the mark in a single transaction (remove + add with the new `href`); after
  the fix the panel refreshes and, if links are still missing, says how many.
- 310 smoke checks (one new: `link-fix` opens the panel, clicks Fix…, asserts the dialog pre-filled
  the old path, types the new one, confirms, and asserts both the panel and the markdown), 160 unit
  tests.
- The README gained a garbled sentence from a multi-step text edit; rewritten by hand rather than by
  another patch.

## 1.67.0

A link audit, the twin of the image one.

- **The palette has "Link audit…"**: every link with its kind — **local** (resolved against the
  document folder, `.md` allowed), **external** (`http`/`mailto`, reported as "not checked") or
  **anchor** (`#…`) — and a red **missing** state when a local target no longer exists.
- **Unlink missing** keeps the text and drops only the dead link: a renamed folder costs the link,
  not the sentence. Each row can be unlinked on its own, and resolvable local links get an **Open**
  button that reuses the relative-link opener.
- `links:audit` excludes images with a negative lookbehind on `!`, so the two panels never disagree
  about what counts as a link.
- 309 smoke checks (one new: `link-audit` loads one link of each kind, asserts the rows, then
  asserts that after unlinking the missing one, the label is still in the markdown), 160 unit tests.

## 1.66.0

Remote images can come home.

- **The image audit downloads remote images**: each remote row has a **Download** button, and
  **Download remote** does them all. The file is saved to `images/` next to the document, named by a
  content hash, and every link to it is rewritten to the relative path — the document then works
  offline and in exports.
- **Failures leave the link untouched and say why**: HTTP status, oversized response (cap 20 MB),
  unsaved document, or a network error. The extension comes from `content-type`, then the URL, then
  `.png`.
- Downloads use Electron's `net.fetch` in the main process, where the renderer's CSP does not apply.
- **The test fetches from a real local HTTP server** (not a mock): it asserts one file in `images/`
  with a `.png` name, the rewritten `images/<hash>.png` link, and an audit that now reports zero
  remote images.
- One self-inflicted syntax error: a regex written through a shell-escaped patch ended up as
  `/^images\\/.../` and broke `node --check`; fixed by building the line with `String.fromCharCode(92)`.
- 308 smoke checks, 160 unit tests.

## 1.65.0

An image audit, before you ship the document.

- **The palette has "Image audit…"**: every image with its kind — **local**, **remote**, **embedded**
  (`data:` URI) — its size, and a red **missing** state when a local file no longer resolves against
  the document folder.
- **Remove missing** drops all broken images in one step; each row has its own remove button. Both
  delete by `src` in a single transaction, so one Ctrl+Z brings them back.
- `images:audit` reports `total`, `missing`, `remote`, `embedded` and per-entry `exists`/`size`, so the
  same numbers are testable without reading the DOM.
- 307 smoke checks (one new: `image-audit` loads a document with all four cases, opens the panel,
  asserts the rows and then removes only the missing one), 160 unit tests.

## 1.64.0

Drag an image to move it.

- **Images are draggable**: press and drag, a line marks where it will land, release drops it there.
  The move is **one undo step** and keeps the image's width and alignment.
- **The drop position is a document coordinate**, not a pixel offset: `posAtCoords` gives the target,
  and the node is deleted and reinserted in a single transaction (adjusting for the removed size).
- **`posAtDOM` on an atom node returned the wrong position**, so the first drag never started. The
  image is now located by matching `nodeDOM(pos) === img` while walking the document.
- The guide and README each grew a duplicate section during this round's doc edits; a dedupe pass
  keeps the heading-uniqueness test honest (it caught both).
- 306 smoke checks (one new: `image-drag` dispatches real `DragEvent`s with a `DataTransfer` and
  asserts the new order plus the undoable markdown), 160 unit tests.

## 1.63.0

Drag a row or column where you want it.

- **Grab the left edge of a cell to drag its row, the top edge to drag its column.** A highlight line
  shows where it will land, Escape cancels, and the drop index comes from the cell under the pointer
  (`posAtDOM` → row/column index), never from pixel arithmetic.
- **`moveTableRowTo` / `moveTableColumnTo`** do the reorder in one transaction; the existing
  up/down/left/right menu items remain for keyboard use.
- **The first version silently did nothing**: the code block inserting the drag implementation missed
  its anchor, so only the test hook existed and every call threw inside the page. The test reported a
  generic "Script failed to execute" until each call was wrapped and the failure became visible; the
  implementation is now inserted at a verified line.
- 305 smoke checks (one new: `table-drag` performs both drags with real mouse events — down, move,
  up — and asserts the resulting markdown), 160 unit tests.

## 1.62.0

Tables can be reordered, not just edited.

- **Right-click a cell → move row up/down, move column left/right.** Rows already moved before this
  round; columns did not exist.
- **Columns are rebuilt row by row in one transaction**, never by arithmetic on positions inside the
  table. **Merged cells refuse the move** with a message, because "the same column" is undefined
  through a colspan — a silent no-op would be worse.
- Menu labels are localised (`table.moveRowUp`, `table.moveColLeft`, …).
- The existing `table-cell-menu` check asserted the menu had exactly 10 items and failed when the
  two new buttons arrived — updated to 12, which is the point of asserting the count.
- 304 smoke checks (one new: `table-move`, a real row move followed by a real column move asserted
  against the resulting markdown), 160 unit tests.

## 1.61.0

Typing in a large document: 50 ms per keystroke → 4 ms.

- **Measured first**: a 415 KB file (900 sections) took **49.7 ms per keystroke**, with a bare
  insertion costing ~6 ms at the end of the document and ~1.5 ms for a no-op transaction — so the
  cost was layout, not the transaction.
- **`content-visibility: auto`** on the top-level blocks of documents above 200 KB (`is-large`
  class) lets the browser skip layout and paint for everything off screen. Worst-case insert dropped
  from 47 ms to 5 ms.
- **No leading-edge change sync for large documents**: serialising 400 KB of markdown on the first
  keystroke of a burst cost ~40 ms; those documents now debounce at 600 ms and skip the leading
  edge. Small documents keep the immediate sync that protects against a crash right after typing.
- **Result in the suite**: average **4.0 ms**, worst 5.1 ms per keystroke.
- **Guarded**: `large-doc-typing` opens the big file and inserts 18 characters through the real
  editor, asserting average < 25 ms and worst < 60 ms. The first version of the check asserted the
  editor's text length against the file's *byte* length and failed at 380k vs 400k.
- 303 smoke checks, 160 unit tests.

## 1.60.0

Large documents open in half the time — and the number is measured.

- **The markdown-to-ProseMirror path is quadratic**, proven by measurement rather than guessed:
  256 KB 353 ms, 512 KB 1.1 s, 1 MB 4.1 s, 2 MB 16.0 s. Parsing the same text to HTML takes 2.5 s,
  so the cost is the conversion, not the parser.
- **`setMarkdownProgressive`** splits files above 128 KB at paragraph boundaries and inserts one
  chunk per task: a 2 MB document now opens in **7.2 s** and the window keeps painting between
  chunks instead of freezing for sixteen seconds.
- **`npm run perf-open`** reproduces the measurement (read/IPC/render split, plus `--kb` and
  `--file`), appending to `docs/perf-open.csv`.
- **A chunking bug would silently lose blocks**, so `large-doc-open` opens an 800 KB file with 1200
  sections and asserts the last section is present and the outline has all 1201 headings.
- The first test was wrong three times before it was useful: too small a file, an assertion on a
  stale timing event (an empty tab reports after the real load), and a markdown read taken
  mid-load. It now waits for the timing entry whose `chars` matches the file and for the last
  section to appear.
- 302 smoke checks, 160 unit tests.

## 1.59.0

Performance now has a memory.

- **`npm run perf-trend`** runs the real perf report and appends one row per run to
  `docs/perf-history.csv`: ms per keystroke, outline, find, undo, heap, node count, PDF and HTML
  export times and sizes. `--show` prints history without measuring.
- **The table prints the delta against the previous run**, which is the number that drifts as
  features land. Two baseline runs (5.13 and 5.28 ms/key on this machine) put the noise floor at
  about 0.15 ms, so a change under ~0.3 ms is not a regression.
- Times are stored in **local time**; the first version wrote UTC and the date looked a day old.
- Five unit tests cover the report parser (with noisy stdout), CSV quoting, append/read round trip,
  delta formatting, and the empty-history message (`node --test` now 160).
- 301 smoke checks, 160 unit tests.

## 1.58.0

Tabs work without a mouse.

- **The strip is a real tablist**: `role="tablist"` with a localised label, `role="tab"` and
  `aria-selected` on each tab, and a roving `tabindex` so exactly one tab is in the Tab order.
- **Arrow keys move and activate** (Left/Right), Home/End jump to the ends, **Delete** closes the
  focused tab, and focus stays on the strip across switches.
- **Rendering the strip used to drop focus to the page**: every tab switch rebuilt the DOM and the
  keyboard model quietly stopped working after one press. `renderTabs` now remembers `focusedTabId`
  and restores it after the rebuild.
- The test caught two mistakes: the accessibility hook read `#tabs` instead of `#tab-list` (so the
  role looked missing), and the first Delete assertion failed for the same focus-loss reason the fix
  addresses.
- 301 smoke checks (one new: `a11y-tabs`, real arrow keys and a real close), 155 unit tests.

## 1.57.0

The document explains itself.

- **The editing area is a named textbox**: `role="textbox"`, `aria-multiline="true"`, and a
  localised name ("Document editor" / 文档编辑区) that follows the UI language.
- **The outline marks where the caret is**: `aria-current="location"` moves with the caret, and
  foldable headings keep `aria-expanded` in sync, so the structure is usable without seeing it.
- **300 smoke checks** — a round number worth noting: `a11y-document` moves the caret into a real
  heading, asserts exactly one current row, folds the section and asserts `aria-expanded="false"`.
- Two more patch attempts missed their anchor and were caught only because the *rendered* state was
  asserted (the hook alone would have passed). The test hook `focusHeading` exists because the first
  version used a markdown-string index as a ProseMirror position and landed in the wrong section.
- 155 unit tests.

## 1.56.0

The keyboard stays where it should.

- **Dialogs are dialogs**: every modal card gets `role="dialog"`, `aria-modal="true"` and
  `aria-labelledby` pointing at its title. **Tab is trapped inside the open dialog** (Shift+Tab too),
  and Escape closes it and returns the caret to the editor.
- **Toolbar toggles announce their state**: `aria-pressed` on bold, italic, strike, code, lists,
  quote, code block and link; every titled button now mirrors its tooltip into `aria-label`.
- **The smoke test presses Tab 18 times** with a real settings dialog open and asserts focus never
  leaves it, then presses Shift+Tab and Escape and asserts the caret is back in `.tiptap`.
- Two patching mistakes made this round longer than it should have been: a loose
  `/aria-pressed/` check matched a different line and skipped the real edit, and a second attempt
  duplicated the `const button` declaration. The lesson is in the changelog rather than the code:
  verify the *specific* statement, not the token.
- 299 smoke checks (two new: `a11y-modal-focus`, `a11y-toolbar`), 155 unit tests.

## 1.55.0

Look before you export.

- **The export panel now inspects the document**: words and headings, images, table rows, diagrams,
  formulas, task items — and a red warning when an image or local link points at a file that is not
  there. Fixing it in the editor beats discovering it in the PDF.
- `export:inspect` resolves relative image and link targets against the document folder, so the
  warning matches what the HTML export will actually flag.
- **The first version counted correctly but the panel showed nothing**: the call to
  `refreshExportInspect()` was appended with the wrong indentation and silently missed, and the test
  asserted the rendered text, not just the IPC numbers.
- The docs check caught three duplicate `## Export templates` sections accumulated by earlier scripted
  appends; the headings are deduplicated now.
- 297 smoke checks (one new: `export-inspect`), 155 unit tests.

## 1.54.0

Export templates, seen and checked.

- **All three templates are rendered to screenshots** (`npm run shot-export` now produces
  `10-export-page.png`, `11-export-toc.png`, `12-export-compact.png`) and the two new ones are in
  the user guide, so the typography can be reviewed without exporting anything.
- **The table of contents is localised**: `tocHtml` takes a `tocTitle`, and the HTML export passes
  the UI language, so a Chinese interface writes 目录 instead of Contents.
- **TOC links are verifiable**: the smoke test exports with the `toc` template and asserts four
  links, each resolving to a heading id, the depth order `1,2,3,2`, and the title.
- TOC links gained a hover/focus underline. `tocHtml` reuses `outline()`, which already deduplicates
  repeated headings (`notes`, `notes-1`), so anchors never collide.
- 296 smoke checks (one new: `toc-template`), 155 unit tests.

## 1.53.0

Windows follow each other.

- **A settings change now reaches every open window**: theme, language, accent, typography, hidden
  file tree and find options are applied immediately in each one. Before this, a second window kept
  its old theme and language until restart.
- **The change is broadcast to all windows, including the origin.** The first version skipped the
  sender, which meant a programmatic change (`window.api.setSettings`) left the very window that
  made it stale — the test caught the origin still light while the other window went dark.
- **Closing a window leaves the rest healthy**: the test closes the second window and keeps using
  the first, whose tab content is still there.
- Two scoping mistakes on the way: the helper was inserted outside `registerIpc` (ReferenceError at
  runtime), and the settings handler's parameter was `_e` so `event.sender.id` did not exist.
- 295 smoke checks (one new: `multi-window-settings`, a real second window, a real theme/language/
  accent change, then a close), 155 unit tests.

## 1.52.0

Recovery paths are verified, and one of them was wrong.

- **A draft whose original file was deleted used to restore into whatever tab was active**, quietly
  replacing the open document's text. It now opens a **new untitled tab** (`missingOriginal`) and
  leaves the current document alone; saving the tab asks for a path.
- **Backup round trip is asserted end to end**: save v2 over v1, restore the v1 backup from the
  popover, save — the disk holds v1 again and the v2 text has become the newest backup, so a restore
  is itself reversible.
- The round-trip test first used `setMarkdown` directly and failed: the editor showed the restored
  text but main still had v2, so saving wrote v2. The restore popover calls `setMarkdown` *and*
  `scheduleChange`; the test now goes through `applyMarkdown`, the same path.
- 294 smoke checks (two new: `draft-restore-missing-file`, `backup-restore-roundtrip`), 155 unit
  tests.

## 1.51.0

A broken backups folder no longer blocks saving.

- **The backup is optional, the text is not.** `storage.saveDocument` used to call `backupFile(...)`
  before the atomic write without a guard, so an unwritable `backups/` made every save fail with the
  user's changes still only in memory. A failing rotation now returns `backupError` and the write
  proceeds.
- **The app says backups are off**: a banner with the reason and a shortcut to the data folder,
  cleared by the next save that rotates successfully.
- **`listBackups` returns `[]` for a non-directory path.** Reporting a successful save used to throw
  `ENOTDIR` from the backup listing, turning a good save into a failed IPC call.
- **Ordering matters**: the backup warning is sent *after* the `saved` status; sending it first let
  the save handler hide the banner it had just raised (the test caught the banner missing).
- 292 smoke checks (one new: `backup-failure-degrades` — a real file replacing `backups/`, save must
  succeed and warn, restore and the warning clears), 155 unit tests.

## 1.50.0

Crash protection now admits when it is off.

- **A drafts folder that cannot be written raises a persistent banner**: "Recovery drafts are off:
  <reason>", with a shortcut to the data folder. Before this, the failure only flashed in the status
  bar for two seconds, so the user kept writing under the impression that a crash would be recoverable.
- **The banner clears itself** after the next successful draft write (`draftOk`), so a temporarily
  full disk does not leave a permanent scare.
- `writeDraftNow` handles its own storage errors and reports each state transition once
  (`draftBroken`), instead of two call sites catching and formatting the same message.
- 291 smoke checks (one new: `draft-failure-banner` turns the drafts directory into a file,
  asserts the banner, restores the directory and asserts it clears plus a draft lands), 155 unit
  tests.

## 1.49.0

The failure paths answer now.

- **A failed export no longer throws into the void.** The four export handlers run through
  `runExportSafely`, which logs and returns `{ exported: false, error }`; the panel shows a
  **Retry** banner with the message. `doc:exportToPath` exists for automation and for the test.
- **A corrupt `settings.json` is preserved, not overwritten.** `readSettings` copies the unreadable
  file to `settings.json.corrupt-<timestamp>`, logs it and continues with defaults. Before this,
  the next settings write would have replaced the broken file with an empty object and the old
  preferences were gone for good.
- **Found while patching:** the working tree is CRLF, so line-exact scripted edits silently missed
  (`function readSettings() {` never matched). Normalising `\r\n` first fixed four failed patches in
  a row; documented in DEVELOPING.
- 290 smoke checks (two new: `export-failure` writing through a path whose parent is a file,
  `settings-corrupt-recovery` asserting the backup and default fallback), 155 unit tests.

## 1.48.0

Exported links tell the truth about where they point.

- **HTML**: a relative link to a file that exists is left alone; a link to a missing file gets
  `data-link-missing` plus a "File not found" tooltip and a wavy underline, instead of looking
  identical to a working link. The export needs the document folder (`baseDir`) to resolve targets.
- **EPUB**: relative `.md` links are always marked "Not included in this EPUB" — the container
  never carries the target — while `#anchor` links keep matching heading ids inside the chapter.
- **Word**: absolute URLs are now real `<w:hyperlink>` elements. Relative `.md` paths keep the blue
  underline but are not clickable, because such a path means nothing inside a `.docx`.
- Before this round the Word export had **no hyperlinks at all** and broken HTML links were
  indistinguishable from working ones.
- 288 smoke checks (one new: `export-links` covering marked, kept, anchor and external links in
  all three formats), 155 unit tests.

## 1.47.0

Links between files finally do something.

- **`[text](other.md)` opens the target in a tab**, resolved against the current document, with `.md`
  guessed when the extension is missing. A missing target names the file in a toast; an unsaved
  document explains that relative links need a path first.
- **`[text](#heading)` scrolls inside the document**, matching heading text after slugifying it.
- **Real URLs are untouched**: a plain click only places the caret, Ctrl+click (or middle click)
  sends the URL to the system browser.
- Before this, a relative link was handed to `shell.openExternal`, which silently did nothing, and an
  anchor did nothing at all.
- 287 smoke checks (two new: `local-link-open`, `link-edge-cases` for a missing target and an
  anchor jump), 155 unit tests.

## 1.46.0

Recent files became a real panel.

- **File → Show all recent files…** (and a palette entry) lists documents newest first with folder
  and age; rows can be opened, removed, and the list cleared without touching the files.
- **Missing files stay visible with a red badge.** The old `recentFiles()` silently filtered them
  out of the menu, so a deleted document just vanished. The panel reads the raw list, marks the row
  missing, and `recent:open` returns `{opened:false, reason:'missing'}` instead of throwing.
- The test for the list had to clear entries through `recent:clear`; `setSettings({recent: []})` is
  (correctly) not a writable setting.
- 285 smoke checks (two new: `recent-panel`, `recent-missing`), 155 unit tests.

## 1.45.0

You can go back now.

- **Alt+Left / Alt+Right** walk the jump history per tab: outline clicks and find steps are jumps, a
  new jump truncates the forward stack, and the caret plus scroll position return where they were.
- **Positions are recorded before the selection moves.** The first version recorded after the jump,
  so Alt+Left popped the destination and appeared to do nothing; the find bar also moved the caret
  as soon as a query matched, which had to be captured the same way.
- **Outline clicks now focus `pos + 1`**, inside the heading. Focusing at the node boundary put the
  caret in the document node, which made "which section am I in" checks read the whole document.
- 283 smoke checks (two new: `nav-outline` with real Alt+arrows, `nav-truncate-and-find`),
  155 unit tests.

## 1.44.0

The outline became a map you can fold.

- **Sections fold**: any heading with children gets a twisty; folding hides its descendants until the
  next heading of the same or a shallower level. The key is `level:text`, so a fold survives a
  re-render.
- **The highlight follows scrolling**, not just the caret: the heading at the top of the viewport is
  marked with `posAtCoords` inside a `requestAnimationFrame`, so dragging the scrollbar updates the
  map without moving the insertion point.
- 281 smoke checks (two new: `outline-fold`, `outline-scroll` — which scrolls to section 20 and
  asserts the caret is still in section 0), 155 unit tests.

## 1.43.0

A block handle, and a bug it uncovered.

- **Hover a block and a handle appears in the gutter** with **Move up / Move down / Duplicate /
  Delete block**. Ctrl+Shift+↑/↓ keeps working from the keyboard.
- **The caret stays inside the block that moved**, at the same offset. Doing this revealed that the
  old `moveBlock` resolved its selection against a separately built document, which ProseMirror
  rejects ("Selection passed to setSelection must point at the current document"). The selection is
  now resolved against the transaction's own doc; the keyboard path had never been tested before.
- **The smoke budget grew with the suite**: app watchdog 330 s → 540 s, runner 360 s → 600 s,
  install check 420 s → 660 s. The suite now takes about nine minutes on this machine.
- 279 smoke checks (two new: `block-grip`, `block-move-keys` with real Ctrl+Shift+Down), 155 unit
  tests.

## 1.42.0

Quotes nest, and indentation has a keyboard path.

- **Tab inside a quote nests it, Shift+Tab lifts it**, and the `> >` survives the markdown round
  trip. **Ctrl+]** / **Ctrl+[** do the same for lists and quotes, so indentation does not depend on
  Tab being free.
- **Lists keep their own Tab behaviour**: the handler checks for a list item first and steps aside,
  which is why a list inside a quote still indents the list instead of wrapping another quote.
- **A selection of several paragraphs becomes one quote**, leaving a trailing empty paragraph to
  type in — asserted rather than treated as a defect.
- 277 smoke checks (two new: `quote-structure`, `quote-keys` with real Tab/Shift+Tab key events),
  155 unit tests.

## 1.41.0

Task lists, from the checkbox to the Word file.

- **Round trip proven**: `- [ ]` / `- [x]` parse into task items, clicking a box writes the new state
  back to the markdown, and the shape is asserted in the smoke suite.
- **Word export gained the state.** Task items used to arrive as plain bullets — the ☐/☑ marks were
  missing entirely. They are now prefixed on the item, since `docx` has no checkbox primitive here.
  HTML and EPUB already rendered real disabled checkboxes; all three are asserted now.
- 275 smoke checks (two new: `task-roundtrip`, `task-exports`), 155 unit tests.

## 1.40.0

Find and replace grew the options every other editor has.

- **Match case (Aa), whole word (ab) and regular expressions (.*)** in the find bar, with Alt+C /
  Alt+W / Alt+R and the choices remembered between sessions. An invalid pattern shows **!** instead
  of quietly reporting zero matches.
- **Regex replacement expands `$&` and `$1…$9`**, so `(\w+) (\w+)` → `$2 $1` swaps words.
- **Replace All is one undo step, isolated from the typing before it.** Without `closeHistory`,
  ProseMirror merged the replacement into the previous typing batch, and one undo removed both —
  the test proved it by capturing the first and second undo states.
- **Ctrl+H** opens the bar in the replace field.
- 273 smoke checks (three new: `find-options` for the counters with each toggle, `find-replace-groups`
  for capture expansion plus the single undo, `find-options-ui` for persistence), 155 unit tests.

## 1.39.0

Typing and pasting markdown, verified through the real input path.

- **Inline markdown input rules**: typing `**bold**`, `*italic*`, `~~strike~~` or `` `code` ``
  converts on the closing delimiter. Blocks (`# `, `- `, `1. `, `> `) already came from StarterKit.
- **Smart paste**: plain text that is unmistakably markdown (a fence, a table rule, a heading with a
  blank line, two or more list items) is parsed into blocks. Prose and a lone `#tag` stay literal,
  so a hash in text never becomes a heading by accident.
- **The italic rule needed a negative lookbehind** — without it, `**bold**` matched the italic
  pattern too and produced italics. The input test caught it by asserting the mark name, not just
  "some mark".
- **Typing is tested with real key events** (`sendInputEvent`), not synthetic DOM events, so the
  input-rule pipeline is exercised the way a keyboard exercises it.
- 270 smoke checks (two new: `input-rules`, `paste-markdown` with its guard cases), 155 unit tests.

## 1.38.0

One document, four formats, checked block by block.

- **EPUB chapters gained a visible title.** `splitChapters` removed the `#` heading and used it only
  for `<title>` and the table of contents, so a reader opened a chapter with no heading on the
  page. The chapter now starts with an `<h1 class="chapter-title">`.
- **A consistency matrix is asserted**: heading, bold text, table, image, maths, code and diagram
  survive HTML, PDF, Word and EPUB — in the same order. The PDF is checked structurally (header,
  embedded image XObject, fonts) because its text is compressed.
- **`npm run export-probe`** does the HTML/Word/EPUB half in plain Node for quick checks; the smoke
  test `export-consistency` runs all four inside the app with a real Mermaid diagram.
- Two of my own assertions were wrong before the product was: I expected the table before the
  paragraph (it is after) and searched for `const answer = 42;` in highlighted code, where the text
  is split across spans.

## 1.37.0

Old documents can shed their embedded images.

- **File → Extract embedded images…** (also in the command palette) finds `data:image/...` URLs in
  the document, writes each one into `assets/<sha1>.<ext>`, rewrites the references and saves
  through the normal atomic path, which keeps a backup of the previous version.
- **It refuses while the document is dirty.** Extraction rewrites the file, so unsaved text always
  wins; the command reports "save first" instead of touching anything.
- **This is a command, not a save-time behaviour.** Rewriting someone's document behind their back
  is exactly the kind of silent change this project avoids.
- 267 smoke checks (two new: `extract-images` — two data URLs become two files, the markdown more
  than halves, a backup exists — and `extract-images-dirty-guard`), 155 unit tests.

## 1.36.0

Images stop bloating documents.

- **Every inserted image is optimised before it is written**: the long edge is capped at 2200 px and
  the file is re-encoded as whichever of JPEG (0.85) or PNG is smaller. JPEG wins on photos, PNG
  wins on screenshots of text; a fixed format would have inflated one of the two. Images already
  under 1.2 MB and 2200 px are left untouched.
- A real measurement from the test suite: an 8.86 MB photo becomes **111 KB** (2200×1444 JPEG). The
  toast reports the saving.
- **Two false starts worth recording:** the first version always converted to JPEG, which made a
  154 KB screenshot of text *larger* (324 KB); the second assumed the original was always smaller
  after resizing, which was false for flat images. The current version encodes both candidates,
  compares them with the original and keeps the original when neither wins.
- 265 smoke checks (two new: `image-optimize` for the conversion numbers, `image-drop-compressed`
  for a real drop event that writes the smaller file into `assets/`), 155 unit tests.

## 1.35.0

Long-document performance, measured and improved.

- **A 14 000-word document (74 KB, 71 521 nodes)**: open 194 ms, outline 6 ms, find < 1 ms, typing
  4.8 ms per keystroke, PDF export 484 ms, HTML 11 ms, renderer heap ~40 MB.
- **Typing was 9.3 ms per keystroke** because every transaction rescanned the whole document twice:
  once for the word/character count, once to rebuild the outline. The status-bar counts are now
  debounced at 250 ms (the caret line/column stays immediate) and the outline rebuild at 120 ms —
  the keystroke cost halved.
- **`npm run perf`** runs the real editor through `--perf-report` and writes a JSON report plus the
  exported PDF/HTML to `%TEMP%`. `perf-long-doc` in the smoke suite asserts the thresholds,
  including **under 16 ms per keystroke**.
- **Honest limits documented** in [docs/PERFORMANCE.md](docs/PERFORMANCE.md): paint and compositing
  are not measured (the test window is hidden and Chromium throttles rendering there), and huge
  embedded images are limited by memory rather than this pipeline.

## 1.34.0

An Advanced section for the things that previously meant editing files by hand.

- **Settings → Advanced**: export preferences to JSON (the AI key never leaves safeStorage), import
  them back, open the data folder, clear recovery drafts with a count in the confirmation, and reset
  every preference to its default. Documents, backups and drafts stay on disk; the reset says so.
- Export and import reuse the existing dialog paths; the smoke suite passes an explicit path
  through the existing `settingsExportTo` / `settingsImportFrom` hooks instead of answering dialogs.
- 262 smoke checks (four new: `settings-transfer-export`, `settings-transfer-import`,
  `settings-reset-all` — which also proves a reset does not delete a draft — and `advanced-ui`),
  155 unit tests.

## 1.33.0

Two windows can no longer destroy each other's work silently.

- **Saving over a file that changed on disk asks first.** Before writing, the session compares the
  file with the bytes it last read or wrote. If another window, another editor or a sync client
  replaced it, the explicit save returns a conflict and shows **This file changed on disk** with
  **Overwrite**; closing the dialog keeps your text in the editor, still unsaved. Autosave raises
  the banner and stays dirty instead of overwriting.
- **Opening a file that is already open elsewhere focuses that window** rather than opening a
  second copy that will fight over the file.
- **Two bugs found by the regression run:**
  - The first guard compared against `savedContents`, but the editor normalizes markdown on load,
    so the baseline never matched the file and *every* save reported a conflict. It now compares
    against `diskRaw`, set at load and after each write.
  - "Read-only" was tracked per window, so one unwritable file stopped autosave for every other
    document until a save succeeded. It is now tracked per file.
- 258 smoke checks (three new: `save-conflict`, `save-conflict-dialog`, `open-existing-tab`),
  155 unit tests.

## 1.32.0

A first-run guide that does the thing instead of describing it.

- The blank-tab card became a **four-step checklist**: Start writing, Open a folder, Insert a
  block, Export. Each row is a working action — "Insert a block" types `/` and opens the slash menu
  right there. **Skip the guide** hides it for good; **Help → Welcome guide** brings it back, and
  it opens a fresh tab so there is somewhere for the card to appear.
- **The card no longer covers an empty file you opened on purpose.** It is tied to untitled
  buffers, not to "editor is empty".
- **Why the first build looked broken:** `#empty-new` still had the old primary-button styling
  (`background: accent`), and an id selector beat the new class rule, so step 1 rendered as a big
  blue button while the others were plain rows. Removed the rule.
- Two smoke checks now cover it: `empty-guide` (four steps, two secondary actions, hidden once you
  type, hidden for an empty saved file) and `welcome-guide` (the slash menu really opens, skip
  persists the setting, reopening works).

## 1.31.0

Crash safety down to the first keystroke.

- **The first change of a burst is written to the draft immediately** (leading edge), instead of
  waiting for a debounce; later changes are still coalesced. Blur, hidden tab, quit and
  `powerMonitor` suspend flush the buffer, so Alt-F4 and sleep no longer wait for a timer.
- **A change that belongs to a background tab is written into that tab.** With the immediate send,
  a switch could otherwise land the old document's text in the newly active one — or, if dropped,
  lose real typing. Neither happens now.
- **New crash scenario in `npm run crash`**: type, then SIGKILL 120 ms later with no explicit draft
  write. The edit is recovered on the next start (`CRASH_FAST {"kept":true}`).
- **Three smoke checks were silently order-dependent** and were rebuilt around their own documents:
  the draft-clear check, the Word export content check, and the tab-switch check (which restored
  "the first tab" in the list rather than the tab that was active).
- 255 smoke checks (one new `draft-flush`), 155 unit tests.

## 1.30.0

The update path is verified past the check.

- **`update-download` smoke check**: against a local feed, the app checks, downloads and validates
  the payload's sha512 from `latest.yml`, then stops — installing is left to `quitAndInstall`, which
  requires a trusted signature. Download verification is now proven, not assumed.
- **`npm run feed`**: serves `release/` as a generic feed on `http://127.0.0.1:8199`. With
  `--bump` the manifest version is raised by one patch while the file name and hash stay valid, so
  an installed build can be pointed at it (Settings → Updates) to see the real update dialog.
- `src/updater.js` gained `downloadUpdate()`: resolves on `update-downloaded`, fails on error or a
  120 s timeout, and never installs.
- Two unit tests for the feed server: version bumping, serving `latest.yml`, a space in an asset
  name, a 404 and a traversal attempt.

## 1.29.0

A support path that does not require reading a log by hand.

- **Help → Copy diagnostics** and **Settings → Diagnostics** put the version, Electron/Chromium
  versions, OS, data/backup/draft paths, a settings summary and the last 60 log lines on the
  clipboard. **Open log folder** shows `logs/mdpad.log`.
- Nothing is uploaded. There is no telemetry; diagnostics only fill the clipboard so a report can
  include them.
- **A small API trap worth recording:** `clipboard.readText()` returns a promise in this Electron
  version. The first version read it synchronously and compared a pending `Promise` against a
  string; the new check caught it.
- 253 smoke checks (one new `diagnostics`: report fields, clipboard contents, log path and the Help
  menu entry), 153 unit tests.

## 1.28.0

The build pipeline can sign, and it proves it did.

- **`npm run ship` signs** the app exe, portable exe, installer and uninstaller when
  `CSC_LINK` / `CSC_KEY_PASSWORD` are present, then runs `scripts/verify-sign.js --require` and
  stops the release if any artifact is unsigned. Without a certificate it says so instead of
  pretending.
- **`npm run cert`** creates a self-signed development certificate (PFX + thumbprint in
  `build/certs/`, git-ignored) so the signing path can be exercised without buying a certificate.
  `node scripts/make-dev-cert.js --remove` cleans it out of the user store.
- **`npm run sign-check`** reports each executable as `signed, trusted`, `signed, untrusted` or
  `UNSIGNED`. A self-signed signature is genuine but not trusted — Windows reports `UnknownError`
  and SmartScreen still warns — so `--require` (any signature) and `--require-trusted` (a CA the
  machine trusts) are separate gates.
- **`node scripts/publish.js`** now owns the GitHub release step: commit, push, tag, create the
  release and upload the five assets, idempotently, with credentials from `~/.git-credentials`.
- [docs/RELEASING.md](docs/RELEASING.md) rewritten around the two remaining human steps: a trusted
  certificate and an HTTPS feed.

## 1.27.0

Follow the system theme, and Esc closes every dialog.

- **Follow system** joins light / dark / sepia. It resolves from `nativeTheme` and switches live
  when Windows does; the CSS only ever sees `light` or `dark`, because a `data-theme="system"`
  would have matched no palette at all.
- **Esc closes whatever dialog is on top** (settings, export, drafts, statistics, shortcuts, the
  name and confirm prompts) and hands the keyboard back to the editor. Before this, only the AI
  panel, find bar and preview window responded to Esc.
- **Two real defects surfaced while testing this:**
  - `nativeTheme` was used without being imported. That throws while registering IPC, and Electron
    answers with a blocking error dialog, so the app appeared to hang at startup with no output.
  - `applyTheme('system')` wrote `dataset.theme = 'system'`, a value no palette defines.
- 252 smoke checks (two new: `system-theme` through the real settings dialog plus a simulated OS
  flip, and `escape-closes-dialogs` over four dialogs with focus returning to the editor),
  153 unit tests.

## 1.26.0

An end-to-end export check, with a picture.

- **A rich document is exported and inspected**: table with a styled header, bold and inline code,
  an image carrying `w=50%`, inline and display math, a highlighted code block and a Mermaid
  diagram as inline SVG. The check reads the written HTML and the PDF size rather than trusting the
  UI.
- **`npm run shot-export`** renders an exported page in a window and captures it to
  `docs/images/10-export-page.png`, so the export typography can be reviewed without opening a PDF.
  The image is now part of the user guide.
- Everything passed on the first run; the value here is the guard, not a fix.
- 250 smoke checks (one new `export-fidelity`), 153 unit tests.

## 1.25.0

A `/` block menu, the way people expect to insert things now.

- **Type `/` at the start of an empty paragraph** for headings, lists, quote, code block, table,
  image, math block, divider and a Mermaid diagram. Keep typing to filter ("/tab" narrows to
  Table), arrows or the mouse to choose, Enter to insert.
- **The trigger reads the document, not keystrokes.** The slash and the filter stay as ordinary
  text until an action is chosen; Esc closes the menu and leaves the text alone, so the menu can
  never swallow a character. Choosing a block deletes the typed `/filter` in the same transaction
  that inserts the block.
- 249 smoke checks (one new `slash-menu`: the menu opens on a programmatic `/`, filtering shrinks
  the list, choosing Table removes the slash and inserts a table, Esc closes it), 153 unit tests.

## 1.24.0

Tabs grew the controls people reach for once they have more than three open.

- **Right-click a tab**: Close, Close others, Close to the right, Copy path, Show in folder. The
  path actions hide themselves for unsaved tabs.
- **Ctrl+Tab / Ctrl+Shift+Tab** cycle through tabs, wrapping at the ends.
- **Why the menu looked broken at first:** the `contextmenu` listener was inserted after a
  `tabList.appendChild(el)` that did not match the real indentation, so it silently never attached.
  The menu markup existed and the buttons worked in isolation, which is exactly why the test drives
  a real right-click on a real tab instead of calling the handler.
- 248 smoke checks (one new `tab-menu-and-cycle`: the menu opens on the tab, Close others leaves
  exactly that tab, and cycling changes the active file), 153 unit tests.

## 1.23.0

The minimum window width is usable now.

- **At 740 px** the two sidebars took 440 px and left ~280 px for text. Below 920 px they shrink
  (168 / 132 px), the HTML and PDF shortcuts leave the top bar (still reachable from the menu,
  palette and export panel), the backup count hides and the editor gets back its padding.
- **The toolbar fades at its right edge** to show it scrolls, instead of looking clipped. The fade
  disappears on hover.
- A smoke check measures the result at 740 px: both sidebars narrower, text column at least 280 px,
  and no horizontal overflow in the top bar, tab strip or footer.
- 247 smoke checks (one new `narrow-audit`), 153 unit tests.

## 1.22.0

A long-document pass.

- **Tabs remember their scroll position.** Tab switching cached the ProseMirror state, which
  restores the selection but not the scroll offset, so returning to a long file dropped you at the
  top. `tabScroll` now stores the pane offset per tab, restored after layout and clamped if the
  document got shorter.
- **A mixed-document guard**: 80 paragraphs, a 41-row table, display math and a Mermaid diagram must
  load in under 3 s, render the table and maths, and keep the outline under 400 ms. The first
  version of this probe reported zero table rows because the generated markdown put blank lines
  between table rows and between the `$$` fences — the probe was wrong, not the editor.
- 246 smoke checks (two new: `tab-scroll-memory`, `long-mixed-doc`), 153 unit tests.

## 1.21.0

Two things every writing app has and this one did not: visible zoom and a working spellchecker.

- **Zoom** with Ctrl+= / Ctrl+- / Ctrl+0, a percentage chip in the status bar while zoomed (click to
  reset), and the level remembered across restarts. The View menu's roles were there, but nothing
  told you the page *was* zoomed, which reads as a font bug.
- **Spelling**: a native context menu on a misspelled word with up to six suggestions, **Add to
  dictionary** and **Ignore**; without that handler Electron shows nothing on right click. A
  **Check spelling** toggle in Settings turns it off, applied to every open window (the checker
  lives on the session, so writing the setting alone was not enough — the first version kept
  checking after being switched off).
- 244 smoke checks (two new: `zoom-controls` for in/in/reset and the indicator, `spellcheck-setting`
  for the stored value and the live session state), 153 unit tests.

## 1.20.0

The recovery surfaces stop looking like debug output.

- **The status bar no longer prints the backups path.** It shows the count and time; the path is a
  tooltip, and the popover has a **folder** button for when you actually want it.
- **Backup rows** show how long ago each copy was taken and its size, right-aligned with tabular
  figures, with the exact timestamp on hover. A footer line says a copy is kept before every save.
- **Drafts rows** are `div[role=button]` with their own delete button. A `<button>` inside a
  `<button>` is invalid HTML and swallowed the inner click, so the old rows could not be restored
  reliably by keyboard. Rows now show age and size, respond to Enter/Space, and the panel has a
  count and a one-line explanation.
- **`relativeAge()` accepts epoch milliseconds** as well as ISO strings; backup entries pass
  numbers, which used to render as an empty label.
- 242 smoke checks (two new: `backup-panel` for the row parts, count and the missing path;
  `drafts-panel-layout` for the row role, the zero nested buttons and the hint), 153 unit tests.

## 1.19.0

The file tree can finally make files.

- **Right-click in the tree**: on a folder (or empty space, which means the opened folder) for
  **New file** and **New folder**, on any row for **Rename**, **Show in folder** and **Delete**.
  Name prompts are in-app (Electron has no `prompt()`), with Enter to confirm and Esc to cancel.
- **Deletes ask first**, and a folder with contents asks a second time before removing everything
  inside.
- **Containment is enforced in the main process**, not just in the dialog: separators, `..`, empty
  names, existing targets and anything outside the opened folder are refused. Deleting closes the
  tabs that pointed at the file; renaming retargets them.
- 240 smoke checks (two new: `tree-file-operations` for create → rename → delete through the real
  menu and prompts, `tree-file-guards` for traversal, empty and duplicate names), 153 unit tests.

## 1.18.0

"Rewrite this paragraph" now shows what "this" means.

- **The selected text is highlighted in the editor** while the AI panel is open, and quoted in a
  small block above the instruction field. Closing the panel clears both.
- **Why the highlight needed a transaction:** it is a ProseMirror decoration, and decorations are
  only recomputed on transactions. Setting the variable alone left it invisible until something
  else moved the caret; the panel now dispatches a meta-only transaction when it opens or clears.
- **Every AI edit offers Undo.** Insert, new paragraph and replace all end with a toast carrying an
  **Undo** action. Because the AI edit opens its own history group, one undo removes exactly the
  AI's change and none of your typing.
- 238 smoke checks (one new `ai-target-and-undo`: the quoted preview, the decoration, and using the
  toast's Undo to get the original text back), 153 unit tests.

## 1.17.0

Images resize by dragging, the way Typora does it.

- **A corner handle appears when you hover a picture.** Drag it and the image follows the pointer,
  snapped to 5% steps; on release the size is written as the same `w=NN%` metadata the toolbar
  presets use, so the two paths agree and the markdown round-trip keeps working.
- **Nothing new in the document format.** It reuses the existing `title="w=50%"` attribute, so
  files opened in older versions still resize correctly.
- **Escape, scrolling or clicking elsewhere dismisses the handle.** Dragging is confined to the
  image's own column, clamped at 10–100%.
- 237 smoke checks (one new `image-drag-resize`: the handle appears, the width changes while
  dragging, the stored title carries a width below 100%, and the handle hides), 153 unit tests.

## 1.16.0

The secondary surfaces caught up with the rest of the chrome.

- **The find bar is grouped.** The search field carries a magnifier and the match counter inside it
  (so the count sits where you look), the replace field and its two buttons form a second group,
  and previous / next / close are icon buttons on the right. "No results" turns red instead of
  reading like an ordinary count.
- **The shortcut sheet is grouped** by area (Files and tabs, Editing, Writing, View, Export) with
  small-caps headings, instead of one flat list of thirteen rows.
- **Statistics align their numbers** to the right with tabular figures, so "1" and "12,480" line up.
- A new screenshot (`08-find.png`) documents the find bar.
- 236 smoke checks (two new: `findbar-layout` for the grouping, counter and icon navigation, and
  `shortcuts-grouped` for the sections), 153 unit tests.

## 1.15.0

Two loose ends from 1.14.0, and a table grip.

- **Splits can be undone.** `View → Merge the split windows` (Ctrl+Alt+1) closes the twin and
  restores the bounds the first window had before the split. The pair is remembered per window; if
  you close the twin by hand, merging still puts the first window back.
- **A Notion-style row grip.** Hovering a table row shows a grip at its left edge; drag it to move
  that row anywhere in the table, with the target row highlighted. Reordering rebuilds the table
  (same approach as the row move in 1.13.0).
- **Why the merge first said "not split":** only the menu path recorded the pair, not the IPC path
  that the palette and the tests use. Both paths record it now.
- 234 smoke checks (two new: `unsplit-windows` closing the twin and restoring the size, and
  `table-row-drag` moving the second row to the end), 153 unit tests.

## 1.14.0

Two windows, side by side.

- **View → Split into two windows** (Ctrl+Alt+2, palette entry) tiles the current window and a new
  one on the two halves of the display, both editing the same saved file. This uses the existing
  multi-window machinery rather than a second editor instance in one window, so tabs, autosave,
  drafts and crash recovery keep working unchanged.
- **Unsaved documents refuse and explain**, instead of opening a second empty window.
- Each window keeps its own scroll position, tabs and state; closing one leaves the other running.
- **A test-harness defect found while testing this:** `step(name, ok, extra)` spreads `extra` over
  the result, so passing an `ok` key among the diagnostics replaced the assertion's own verdict.
  `split-unsaved` was "failing" with a correct reason because of it. Details are now diagnostics
  only.
- 232 smoke checks (two new: `split-unsaved`, `split-windows` with both halves tiled and the twin
  opening the same document), 153 unit tests.

## 1.13.0

Tables stop being the most primitive part of the editor.

- **Resizable columns.** `Table` now runs with `resizable: true`, so the plugin adds a column
  `<colgroup>` and drag handles; widths are a view setting, because markdown has no syntax for
  them, and the README says so.
- **A right-click menu on any cell**: add a row above/below, add a column left/right, **move the
  row up or down**, toggle the header row, delete the row, the column or the table. Ten actions,
  grouped, with the destructive ones in red.
- **Row move rebuilds the table** with two rows swapped instead of doing position arithmetic inside
  it. The first version looked right and did nothing: it ended with
  `resolvedPos.constructor.near(...)`, and `ResolvedPos` has no `.near`, so the transaction threw
  after it had been built. The menu now dispatches the replacement and lets the editor coerce the
  caret.
- 230 smoke checks (two new: `table-cell-menu` for the menu, the row order after a move and the
  header toggle; `table-resize` for the wrapper, colgroup and a width written to the `<col>`),
  153 unit tests.

## 1.12.0

The export panel now shows the real page.

- **A rendered thumbnail instead of a sketch.** `export:thumbnail` builds exactly the HTML the
  export would produce, loads it in one reusable hidden window (420×560, JavaScript disabled) and
  returns a `capturePage()` PNG. The abstract line drawing stays as an instant placeholder and is
  replaced when the render arrives.
- **It follows the controls.** Changing the template, font or margins re-renders it after a 260 ms
  debounce, guarded by a token so a slow older render cannot overwrite a newer one.
- **Cheap enough to leave on.** One window is reused for the lifetime of the app, the temporary
  HTML lives in the user data directory, and nothing is created per keystroke.
- 228 smoke checks (one new `export-thumbnail`: a PNG data URL with real dimensions, and a
  different image after switching the font), 153 unit tests.

## 1.11.0

The AI panel now reads in the order you use it.

- **Top to bottom: target → instruction → suggestions → result → actions.** Before this the six
  presets came *above* the instruction field, the scope select sat below Run, and six buttons
  shared one flat row. Nothing was missing; the order was working against the user.
- **A target chip in the title row** says what the instruction will act on ("Whole document",
  "Current paragraph", "Selection only", or "Selection (none)"), and follows both the scope select
  and the caret.
- **The context note moved next to the scope**, where it explains the size of what will be sent
  instead of floating on its own line.
- **One primary action.** Insert is the only filled button; new paragraph, replace, copy and
  preview are secondary beside it, and **Clear context** is separated on the right because it
  resets the conversation rather than acting on the text.
- Usage and AI settings moved to the title row, out of the typing line.
- 227 smoke checks (one new `ai-panel-layout`: vertical order, chip text before/after a scope
  change, Run visible, Insert primary, no horizontal overflow), 153 unit tests.

## 1.10.0

The sidebars start carrying information.

- **File rows show age.** Each file gets a right-aligned relative timestamp ("now", "3h", "2d", or
  a date), with the exact time in the tooltip. The directory listing now returns `mtime` and size.
- **The empty tree is an action**, not a sentence: "No folder open" plus an **Open a folder**
  button, instead of a line of grey text.
- **The outline follows the caret.** The heading whose section contains the cursor is marked with
  an accent rule and its label is highlighted; the header counts the headings. I found, while
  wiring this, that the editor had **two identical `selectionUpdate` listeners** registered from an
  earlier edit — the marker was being attached to a copy that no longer fired.
- **Closing a folder works.** `setTreeRoot(null)` threw on `path.basename(null)`; the tree now
  clears properly, which is what the empty state needed.
- **The smoke harness stops lying about timeouts.** With 226 checks the run passed 240 s, so the
  in-app watchdog killed the app after every step had already succeeded and the runner reported
  "no SMOKE_RESULT" with no failing check. Both watchdogs are now 330 s / 360 s, and the result is
  flushed before exit (`process.exit` truncated piped stdout on Windows).
- 226 smoke checks (two new `sidebar-information`, `tree-empty-action`), 153 unit tests.

## 1.9.0

One export panel.

- **Every export entry point now opens the same panel** (top-bar HTML/PDF buttons, palette, File
  menu): format (HTML / PDF / Word / EPUB), template, document font, page margins and file name in
  one place, with a page sketch and a live summary of what will be produced.
- **The choices are real.** `exportFont` writes a font-family override into the exported document;
  `exportMargin` sets the body padding and, for PDF, the `printToPDF` margins in inches. Both are
  validated in the main process, not just in the UI.
- **Honest controls.** Word switches the font and margin pickers off (it writes its own styles and
  keeps diagram code), EPUB switches off margins (it reflows); the summary says why instead of
  silently ignoring a setting.
- **The top-bar HTML/PDF buttons no longer export immediately** — they open the panel with that
  format selected, which is what people expected when the file dialog appeared without warning.
- 224 smoke checks (one new `export-panel`: the format switch, the summary, the persisted settings
  and the exported HTML containing the chosen font and `data-margin`), 152 unit tests.

## 1.8.1

One icon language.

- **Every chrome button now uses the same 16 px stroke icons** as the toolbar: the settings gear,
  the outline toggle, the folder and collapse arrows, the find controls, the AI panel's retry /
  stop / usage / settings, the table alignment buttons and the empty-state close. Before this the
  top bar mixed an emoji folder, a Unicode gear and text arrows, which rendered differently in
  every theme and looked like three applications stitched together.
- **Icons survive translation.** `applyI18n()` writes `textContent`, which erased the SVG inside
  buttons that also carry `data-i18n`; it now re-applies the icon set.
- **Scrollbars** are thin, theme-aware and only assert themselves on hover.
- 223 smoke checks (one new `icon-consistency`: every `[data-icon]` control has an SVG, an
  accessible label, and the collapse toggle swaps chevrons), 152 unit tests.

## 1.8.0

A visual pass over the whole chrome.

- **One scale instead of ad-hoc values.** Control heights (26 px controls, 38 px toolbar, 44 px
  top bar), three radii (5 / 8 / 12) and a single easing/duration pair now drive the chrome.
- **Toolbar.** 26 px buttons, grouped separators, hover wash, and a proper active state: an opaque
  accent tint with the label kept at `--text` weight, so Bold in dark mode stays readable.
- **Tabs** get an accent indicator on the active tab, consistent heights and a quieter new-tab
  button.
- **Sidebars.** Small-caps headers with letter-spacing, 26 px rows with hover and active states, a
  left accent rule on the active file, and indentation guides in the outline.
- **Empty state** is a composed card with a clear hierarchy (title, one-line promise, three
  actions, shortcut hint) instead of a floating line of text.
- **Editor typography.** Tighter heading tracking, accent-tinted blockquote rule, tinted table
  headers, softer rules, themed selection.
- **Accessibility and motion.** Visible `:focus-visible` rings everywhere, and transitions are
  disabled under `prefers-reduced-motion`.
- **Two real defects found while measuring:** an active toolbar button used accent text on an
  accent wash (1.07:1 in dark mode, invisible), and an empty status item left a dangling separator
  dot in the top bar. Both are fixed.
- **Theme swaps no longer flash.** A `theme-swap` class disables transitions for two frames; the
  contrast audit had been sampling mid-interpolation.
- 222 smoke checks (one new `chrome-polish`), 152 unit tests.

## 1.7.0

Diagrams now reach the exported file.

- **HTML, PDF and EPUB embed the diagram as SVG.** The main process has no Mermaid runtime and no
  DOM, so the renderer renders each distinct fence once (with the light theme, because exports are
  light documents) and hands a `{source: svg}` map to main before the export starts. `renderHtml`
  swaps a matching fence for `<figure class="mermaid-figure">svg</figure>`.
- **Every entry point covered.** Menus, palette, toolbar and the Settings preview all go through
  one `runExport(kind)` that publishes the map first; the export preview window shows the diagrams
  too.
- **A missing or failed render falls back to the fenced code block** rather than an empty figure,
  so a broken diagram never produces a blank hole in the document.
- **Word still keeps the source.** The .docx writer needs a raster image, and turning SVG into PNG
  is a separate piece of work — stated in the README and the guide instead of being left implicit.
- 221 smoke checks (two new: a diagram document exported to HTML/PDF/EPUB with the SVG present and
  no `language-mermaid`; a plain document exporting with no diagram markers), 152 unit tests (four
  new for the substitution rules).

## 1.6.0

Mermaid, redone the way Typora does it.

- **The diagram replaces its source.** It used to be drawn *under* a permanently visible code
  block, which made the feature feel like a preview gadget. Now the block *is* the drawing.
- **Click to edit, Esc to preview.** Clicking a drawing brings the source back; Esc or a click
  elsewhere returns to the drawing. Each diagram keeps its own state, so editing one does not
  disturb the others.
- **A failed diagram keeps its source.** Showing an error where the code should be would hide the
  very thing the user needs to fix; the source stays and the parser message appears underneath.
- **Theme changes redraw.** The render cache is keyed by theme, and switching theme now
  re-initialises the renderer and repaints every diagram instead of leaving light-mode colours on
  a dark page.
- **Why diagrams sometimes never appeared:** when a render finished, the node view only re-painted
  the SVG but never re-applied its mode, so a freshly loaded document could keep showing the
  source. The repaint now goes through the node view's own refresh, and hiding the source is
  declared in `ignoreMutation` so ProseMirror stops rebuilding the view (which silently reset edit
  mode).
- 219 smoke checks (two new), 148 unit tests.

## 1.5.1

Finding the font controls.

- **Settings opened at the AI endpoint, not the top.** `openSettings()` focused the endpoint field,
  which scrolled the new scrolling body down to AI writing — so the Appearance section at the top
  was never on screen. Opening Settings now scrolls to the top by default, and callers can ask for
  a section (`openSettings('ai')` still lands on the endpoint).
- **An Aa button in the toolbar** and a palette entry ("Change font and page width") open Settings
  directly at Appearance, so the controls are reachable without knowing where they live.
- Font labels in the dropdown now match the option names (the dictionary still said "Serif (book)"
  while the option said "Georgia (book)").
- 217 smoke checks (one new), 148 unit tests.

## 1.5.0

The AI settings panel, rebuilt — and the client actually tested against a server.

- **The panel scrolls.** The card used to grow past the bottom of the window with no scroll, so
  everything after Export was unreachable. It is now a fixed-height card with a scrolling body,
  a sticky footer and four chips (Appearance / Export / AI writing / Usage) that jump to a section.
- **The API key field moved under the endpoint.** It was sitting after the Usage log, at the very
  bottom, which is why it looked like there was no field at all. `Clear` removes a stored key on
  the next save, and the note under it says whether a key is stored and how securely.
- **Endpoints are normalised.** `https://api.deepseek.com` used to produce
  `…/chat/completions` (404); a bare host is now retried once against `/v1`, a full
  `/chat/completions` URL is used as-is, and an empty endpoint is refused with a clear message
  instead of a relative-URL error.
- **The style guidance was ignored on the non-streaming path** — `complete()` never passed
  `systemPrompt`. Fixed.
- **Proven against a real socket:** the smoke suite starts a local OpenAI-compatible mock server
  and asserts the versioned endpoint, the bare-host fallback (404 then /v1), the Bearer header,
  the model name in the body, the model list, a stored-key round trip and the Clear button.
- A garbled string in the API-key note (a broken em dash) is gone.
- 216 smoke checks (two new), 148 unit tests (six new for endpoint normalisation).

## 1.4.0

Typography presets, Notion-style table Tab, and an undo bug I only found by testing it.

- **Five typography presets** — Book (serif, warm accent), Report (Cambria, blue), Minimal (sans,
  wide), Technical (Arial, teal) and Chinese (微软雅黑). Each sets font, text width and accent in
  one choice; the individual controls remain for fine-tuning. The point is that the default
  combination looks designed rather than assembled.
- **Tab in the last table cell appends a row** instead of trapping the caret, with the end of the
  table detected by "no next cell exists" rather than by position arithmetic.
- **One undo removes an AI insertion.** It used to merge with the typing before it, so Ctrl+Z
  after an AI edit wiped the paragraph you had just written. Programmatic edits now open a fresh
  history group with `closeHistory`.
- 213 smoke checks (three new), 142 unit tests.

## 1.3.1

The four things 1.3.0 got wrong.

- **A collapsed file tree is recoverable.** It used to shrink to zero width, taking its own toggle
  with it; now a 34 px rail stays with the ▶ button.
- **Ten real fonts.** The font setting offered three stacks and looked identical to most users;
  it now lists Georgia, Segoe UI, 微软雅黑, 宋体, 楷体, 仿宋, Times New Roman, Arial, Cambria and
  Consolas, and the setting survives a restart (main was rejecting the new keys, so choices
  silently fell back).
- **The table toolbar can be clicked.** It vanished the moment the pointer left the table; a
  220 ms grace period plus hover detection on the bar itself keeps it alive while you move onto it.
- **Exports offer Open / Show in folder**, like Typora: a toast with two buttons appears after
  every export (HTML, PDF, Word, EPUB).
- 210 smoke checks (four new), 142 unit tests.

## 1.3.0

Eight long-standing rough edges, from the editor's own list.

- **Full screen can be left again.** It was Electron's `togglefullscreen` role with no way out
  once the menu was hidden. The View item is now a real toggle on F11, and Esc leaves full screen
  from any window.
- **Fonts, widths and accents.** Settings gains an editor font (serif / sans / monospace), a text
  width (34 / 46 / 58 rem) and four accent colours; each applies on save and is remembered.
- **The file tree collapses.** The ◀ button in the Files header hides it, ▶ brings it back, and
  the state survives a restart.
- **Block math is centred.** The wrapper is forced to `display: block`, full column width and
  `text-align: center`, with the KaTeX display box centred inside it.
- **Table alignment.** The table bar has left / centre / right for the selected cell. Honest
  caveat, also in the README: markdown tables only describe *column* alignment, so per-cell
  alignment lives in the editor and in HTML/PDF exports but not in the .md file.
- **Table bar and image bar speak Chinese.** Every label is now an i18n key instead of hardcoded
  English ("+row ↑" → "+ 上方插入行").
- **A Notion-style table toolbar.** Hovering a table shows a compact bar with add row, add
  column, delete row, delete column and delete table.
- 207 smoke checks (six new: fullscreen toggle, appearance, tree collapse, centred math, table
  tools, localised bar), 142 unit tests.

## 1.2.0

Mermaid diagrams render in the editor.

- A fenced block with language `mermaid` gets a rendered SVG below it while you keep editing the
  source. An invalid diagram shows the parser's message instead of hiding the block.
- Mermaid (11.x, ~2.6 MB) is vendored into `src/renderer/vendor/mermaid` and loaded from disk, so
  diagrams also work offline; `scripts/sync-vendor.js` refreshes it on install.
- Three things had to be fixed before it worked, and the smoke check caught each one:
  - the render wrote into a node view element that ProseMirror had already replaced, so renders
    now go into a cache and node views paint from it;
  - a metadata-only transaction does not re-run node views, so finished renders repaint live
    previews directly;
  - hidden windows throttle rAF, which stalled mermaid; app windows now run with
    `backgroundThrottling: false`.
- Exports still contain the fence (documented in the README): wiring the renderer into the
  HTML/PDF path is a separate change.
- 201 smoke checks, 142 unit tests.

## 1.1.7

Focus mode lights a whole table from any cell.

- The decoration now marks the **top-level** block (depth 1) instead of the textblock. Decorating
  the paragraph inside a table cell left the table wrapper dimmed, so the caret looked
  unfocused and the table looked dead. Images and other non-active blocks still fade, which is
  the point of the mode.
- Getting here cost a detour: a first attempt removed the CSS dim rule to "simplify", which made
  every block look lit (the tests caught it immediately), and a second attempt skipped dimming
  for structural blocks, which made the mode inconsistent. The shipped rule is the simple one:
  exactly one block is at full opacity.
- 200 smoke checks, 142 unit tests.

## 1.1.6

A long AI answer no longer pushes the panel off-screen.

- The result box gets its own scroll area (`max-height: min(34vh, 320px)`, resizable). Before,
  a whole rewritten section grew the panel until Run/Insert scrolled out of reach.
- The smoke check loads a 120-line answer and asserts the box scrolls internally, stays inside
  the panel, and that the panel and Run button remain on screen.
- 199 smoke checks, 142 unit tests.

## 1.1.5

Word and EPUB exports are checked by content, not by magic bytes.

- Both archives are now opened in the smoke run: `word/document.xml` must contain the document
  text and be more than a skeleton, and the EPUB must declare `application/epub+zip` with a
  chapter that has a body and real text.
- The first threshold was too strict (`>300` bytes for a chapter) and failed on a short
  document; it now checks structure (`<body>`) plus a small floor instead of a size guess.
- 198 smoke checks, 142 unit tests.

## 1.1.4

PDF pagination is now verified, not assumed.

- The existing PDF check only asserted the `%PDF-` header. A larger export is now written and
  its page objects counted; the check fails if a 120-section document produces a single page,
  which is what a broken print path would look like.
- The footer already carries title plus `pageNumber/totalPages`; that code is unchanged, this
  round only proves the file really paginates.
- 196 smoke checks, 142 unit tests.

## 1.1.3

Narrow-window AI controls read properly.

- The context-scope row keeps its label on one line and lets the select shrink with an ellipsis
  instead of being squeezed to a few pixels.
- The preset row gets a right-edge fade (`mask-image`), so a scrollable row no longer looks
  clipped. The smoke check asserts the scope control fits, shows its selected text and that the
  mask is present at 720 px.
- 195 smoke checks, 142 unit tests.

## 1.1.2

Esc closes the preview; HTML tables stay tables.

- The export preview gets a small inline key handler: Esc closes the window, consistent with
  every other overlay. The smoke check opens the preview, sends Escape and asserts the window
  is destroyed.
- Verified that HTML tables inserted from the clipboard become real editable tables (four cells,
  `<table>` in the document, pipe-table in markdown) rather than flattened paragraphs.
- 194 smoke checks, 142 unit tests.

## 1.1.1

The settings filter understands section names.

- Typing "usage" or "export" now reveals that whole section (and expands it if folded), instead
  of only the fields whose own text happened to contain the word. An unknown query still shows
  nothing, and clearing it restores everything.
- 192 smoke checks, 142 unit tests.

## 1.1.0

Settings has a real Export section.

- The export template, file-name template, custom CSS and **Preview export** are now grouped
  under a collapsible **Export** heading (next to **AI writing** and **Usage**). They used to be
  scattered: the template above the AI section, the other three inside it, so folding "AI
  writing" hid export settings too.
- The collapse helper now also folds the name hint and the preview button, which sat between
  fields and would otherwise stay visible.
- 191 smoke checks, 142 unit tests.

## 1.0.9

Pasting a URL over a selection links it.

- The Link extension is now configured explicitly (`openOnClick: false`, `autolink: true`,
  `linkOnPaste: true`) instead of relying on StarterKit defaults, so selecting words and pasting
  a URL produces `[words](url)` rather than replacing them.
- The smoke check asserts the configuration on the live editor instance. Simulating a clipboard
  paste with `ClipboardEvent` does not carry `clipboardData` in this Chromium build, so a
  behavioural test there would have been a fake.
- 190 smoke checks, 142 unit tests.

## 1.0.8

Links can no longer navigate the app away.

- This was a real hazard: nothing intercepted link clicks, so a plain click on a link in the
  document could try to load that URL *inside* the editor window. Now:
  - `will-navigate` is denied for anything but the app's own page, `setWindowOpenHandler`
    denies popups, and safe URLs go to the system browser instead;
  - a plain click only places the caret, Ctrl/Cmd/middle click opens the browser;
  - the `app:openExternal` IPC validates the scheme and refuses `javascript:`, `data:` and
    `file:` URLs.
- `src/link-guard.js` holds the rules with four unit tests; the smoke check clicks a link
  plainly (no navigation) and with Ctrl (recorded as opened) and tries an unsafe scheme.
- 189 smoke checks, 142 unit tests.

## 1.0.7

AI history chips are keyboard navigable.

- Arrow keys move focus between the load buttons of the history chips, Home/End jump to the
  ends, and the handler is attached once per render rather than per open.
- The smoke check seeds three turns, focuses the first chip and asserts ArrowRight/End move
  focus — previously a keyboard user had to Tab through load+insert pairs of every chip.
- Cross-checked the docs: the ▤ usage entry, per-draft ×, Ctrl+Shift+K and this navigation are
  all described in the user guide.
- 187 smoke checks, 138 unit tests.

## 1.0.6

Overlays separate from the page in dark mode too.

- A soft `rgba(0,0,0,.22)` shadow reads as a grey smudge on a near-black page. Overlays now use
  CSS variables: light keeps the wide soft shadow, dark switches to a tighter, deeper one with a
  brighter hairline border (`#3a424d`).
- The smoke check opens settings in each theme and asserts the computed shadow and border
  actually differ — a stylesheet regression here is invisible until someone uses dark mode.
- 186 smoke checks, 138 unit tests.

## 1.0.5

Delete one draft, not all of them.

- Each row in the recovery panel gained a × button that deletes that draft after a confirmation
  (skipped in smoke runs, which exercise the delete itself). Before, the only cleanup was the
  30-day bulk purge.
- The button carries an `aria-label` naming the draft; the smoke check writes a draft, deletes
  it through the row, and asserts both the file and the row are gone.
- 185 smoke checks, 138 unit tests.

## 1.0.4

The AI usage log is one click away.

- The AI panel gained a ▤ button (with an `aria-label`) that opens Settings, expands the folded
  Usage section, scrolls to it and re-renders the list. The palette has the same destination as
  "Open AI usage log" — previously the log was only findable by scrolling a long panel.
- 184 smoke checks, 138 unit tests.

## 1.0.3

A chosen context scope is respected.

- Fixed a real bug: the AI scope was saved, but `explicit` was not restored on the next launch,
  so a user who picked "whole document" on a long file silently got the auto-narrowed
  paragraph instead. A stored value now counts as an explicit choice.
- The rule moved into `src/ai-scope.js` (`initialScope`, `effectiveScope`) with five unit tests,
  so the renderer no longer keeps its own copy of the threshold logic.
- 183 smoke checks, 138 unit tests.

## 1.0.2

Release knowledge written down, and focus mode verified under scrolling.

- New `docs/RELEASING.md`: what `npm run ship` covers, the exact steps for adding a signing
  certificate (`CSC_LINK`), how to switch on the generic update feed, and a release checklist.
  The two things the pipeline cannot do alone are now written where the next person looks.
- A smoke check moves the caret into the 40th paragraph with focus mode on and asserts exactly
  one block is at full opacity, the rest dimmed, and scrolling does not change that.
- 182 smoke checks, 133 unit tests.

## 1.0.1

The AI header fits on narrow windows.

- Retry, Stop and the settings button are now labelled icons (↻ / ■ / ⚙, each with an
  `aria-label`), and at ≤780 px the instruction field shrinks instead of forcing a second row:
  the header is 27 px tall instead of 61 px.
- Two smoke expectations were updated to the new intent: the narrow layout now asserts a
  single-row header, and the header check asserts every button is self-describing (visible text
  or an aria-label).
- 181 smoke checks, 133 unit tests.

## 1.0.0

The shortcut sheet now matches the app.

- The table said "Ctrl+Shift+E / P" — the second key was ambiguous. It now reads
  `Ctrl+Shift+E / Ctrl+Shift+P`, and three missing accelerators were added: preview
  (Ctrl+Shift+V), focus mode (Ctrl+Shift+K) and tab close/reopen (Ctrl+W / Ctrl+Shift+T).
- New unit tests keep this honest: no two menu items may share an accelerator, every documented
  key must be well formed, the newer accelerators must be present, and menu shortcuts must
  exist among the real accelerators.
- 180 smoke checks, 133 unit tests.

## 0.99.0

Checks stop inheriting state from each other.

- Added `resetUiState()` to the smoke runner: theme light, language en, guide card undismissed,
  focus mode off, folded sections and palette usage cleared, overlays closed. A new check
  (`ui-state-reset`) asserts the reset actually produces that state.
- This is the fix for the packaged-run failures seen in 0.98.0, where one assertion's leftover
  `guideDismissed: true` and sepia theme made three unrelated checks fail. Relying on run order
  is how a suite slowly becomes untrustworthy.
- 180 smoke checks, 129 unit tests.

## 0.98.0

Accessible history chips, verified table navigation, and a smoke budget that fits.

- AI history chips are real `<button>`s and now carry `aria-label`s ("Load this prompt: …",
  "Insert this result into the document"), so they are not just truncated text for a screen
  reader.
- Added a check that Tab inside a table advances cell by cell (`goToNextCell`), which is the
  behaviour users expect and easy to break when table extensions change.
- The suite outgrew its own watchdog: runs now take ~171 s against a 170 s limit, which aborted
  the run *after* writing results but before printing `SMOKE_RESULT` — a silent "no output"
  failure. The in-app watchdog is 240 s and the external runner 300 s, and DEVELOPING says to
  check those numbers first when a run stops without a result.
- 179 smoke checks, 129 unit tests.

## 0.97.0

The export name template shows what it produces.

- A live example appears under **Export file name** ("e.g. 2026-10-23-notes.html") and updates
  as you type. It is computed by the same `buildExportName` the export dialog uses, via a small
  `export:namePreview` IPC, so the example cannot drift from the real behaviour.
- 177 smoke checks, 129 unit tests.

## 0.96.0

Settings say when Save is actually needed.

- A muted **Unsaved changes** hint appears next to the buttons as soon as any tracked field
  differs from the snapshot taken when the panel opened — and disappears again when the change
  is reverted, because it compares values rather than tracking a boolean.
- The smoke check edits the autosave field, asserts the hint, cancels, reopens and asserts both
  the hint is gone and the stored value came back.
- 176 smoke checks, 129 unit tests.

## 0.95.0

Copy confirms itself, and export styling can be previewed from Settings.

- The AI **Copy** button shows "Copied" for ~1.4 s and then restores its label, so the feedback
  sits where the user clicked instead of only in a toast.
- Settings gained **Preview export**: it saves the template and custom CSS currently on screen
  and opens the same preview window, so styling can be judged before writing a file. The smoke
  check opens exactly one preview window and confirms no temporary HTML is left behind.
- 175 smoke checks, 129 unit tests.

## 0.94.0

The palette shows why a command matched.

- While typing, the matching part of each command name is wrapped in a highlighted `<mark>`,
  built from text nodes so a translated label can never inject markup. With an empty query no
  marks are produced (asserted in `palette-highlight`).
- 173 smoke checks, 129 unit tests.

## 0.93.0

Esc hands the keyboard back.

- Closing the AI panel (Esc, or the global Escape chain) now blurs the field, focuses the editor
  and re-syncs the empty-state card. Before, the hidden instruction field kept focus, so the
  next keystroke went nowhere.
- The smoke check presses Esc inside the instruction field and asserts the panel closes and the
  document accepts input afterwards.
- 172 smoke checks, 129 unit tests.

## 0.92.0

Undo behaves, and the status bar breathes.

- Verified that an AI insertion is a single undo step in both modes: one Ctrl+Z removes the
  inserted text (inline and new-paragraph) without touching the rest of the document. No code
  change was needed — the test now locks the behaviour in.
- Adjacent status-bar items are separated by a muted dot, so "Saved 03:12:44 · backups 3" does
  not read as one long string.
- 171 smoke checks, 129 unit tests.

## 0.91.0

Two AI-panel and focus-mode refinements.

- The six AI presets no longer wrap into three rows on narrow windows; they scroll
  horizontally on a single line, so the panel keeps its height.
- Verified that focus mode and find cooperate: searching moves the selection, so the matched
  block becomes the active (undimmed) one. A smoke check asserts the matched paragraph is at
  full opacity while the rest stays dimmed.
- 169 smoke checks, 129 unit tests.

## 0.90.0

Focus mode adapts to the theme.

- The fade was a fixed 32%, which over a near-black page made the dimmed text look broken
  rather than de-emphasised. It is now 32% light, 38% sepia, 45% dark.
- The smoke check switches theme and asserts the factor rises for dark and returns when light
  comes back.
- 167 smoke checks, 129 unit tests.

## 0.89.0

Focus mode has a shortcut.

- **View → Focus mode**, accelerator `Ctrl+Shift+K`, and the palette row advertises the same
  key. Previously it was only reachable by searching the palette.
- The smoke check reads the real application menu (`Menu.getApplicationMenu()`) and the palette
  hint, so a changed accelerator cannot drift between the two.
- 166 smoke checks, 129 unit tests.

## 0.88.0

Focus mode.

- Command palette → **Toggle focus mode** dims every block except the one holding the caret
  (0.32 opacity, 140 ms fade). The state is stored in settings and restored on launch.
- Two implementation notes that cost an hour: a class added by hand is wiped on every
  ProseMirror render, so the active block is marked with a node decoration; and dispatching a
  transaction from inside the `update` handler that it triggers recurses forever.
- During this work a patch script inserted the feature over the editor construction block;
  `src/renderer/app.js` was restored from the previous package's `app.asar` and the feature
  re-applied. The smoke suite caught it (`overlays-toggle` failing), which is why that test
  exists.
- 165 smoke checks, 129 unit tests.

## 0.87.0

Recovery drafts say how old they are.

- Each row in the recovery panel appends a relative age ("just now", "25 min ago", "3 d ago"),
  so a month-old leftover is recognisable before it is restored. One helper handles en/zh and
  returns an empty string for unreadable timestamps.
- Also corrected the AI diff label: it now says "vs paragraph" when no selection was used,
  instead of always claiming "vs selection".
- 164 smoke checks, 129 unit tests.

## 0.86.0

The save state is visible.

- The header now shows **Unsaved** → **Saving…** → **Saved HH:MM**, driven by `save:state`
  events from main. An untitled buffer stays at *Unsaved* (there is no file to write), which
  the first version got wrong: it emitted "Saving…" and then hung there forever.
- Also fixed a real trap found by the test: `saveCurrent` on an untitled document returned
  early without telling the renderer anything.
- 163 smoke checks, 129 unit tests.

## 0.85.0

The statistics panel knows about your selection.

- A **Selection** row reports how many characters are selected ("nothing selected" otherwise),
  which is what you need before sending a range to the AI panel or exporting a fragment.
- 162 smoke checks, 129 unit tests.

## 0.84.0

An empty outline explains itself.

- While a document has no headings the outline column shows "Headings will appear here"
  instead of an unexplained blank strip. It appears and disappears as headings are added or
  removed (asserted in `outline-empty-state`).
- 161 smoke checks, 129 unit tests.

## 0.83.0

The export preview follows the editor theme.

- In dark or sepia theme the preview paints itself to match, including the notice bar; the
  exported file stays light, because a dark document prints and pastes badly. Previously the
  preview was always white, which was jarring when writing in dark mode.
- A smoke check switches to dark, opens the preview and reads the computed background colour
  (must be under 60 per channel), then restores the light theme.
- 160 smoke checks, 129 unit tests.

## 0.82.0

Narrow windows lay out instead of squeezing.

- Below 780 px the AI panel header wraps to two rows (instruction full width, buttons sharing
  the next), the panel narrows to the viewport, and both side columns shrink to 150 px.
- Side columns size with `flex-basis`, so the media query had to override `flex`; a plain
  `width` rule did nothing and the smoke check caught it (outline still 220 px).
- The Outline toggle keeps working at any width — the column narrows, it does not vanish.
- 159 smoke checks, 129 unit tests.

## 0.81.0

The palette teaches its shortcuts and learns your habits.

- Every command row shows its accelerator (Ctrl+S, Ctrl+Shift+T, F1 …), so the palette doubles
  as a discoverable shortcut sheet.
- With nothing typed, commands are ordered by how often you run them (`paletteUsage` in
  settings, incremented on click and on Enter). The smoke check runs Statistics twice and
  asserts it moves to the top.
- 158 smoke checks, 129 unit tests.

## 0.80.0

Settings remember how you left them.

- The AI and Usage sections fold, and that state is stored (`collapsedSections`, keyed by a
  stable `data-section` id rather than the translated heading), so reopening Settings does not
  unfold everything again.
- The stored map is sanitised on write: only short lowercase keys are kept, values coerced to
  booleans.
- 157 smoke checks, 129 unit tests.

## 0.79.0

The toolbar has rhythm.

- Fifteen equally spaced icons read as one undifferentiated row. They are now clustered into
  labelled groups (text style, block style, lists, code, insert, math, AI) separated by rules;
  each group carries an `aria-label` for screen readers.
- A smoke check asserts the grouping survives: at least six groups, all fifteen commands still
  present, and the bar stays a single row under 44 px tall.
- 156 smoke checks, 129 unit tests.

## 0.78.0

The AI panel says when it is not configured.

- Opening it without an endpoint or key shows which one is missing, offers **Open AI
  settings**, and keeps Run disabled — instead of letting the user compose an instruction and
  only then get a failure.
- Re-checked every time the panel opens, so saving a key clears the warning without a restart.
- 155 smoke checks, 129 unit tests.

## 0.77.0

Pick a model instead of typing one.

- Settings gained **Fetch models**, which reads `/v1/models` from the configured endpoint and
  fills a `datalist`, so the name can be selected rather than typed (typos in model names were
  the most common self-inflicted failure). Gateways without the route are handled: the list
  stays empty and the field remains free-text.
- `src/ai-models.js` normalises the URL (including a `/chat/completions` base), deduplicates
  and sorts ids, and times out after 10 s; five unit tests cover the parsing.
- 154 smoke checks, 129 unit tests.

## 0.76.0

Test connection tells you what to fix.

- A successful test now reports the model name, latency and the model's sample reply, so it is
  clear *which* model answered.
- A failure appends an actionable hint from `src/ai-errors.js` (key rejected, wrong base URL,
  rate limit, DNS, server not running, timeout, TLS, or "not an OpenAI-compatible endpoint")
  instead of only echoing `fetch failed`. Missing endpoint/key are caught before the request.
- 153 smoke checks, 124 unit tests.

## 0.75.0

The AI panel fits small windows, and selected formulas are obvious.

- The panel used a fixed 560 px width; it is now `min(560px, 100vw - 64px)` with a capped
  height and its own scroll, so at the 720 px minimum window it no longer leaves the screen.
- A selected formula gets an accent outline and tint instead of relying on the generic node
  selection frame, which was easy to miss inside a page of text.
- 151 smoke checks, 118 unit tests.

## 0.74.0

Display math is centred and clickable, and Preview works on a paragraph.

- Block formulas are centred with spacing, a hover highlight and horizontal scroll for long
  lines; inline formulas get a pointer cursor and hover tint so click-to-edit is discoverable.
  The style targets `[data-type="block-math"]`, because Tiptap does not emit KaTeX's
  `.katex-display`.
- **Preview changes** now falls back to the paragraph under the cursor when nothing is
  selected, matching what **Replace selection** rewrites, so the diff review works for the
  paragraph-editing flow too.
- 149 smoke checks, 118 unit tests.

## 0.73.0

One icon set for the toolbar.

- Bold/italic/strike/code/lists/quote/code-block/link/table/image/math/AI switch from
  platform glyphs and emoji to a single stroke-based SVG set that inherits the theme colour.
  Every button keeps its tooltip and gains an `aria-label`.
- The smoke check asserts all toolbar buttons carry an SVG (15 of 15) and none still shows a
  text glyph, so a future edit cannot half-migrate the toolbar.
- Screenshots no longer include the onboarding banner, so the docs show a clean first run.
- 147 smoke checks, 118 unit tests.

## 0.72.0

Formulas get a live preview and are editable in place.

- The math popover renders KaTeX as you type and shows a readable error for broken LaTeX
  instead of inserting nothing.
- Clicking a rendered formula reopens it with its current source, and applying rewrites that
  node rather than appending a second copy (the edit target has to be remembered *after*
  opening the popover, because opening resets it).
- The user guide was rebuilt after a `String.replace` accident duplicated three sections:
  `$` in a replacement string expands (`$&`, `$'`), so text containing `$x$` must go through a
  replacer function. `test/docs.test.js` now rejects duplicated headings.
- 146 smoke checks, 118 unit tests.

## 0.71.0

The empty-document card can be dismissed, and AI can rewrite a paragraph.

- The guide card («mdpad / 一个不怕崩溃和中断的 Markdown 编辑器») gained a × button; dismissing
  it is stored in settings so it stops appearing on every new empty tab. Focus-based hiding
  was tried first and dropped: `focus()` does not fire when the editor already holds focus,
  so the card kept reappearing.
- **Replace selection** now falls back to the paragraph under the cursor when nothing is
  selected, so "select a paragraph, let the AI rewrite it" is one click instead of a drag.
- 144 smoke checks, 112 unit tests.

## 0.70.0

Three ways to apply an AI result.

- **Insert** keeps the old behaviour (at the cursor), **New paragraph** splits the block first
  so the result never merges into the sentence you were editing, and **Replace selection**
  swaps the selection.
- The smoke check verifies the paragraph count grows and that inline insert really stays
  inline, so the two modes cannot quietly become the same button.
- 142 smoke checks, 112 unit tests.

## 0.69.0

Inserted AI text is brought into view.

- After Insert/Replace the editor scrolls to the inserted block, which matters in long
  documents where the panel sits over the top of the page.
- `editor.commands.scrollIntoView()` turned out not to be a usable Tiptap command here; the
  fix resolves the DOM node at the caret and scrolls it directly.
- Also measured: replacing 2000 matches in a ~12k-character document finishes well within
  the 5 s budget (asserted in `replace-all-large`).
- 141 smoke checks, 112 unit tests.

## 0.68.0

AI context expires.

- Conversation turns now carry a timestamp and are pruned after 30 days (and capped at four),
  so `ai-history.json` never becomes an unintended transcript. Entries written before
  timestamps existed are kept.
- `src/ai-history.js` holds the rule with unit tests; the smoke check seeds a 90-day-old turn
  and asserts it is dropped on read.
- 139 smoke checks, 112 unit tests.

## 0.67.0

Theme contrast is measured, not eyeballed.

- A smoke audit samples the real computed colors for editor text, status bar and toolbar in
  light, dark and sepia, and fails if body text drops below WCAG AA (4.5:1) or secondary
  text below 3:1.
- First run caught a sampling mistake rather than a design issue: the editor has a
  transparent background, so it was compared against `rgba(0,0,0,0)`. The audit now walks up
  to the first painted ancestor.
- 138 smoke checks, 108 unit tests.

## 0.66.0

The window has a usable minimum size.

- Windows cannot be resized below 720×480 (`minWidth`/`minHeight`), and a smaller saved size
  is enlarged on restore — otherwise the toolbar wraps into uselessness and the setting is
  hard to undo.
- `fitBounds` clamps to the same floor; its unit test now expects 720×480.
- 137 smoke checks, 103 unit tests.

## 0.65.0

Zoom the export preview.

- The preview header carries 75% / 100% / 125% buttons (inline in the generated page, so the
  sandboxed window needs no extra IPC surface), letting you check a dense page without
  exporting.
- 136 smoke checks, 103 unit tests.

## 0.64.0

Replace All is honest about what it did.

- The status line reports the number of replacements, and when the 2000-match search cap was
  hit it says so ("run it again for the rest") instead of claiming everything was replaced.
- Verified that Replace All is a single undo step: 40 hits replaced, one Ctrl+Z restores all
  40 originals.
- 135 smoke checks, 103 unit tests.

## 0.63.0

Find is bounded on big documents.

- Match collection stops at 2000 hits (shown as `1/2000+`) and typing in the find box is
  debounced, so a one-letter query in a long file cannot build thousands of selections.
- Fixed a real bug this exposed: the traversal callback returned `false` for non-text nodes,
  which makes ProseMirror stop walking — a query matched nothing at all.
- 134 smoke checks, 103 unit tests.

## 0.62.0

Session restore is verified by a real restart.

- `npm run restart-check` launches the app twice with the same profile: the first run opens
  two windows (three tabs), quits cleanly; the second must reopen both windows and their
  tabs. This exercises the write-on-quit path that the in-process restore test could not.
- Wired into `release-check`, so the packaged binary is covered too.
- 133 smoke checks, 103 unit tests.

## 0.61.0

Last-saved time is visible.

- The statistics panel reports when the buffer was last written (or "not saved yet"), so a
  stalled autosave is obvious without opening the folder.
- 133 smoke checks, 103 unit tests.

## 0.60.0

Draft cleanup, with a confirmation.

- The recovery panel gained **Clean up old drafts**: it deletes drafts older than 30 days
  after a dialog states how many will be removed. Recent drafts and drafts for existing
  files are untouched; nothing is purged silently.
- `selectStaleDrafts` is unit-tested (cutoff, invalid dates, invalid window).
- 132 smoke checks, 103 unit tests.

## 0.59.0

A bad session cannot trap you in a crash loop.

- The app counts startup crashes (a lock file left behind means the previous run died).
  After two in a row, session restore is skipped, the old `session.json` is copied to
  `session.json.crashloop`, and a clean window opens. A clean quit resets the counter.
- `src/startup-guard.js` holds the decision rule with unit tests; `app:restoreDecision`
  exposes it for the smoke check.
- 131 smoke checks, 101 unit tests.

## 0.58.0

Per-tab undo history, and a real reload.

- Switching tabs no longer throws away undo history: each tab's ProseMirror `EditorState` is
  cached and restored, so Ctrl+Z keeps stepping back through that tab.
- The cache is validated against the markdown main sends; if the file changed on disk the
  stale state is dropped and the content reloaded. Covered by a smoke check that edits a
  file, switches away, rewrites it on disk and reloads.
- Found and fixed while testing: the "Reload" action on an externally changed file only
  re-activated the tab and never re-read the file. `Session.reloadFromDisk()` now does.
- 130 smoke checks, 97 unit tests.

## 0.57.0

Export templates are visible before exporting.

- The template selector draws a small SVG thumbnail of the page: margins for default vs
  compact, and a contents block for the TOC template.
- 128 smoke checks, 97 unit tests.

## 0.56.0

Long documents stop sending everything.

- Over ~20k characters the request narrows to the current paragraph automatically, marked
  "auto" in the context note. It only changes what is sent, never the saved setting, and a
  scope you picked yourself always wins.
- While building this, mutating the stored scope turned out to leak into later behaviour
  (one test's long document changed another test's expectations), which is why the
  narrowing is computed per request instead of by switching the select.
- 127 smoke checks, 97 unit tests.

## 0.55.0

Fewer phantom save failures, clearer export choices.

- Atomic writes retry once on EBUSY/EPERM/EACCES/EMFILE, which on Windows are usually
  antivirus or the search indexer holding the file for a moment. Non-transient errors still
  fail immediately (`src/retry.js`, unit-tested).
- The export template selector shows a one-line description of the chosen layout.
- 126 smoke checks, 97 unit tests.

## 0.54.0

Recent files in the palette, names in the close guard.

- The command palette lists recently opened files ("Open recent: …"), so returning to a
  document does not need the File menu.
- The unsaved-changes dialog now names the documents (first five, plus a remainder count)
  instead of only a total.
- 125 smoke checks, 92 unit tests.

## 0.53.0

Test the AI connection.

- Settings → **Test connection** sends one tiny request with the typed endpoint/model/key and
  reports "connected in N ms" or the actual failure, so a wrong endpoint is caught while
  configuring instead of on the first real generation.
- The smoke suite's watchdog was raised (170 s in-app, 240 s external) after the growing
  suite hit the old 90 s limit and produced a misleading "render frame disposed" error.
- 124 smoke checks, 88 unit tests.

## 0.52.0

Visible drafts and collapsible settings.

- A status-bar badge shows how many recovery drafts exist and opens the recovery panel, so
  unsaved work is discoverable without hunting through menus.
- Settings section headings collapse their fields when clicked.
- 123 smoke checks, 88 unit tests.

## 0.51.0

Recovery drafts are browsable.

- File → Recover Drafts… lists every draft with its name, timestamp and size; picking one
  opens the file and loads the unsaved text into the editor.
- Fixed an ordering bug this surfaced: `doc:loaded` (the on-disk version) could arrive
  after the draft and overwrite it, so the draft now travels as its own event.
- 121 smoke checks, 88 unit tests.

## 0.50.0

Reopen closed tabs.

- Ctrl+Shift+T reopens the last closed tab with its buffer intact (up to 10 remembered);
  unsaved text survives closing a tab and coming back.
- Also verified that an AI "Replace selection" is a single undo step.
- 120 smoke checks, 85 unit tests.

## 0.49.0

Truncated restores are announced.

- When session restore drops tabs (over the 20-tab cap, or the file no longer exists), a
  second toast reports the count instead of losing them silently.
- `planRestore` now reports `dropped` per window; unit tests cover both the cap and the
  missing-file case.
- 118 smoke checks, 85 unit tests.

## 0.48.0

Failure cooldown and preview context.

- After a hard AI failure the Run button pauses for three seconds with a "retry in Ns"
  countdown, so a wrong endpoint or revoked key cannot be hammered. Verified against a
  closed port.
- The export preview names the active template next to the page-break caveat.
- 117 smoke checks, 83 unit tests.

## 0.47.0

Usage export and tab tooltips.

- Settings → Usage gained **Export CSV**, writing `at,model,promptTokens,outTokens,ms,ok`
  rows from the local log (extra fields are comma-safe).
- Tab labels truncate with an ellipsis and show the full path on hover.
- 116 smoke checks, 83 unit tests.

## 0.46.0

Export names and a scope hint.

- Settings → Export file name accepts `{title}`, `{date}` and `{time}` placeholders; invalid
  filename characters are replaced (`src/filename.js`, unit-tested).
- Documents over ~8k characters make the AI panel suggest the paragraph scope, since
  sending the whole file is rarely what you want there.
- 114 smoke checks, 83 unit tests.

## 0.45.0

Faster history reuse and export footers.

- Each AI history chip now has an insert button (⤓) that puts that result straight into
  the document, alongside the existing load-into-panel behaviour.
- HTML and PDF exports end with a word/character footer, so a shared file carries its own
  size context.
- 113 smoke checks, 78 unit tests.

## 0.44.0

First-run onboarding.

- The first launch shows a one-time banner pointing at AI setup (Ctrl+J) and the update
  check; dismissing it records `onboarded` in settings so it never returns.
- The startup budget now distinguishes dev (10 s, noisy CI machines) from packaged
  (5 s), after a dev run tripped the old single threshold.
- 111 smoke checks, 78 unit tests.

## 0.43.0

Copy and export feedback.

- The AI panel gained a **Copy** button that puts the streamed result on the system
  clipboard without modifying the document (verified by reading the clipboard back).
- Exports emit an `exporting` status before the `exported` result, so the status bar says
  "exporting PDF…" instead of going quiet; the order is asserted in the smoke suite.
- 110 smoke checks, 78 unit tests.

## 0.42.0

Large-export warning and remembered context scope.

- Word/EPUB exports above 20 MB show a banner with the size and a hint that large images
  are usually the cause (`src/export-limits.js`, unit-tested).
- The AI context scope (document / paragraph / selection) is saved in settings and
  restored on launch.
- 108 smoke checks, 78 unit tests.

## 0.41.0

Selectable AI context scope.

- The AI panel can send the whole document, only the current paragraph, or nothing but the
  selection. The context note reflects the choice and still reports trimming.
- Implementing it surfaced two ProseMirror mistakes worth noting: `node.from` does not
  exist on a node (only `ResolvedPos.start/end(depth)` does), and the cursor depth already
  points at the textblock, so stepping up lands on the document.
- 107 smoke checks, 74 unit tests.

## 0.40.0

Tab overflow and paste warning.

- With more tabs than fit, scroll arrows appear on either side of the tab bar; the active
  tab is scrolled into view after every change. Logic was already present — now covered by
  a smoke check that opens 14 extra tabs and asserts the arrows and scrolling.
- Pasting more than 4000 characters into the AI instruction box warns before the request
  becomes expensive.
- 106 smoke checks, 74 unit tests.

## 0.39.0

EPUB embeds images.

- Local images (and pasted data URLs) are copied into the EPUB at `OEBPS/images/` and
  declared in the manifest; remote URLs keep their original `src`.
- The smoke check unzips the produced book and asserts both the media entry and the
  manifest `media-type`, instead of scanning compressed bytes.
- 104 smoke checks, 74 unit tests.

## 0.38.0

Word export embeds images.

- Local images (and pasted data URLs) are embedded in `.docx` at their aspect ratio,
  scaled to a readable width; remote URLs fall back to alt text. PNG/JPEG dimensions are
  read from the file header. `loadImage`/`imageSize` have unit tests.
- 103 smoke checks, 70 unit tests.

## 0.37.0

Tab ordering and a faster AI run.

- Tabs can be dragged to reorder; the order is persisted in the session snapshot.
- Ctrl+Enter inside the AI instruction box runs the request without reaching for the mouse.
- 102 smoke checks, 66 unit tests.

## 0.36.0

Tab shortcut and send guard.

- Ctrl+W closes the active tab (also a palette command), flushing pending edits first.
- Verified that a double-click on Run cannot start two concurrent AI requests.
- 100 smoke checks, 66 unit tests.

## 0.35.0

History chips and safe window placement.

- The AI panel lists the last four exchanges as chips; clicking one restores that
  instruction and result into the boxes.
- Saved window bounds are validated against connected displays: a window restored from a
  disconnected monitor falls back to a visible position instead of opening offscreen. The
  rule lives in `src/window-bounds.js` with unit tests.
- 98 smoke checks, 66 unit tests.

## 0.34.0

Command-line files and settings filter.

- `mdpad notes.md todo.md` (or dropping several files on the exe) opens each file as a tab;
  duplicates are ignored and flags like `--smoke-test` are skipped. The parsing rules live
  in `src/cli.js` with unit tests.
- The settings panel gained a filter box that narrows fields and section headers.
- 96 smoke checks, 61 unit tests.

## 0.33.0

Read-only protection and decisive cancel.

- A permission failure (EACCES/EPERM/EROFS) puts the document into a protected state:
  autosave stops hammering the file, the banner explains the situation, and Retry resumes
  once permissions are fixed. Verified by chmod-ing a real file read-only.
- Stopping an AI request releases the panel immediately and keeps the streamed text;
  the late "cancelled" response no longer overwrites the status.
- 94 smoke checks, 57 unit tests.

## 0.32.0

Elapsed-time feedback.

- A streaming AI request shows elapsed seconds next to the token estimate, so a slow
  model no longer looks like a hung app. Verified with a stub that streams over ~2 s.
- The export preview states that its page breaks may differ from the exported PDF, so a
  preview is not mistaken for the final layout.
- 91 smoke checks, 57 unit tests.

## 0.31.0

Backup restore.

- Clicking the backup count opens a restore list (time + size). Choosing an entry loads
  that version into the editor as unsaved changes, so a rollback is inspected before it
  replaces anything. Paths outside the backups directory are rejected.
- The new popover is part of the startup visibility assertion that guards against
  overlays ignoring the `hidden` attribute.
- 90 smoke checks, 57 unit tests.

## 0.30.0

Backup visibility and style presets.

- The status bar shows the backup count and newest backup time, updated after manual
  saves and autosaves alike (autosave refreshes the indicator without a "saved" flash).
- AI style presets (Concise / Academic / Marketing / Friendly) fill the writing-style
  field in Settings.
- 89 smoke checks, 57 unit tests.

## 0.29.0

Startup preflight and writing-style guidance.

- At startup mdpad probes that the data, backups and drafts folders are writable; a
  failure shows a banner immediately instead of surfacing as a save error later. The
  check lives in `src/preflight.js` with unit tests.
- Settings → Writing style guidance appends your own instructions to the AI system prompt
  (2000-character cap), applied to every request.
- 87 smoke checks, 57 unit tests.

## 0.28.0

CI output and visible context trimming.

- `node scripts/smoke.js --json` prints a single JSON document (ok, counts, per-step
  results) with the app's own output suppressed, for CI parsing.
- The AI panel shows how much document context will be sent and says when it was trimmed
  (4000-char cap), so context is never silently dropped.
- 85 smoke checks, 50 unit tests.

## 0.27.0

Multi-window restore and usage trend.

- Session restore reopens every saved window (up to 4), not just the first; the capping
  rules moved into `src/session-restore.js` with unit tests for missing files, tab caps,
  oversized drafts and malformed snapshots.
- Settings shows a duration sparkline over the last requests.
- 84 smoke checks, 50 unit tests.

## 0.26.0

Export preview and restore notice.

- File → Preview Export (Ctrl+Shift+V) renders the export HTML in a modal child window;
  the temp file is removed when the preview closes. Covered by a smoke check that asserts
  the window exists, loads the preview file, and cleans it up.
- Restoring more than one tab shows a "Restored N tabs" toast, so a restored session is
  not mistaken for lost work.
- 82 smoke checks, 44 unit tests.

## 0.25.0

Visible retries and validated settings.

- When a request is retried, the AI status line says "network hiccup — retrying (1)…" so a
  pause is never mistaken for a hang. Verified against a stub that returns 503 once.
- Settings validates before saving: endpoint must be an http(s) URL, autosave 1–60 s,
  token threshold 0–500000; errors appear inline and nothing is written.
- 80 smoke checks, 44 unit tests.

## 0.24.0

AI retry and export styling.

- Streaming requests retry once on a network error, HTTP 429 or 5xx (500 ms pause); a
  request that already produced text is never retried, and 4xx fails immediately.
- Settings → Custom CSS for exports appends your rules to HTML and PDF output; `<style>`,
  `<script>` and `@import` are stripped so pasted CSS cannot inject markup.
- 78 smoke checks, 44 unit tests.

## 0.23.0

AI usage log.

- Every AI request appends `{model, promptTokens, outTokens, ms, ok}` to
  `<userData>/ai-usage.jsonl` (bounded to 50 lines); Settings shows the last 20 in the
  UI language.
- Exports are asserted to stay light-themed: a dark app theme must never darken an
  exported HTML/PDF.
- Outline rebuild cost is measured separately (2 ms with 600 headings).
- 76 smoke checks, 40 unit tests.

## 0.22.0

Visual regression guards and dark screenshots.

- The smoke suite now asserts `getComputedStyle(...).display === 'none'` for every
  overlay at startup and that opening/closing Settings flips it — the check that would
  have caught the `[hidden]` bug immediately.
- Dark theme is verified to repaint the shell (background and foreground differ from
  light and from each other).
- `npm run shots` also captures the dark theme; the user guide shows all six states.
- 74 smoke checks, 40 unit tests.

## 0.21.0

Crash diagnosis, screenshots, and a hidden-element fix.

- **Fixed:** `.modal` / `.banner` set `display: flex`, which overrode the `hidden`
  attribute — the settings panel and banners were actually painted while their `hidden`
  property was true. `[hidden] { display: none !important }` now wins. Tests had only
  checked the property, so this was found by capturing real screenshots.
- On startup after a crash (lock file left behind), a banner reports the previous
  abnormal exit and offers to open the recovery-drafts folder.
- `npm run shots` captures documentation screenshots from the real UI through CDP
  (`Page.captureScreenshot`, because `capturePage` returns stale frames for occluded
  windows); the user guide now embeds five of them.
- 71 smoke checks, 40 unit tests.

## 0.20.0

Cost guard and startup budget.

- AI requests above a configurable threshold (default 20000 estimated tokens) ask for
  confirmation before sending; the estimate is shown while streaming.
- Packaged cold start measured at 258 ms (dev ~644 ms); the smoke suite fails above 5 s.
- 71 smoke checks, 40 unit tests.

## 0.19.0

Ship pipeline, startup budget, token estimate.

- `npm run ship`: release-check → installers → install/uninstall check → `SHA256SUMS.txt`.
- Cold-start timing is measured (dev ~644 ms) and exposed in `app:info`; the smoke suite
  fails if startup exceeds 5 s.
- The AI panel shows an estimated prompt/output token count, so a long document does not
  silently turn into a large request.
- 70 smoke checks, 40 unit tests.

## 0.18.0

Bounded sessions, provider presets, split docs.

- Session snapshots are capped (20 tabs, 5 untitled buffers, 200 KB each) and keep the
  active tab, so startup stays fast and `session.json` cannot grow without limit.
- AI provider presets: DeepSeek, OpenAI, Ollama (local) or Custom fill the endpoint and
  model fields.
- Documentation split into `docs/USER_GUIDE.md` and `docs/DEVELOPING.md`; the README is
  now a short entry point with quality gates.
- 69 smoke checks, 40 unit tests.

## 0.17.0

Persistent AI context and install hygiene.

- AI conversation history is stored in `<userData>/ai-history.json` and restored on
  launch, so follow-ups still work after a restart; Clear context wipes both.
- `npm run install-check`: silent install → run the full smoke suite against the
  installed binary → silent uninstall → assert the program directory and registry entry
  are gone while the user-data directory survives.
- 67 smoke checks, 40 unit tests.

## 0.16.0

Readable failures and release notes.

- Write failures are classified from errno and explained in the UI language
  (permission, disk full, missing path, file busy, path too long) instead of showing a
  raw Node error; the raw code stays in the detail and the log.
- `npm run notes` writes `release/RELEASE_NOTES.md` from the current CHANGELOG section.
- 65 smoke checks, 40 unit tests.

## 0.15.0

Settings portability and a release gate.

- File → Export / Import Settings. The AI key is never written to the file: the
  encrypted blob is machine-bound and a shared settings file must not carry a secret.
- `npm run release-check`: build → package → packaged smoke → packaged crash recovery →
  portable launcher start, in one command.
- Portable launcher verified to start the application (its stdio is detached, so the
  smoke suite cannot drive it; the check asserts the process starts).
- 65 smoke checks, 36 unit tests.

## 0.14.0

Large-document gate and AI retry.

- Performance gate for a ~57k-character document: load, serialize and a single
  keystroke must stay under 6 s / 3 s / 400 ms (measured 109 ms / 14 ms / 3 ms).
- AI Retry re-runs the last instruction against the current selection, so a paragraph
  can be regenerated without retyping the prompt.
- 63 smoke checks, 36 unit tests.

## 0.13.0

Complete i18n and export templates.

- Palette commands, statistics rows, shortcut help and AI presets are localized; the
  smoke suite pins its UI language so assertions stay stable.
- Export templates: Default / Compact / With table of contents. The TOC links to the
  rendered heading anchors and breaks onto its own page when printing.
- 61 smoke checks, 36 unit tests.

## 0.12.0

Interface language.

- i18n skeleton with English and 简体中文 dictionaries shared by the main process and
  the renderer (`src/i18n.js`).
- Language selector in Settings; defaults to the system locale on first run and rebuilds
  the application menu immediately.
- Localized surfaces: menus, save/close/update dialogs, top bar, empty guide, settings,
  AI panel and palette placeholder.
- 59 smoke checks, 36 unit tests.

## 0.11.0

Recent files and paste transparency.

- File → Open Recent keeps up to 10 files that still exist, with Clear Recent; opening
  or saving a document records it.
- Pasting rich HTML now reports how many unsupported elements were dropped, instead of
  silently simplifying the content.
- 58 smoke checks, 28 unit tests.

## 0.10.0

AI follow-ups and document statistics.

- AI conversations keep the last four exchanges, so follow-ups like "make it shorter"
  refine the previous answer. A Clear context button resets them.
- Document statistics panel (palette → Document Statistics): words, characters,
  no-space characters, paragraphs, headings, images and estimated reading time.
- 56 smoke checks, 28 unit tests.

## 0.9.1

Two real defects caught by the new checks.

- Opening a file no longer marks it dirty: the editor's own serialization is adopted as
  the clean baseline (`doc:normalize`), so whitespace normalization from the markdown
  round-trip no longer triggers an immediate autosave rewrite.
- The crash-recovery harness no longer races the asynchronous `doc:loaded` event, which
  could overwrite the test edit and write a draft of the unmodified file.
- 54 smoke checks, 28 unit tests.

## 0.9.0

First-run and tab-strip polish.

- Empty documents show a guide card: New document / Open a folder / Try AI writing,
  hidden as soon as there is content or a panel is open.
- Tab strip gains scroll arrows that only appear when the tabs actually overflow, with
  the active tab scrolled into view.
- 53 smoke checks, 28 unit tests.

## 0.8.0

Failure paths and AI review.

- Save failures are explicit: the buffer stays dirty, a banner explains the error with
  Retry, and a manual save offers Retry / Save As / Cancel. The write is never reported
  as successful when it was not.
- AI suggestions can be reviewed as a word-level diff against the selection before
  applying (`src/diff.js`, bounded LCS with a size fallback).
- 51 smoke checks, 28 unit tests.

## 0.7.0

Stability evidence.

- Crash-recovery test (`npm run crash`): the app writes a draft, is SIGKILLed, then
  restarted against the same profile; the next launch must offer the draft back and
  show the recovery banner. Works in dev and against a packaged binary.
- Performance guard in the smoke suite: a 7.5k-character document loads in ~28 ms and
  serializes in ~5 ms; the check fails if it regresses past 3 s / 2 s.
- Rapid tab switching stress check (10 switches, exactly one active tab at the end).
- Tab strip stays scrollable with stable widths.
- 47 smoke checks, 22 unit tests.

## 0.6.0

Updates and polish.

- Update checks through `electron-updater` with a generic feed: Help → Check for Updates.
  Downloading/installing stays off — that needs a signed release pipeline — but the
  check, version comparison and error paths are wired and tested against a local feed.
- `publish` config so packaged builds carry `app-update.yml`.
- Dark theme now swaps in a real highlight.js dark palette instead of filtering colors.
- Drag a `.md`/`.markdown`/`.txt` file onto the window to open it in a tab.
- 45 smoke checks, 22 unit tests.

## 0.5.0

AI writing, properly packaged.

- Streaming AI output (SSE) with a working Stop button and cancellation through an
  AbortController per request.
- Six presets: Continue, Tighten, Translate → EN, Translate → 中文, Summarize, Table.
- Command palette (Ctrl+Shift+P) with filter and keyboard navigation.
- Shortcuts help (F1) and an empty-document hint.
- 43 smoke checks, 22 unit tests.

## 0.4.0

Packaging and distribution.

- electron-builder pipeline: NSIS installer (per-user, changeable install dir, desktop
  shortcut, `.md`/`.markdown` file association) and a portable single exe, both x64.
- Generated app icon (dependency-free PNG/ICO writer in `scripts/make-icon.js`).
- Build-only dependencies (Tiptap, lowlight) moved to `devDependencies`; the renderer is
  bundled, so the installed package only ships what the main process needs at runtime.
- Help → About shows the app, Electron, Chromium and Node versions and the data folder.
- The smoke suite can target a packaged binary (`MDPAD_SMOKE_BIN`) and passes against
  both the unpacked build and a real installer installation.
- 38 smoke checks, 19 unit tests.

## 0.3.0

Configuration and secrets.

- Settings modal (⚙ / Ctrl+,): theme, autosave interval, and the AI endpoint/model/key in
  one place.
- API keys are encrypted with the OS credential store (`safeStorage` → DPAPI/Keychain/
  libsecret). If the store is unavailable the key is only base64-wrapped, and both the
  settings panel and the log say so.
- Autosave interval is configurable (1–60 s) instead of a fixed 5 s.
- Status bar now shows the caret position (`Ln, Col`) next to word/line/char counts.
- 38 smoke checks, 19 unit tests.

## 0.2.0

Reliability and the first AI feature.

- Session restore: tabs, active document, tree root and window bounds persist to
  `<userData>/session.json` and come back on launch; vanished files are skipped.
- Close guard: a dirty window asks before closing and keeps buffers as recovery drafts.
- Diagnostics: uncaught exceptions, renderer errors and crashed processes append to
  `<userData>/logs/mdpad.log`; File → Show Logs Folder.
- AI writing (Ctrl+J): instruction + selection + document context sent to any
  OpenAI-compatible `/chat/completions`, result inserted or replacing the selection.
- Smoke runs now use an isolated profile and are driven by `scripts/smoke.js`.
- 35 smoke checks, 19 unit tests.

## 0.1.0

- WYSIWYG editing on Tiptap, formatting toolbar, tables, code highlighting, KaTeX,
  image sizing, outline, find/replace, three themes.
- Tabs, multiple windows, file tree.
- Atomic saves, backup rotation, crash drafts, external-change detection.
- HTML / PDF / Word / EPUB export.
