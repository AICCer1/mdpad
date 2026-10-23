# Changelog

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
