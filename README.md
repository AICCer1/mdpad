# mdpad

A WYSIWYG markdown editor for Windows, built on Tiptap (ProseMirror) with a
crash-safe save pipeline: atomic writes with a leading-edge draft (the first change of a burst hits disk immediately, plus flushes on blur, quit and sleep), timestamped backup rotation, debounced
autosave, crash-draft recovery, tabs, a file tree, and AI writing.

- [User guide](docs/USER_GUIDE.md) — editing, exports, AI setup, shortcuts, troubleshooting
- [Development and release](docs/DEVELOPING.md) — architecture, tests, packaging, platform notes
- [Signing and updates](docs/RELEASING.md) — certificate, update feed, release checklist
- [Changelog](CHANGELOG.md)

## Quick start

```bash
npm install
npm start
```

Or install the built artifact: `release/mdpad Setup <version>.exe`.

## What it does

| Area | Summary |
| --- | --- |
| Editing | find with a grouped bar (search field, counter, replace field, icon navigation) and a bounded match list; WYSIWYG markdown with a `/` block menu (headings, lists, table, image, math, divider, diagram): headings, lists, tables (resizable columns, a drag grip that reorders rows, a right-click cell menu with row move and header toggle, Tab in the last cell appends a row), code with highlighting, KaTeX math (centred display blocks, hover cue, live preview, click-to-edit), Mermaid diagrams that replace their fence and open for editing on click (Esc previews again), images with size/alignment and a corner handle that resizes them by dragging, task lists, pasting a URL over a selection links it, Ctrl+click opens links in the browser (a plain click just places the caret) |
| Files | drag-reorderable tabs with per-tab undo history and scroll position, a tab right-click menu (close, close others, close to the right, copy path, show in folder) and Ctrl+Tab cycling (Ctrl+T, reopen with Ctrl+Shift+T), command-line files opened as tabs, multiple windows (Ctrl+Shift+N), lazy file tree (Ctrl+K), recent files, multi-window session restore with truncation notice and crash-loop protection |
| Safety | atomic save with a transient-lock retry, 20-version backup rotation with one-click restore, crash drafts with relative age, a recovery panel with per-draft delete and confirmed cleanup, read-only protection, save-failure recovery with Retry, close guard |
| Export | one panel for format, template, document font, page margins and file name, with a real rendered page thumbnail (not a sketch) and a live summary before writing; HTML, PDF (page numbers, verified to paginate), Word and EPUB with their document parts opened and checked; default / compact / table-of-contents templates with a live thumbnail, optional custom CSS, in-app preview with zoom and Esc-to-close that follows the editor theme, an Open / Show-in-folder prompt after each export, word/character footer, name template |
| AI | Ctrl+J panel ordered target → instruction → suggestions → result → actions, with a target chip and a highlighted range that answer "what will this act on?", a quoted preview of the target text, and an Undo action in the toast after every AI edit; against any OpenAI-compatible endpoint; presets, streaming with a self-scrolling result box, Stop, word-level diff review, Retry, persistent context that expires after 30 days, token guard before expensive requests, failure cooldown, local usage log with CSV export reachable from the panel, connection test, a scrolling AI settings pane with the key under the endpoint and a Clear button, endpoint normalisation (a bare host is retried against /v1), custom style guidance, history chips with arrow-key navigation, insert as inline text or a new paragraph, replace the current paragraph, scrolls into view, selectable context scope that is remembered and never auto-narrows once chosen, large-export warning |
| Workspace | split a saved document into two real windows tiled on the two halves of the display (View menu, palette, Ctrl+Alt+2) and merge them back with the original window size (Ctrl+Alt+1), each window editing the same file with its own scroll position |
| Polish | one design scale for control heights, radii and motion; toolbar active states, a tab indicator, one stroke icon set across the chrome (no emoji), thin theme-aware scrollbars, file-tree rows with relative modification times, a right-click menu to create, rename and delete files and folders (with confirmation), an action-first empty tree, an outline that counts headings and marks the section holding the caret, sidebar and outline hover/active states, a composed empty state, visible focus rings, a theme-swap transition guard and prefers-reduced-motion support; window minimum size with a narrow layout (sidebars shrink, export shortcuts leave the top bar, the toolbar fades to show it scrolls), responsive AI panel (readable scope control, scroll-hinted presets) and sidebars, consistent SVG toolbar icons grouped by purpose, command palette with shortcuts, match highlighting and usage ranking, recent files, shortcut help grouped by area, statistics with aligned tabular numbers, a backup list with relative ages and sizes, a drafts panel with per-row restore and delete, first-run guide (dismissible for good), collapsible Export/AI/Usage settings sections whose state is remembered, a filter that matches section names, with an unsaved-changes hint, a live export-name example and labelled history chips, WCAG contrast audit per theme, theme-aware overlay shadows, focus mode (View menu, Ctrl+Shift+K) that dims everything but the current block, including lighting a whole table from a cell, adapts to the theme and works with find, a Saving…/Saved/Unsaved indicator with separated status items, a zoom indicator with Ctrl+= / Ctrl+- / Ctrl+0, a spelling checker toggle with native suggestions on right click, statistics with selection size and last-saved time, light/dark/sepia themes plus **Follow system** (live), Esc closing every dialog and returning focus to the editor, ten editor fonts, three text widths and four accent colours, five typography presets (Book, Report, Minimal, Technical, Chinese) that set the three together, an Aa toolbar button and palette entry that open Appearance directly, a collapsible file tree that keeps a rail, F11 full screen that Esc exits, localised table/image bars, light/dark/sepia themes, English and 简体中文 |

## Templates have a manager

Settings → Advanced → **Manage templates…** lists every custom template with its first line, and can
rename or delete them in place. Renaming keeps the content and refuses to overwrite an existing name.

## Templates can be inserted

**Insert template…** puts a template at the caret in the current document, formatted as real headings and
lists rather than literal markdown. It reuses the same built-in and custom templates and the same
variables; only the target differs.

## Templates take variables

Template bodies understand `{date}`, `{time}`, `{title}` and `{cursor}`: the first three are filled at
creation, the last one is removed and the caret lands there. **Unknown placeholders are left alone** —
`{project}` stays `{project}` instead of disappearing.

## Your own templates are files

**Save document as template…** writes the current document to `templates/<name>.md` in the profile;
custom templates appear in the same chooser as the built-in ones and can be deleted with the × on their
row. They are plain markdown, so they can be edited or copied between machines.

## Start from a skeleton

**New from template…** in the palette offers a weekly report, meeting notes and a long-form skeleton
next to a blank document. The bodies are a tested module, localised, and the date is filled in; the
result is an untitled tab, so saving still asks where to put it.

## Reports have a memory

Saving a structure report stores its metrics; the next report shows **chips with the change** (words,
average sentence, passives, repeated words) and names what went up. The markdown report carries the
same comparison as a "Trend vs previous report" section.

## Report options

The structure report can leave out **style hints** or **repetition**, and the **sentence limit** is a
setting (8–120, default 40). The choice is remembered and the payload simply does not contain what is
switched off.

## Style hints

The structure report flags **hedge words** (`very`, `really`, `quite` …) with counts and **possible
passive constructions** ("was written", "was quickly made"), skipping adjectival forms like "was
tired". Hints, not verdicts — the writer decides.

## Repetition is reported

The structure report lists words used three or more times, words repeated back to back
("very very"), repeated three-word phrases and repeated Chinese bigrams — the mechanical half of an
editing pass.

## Sentence length is measured

The statistics panel shows sentence count, average sentence length and the longest sentence; the
structure report lists sentences over 40 words with their text. Headings, code and link syntax are
stripped first, so the numbers describe prose.

## Highlight only the sentence

Besides the soft paragraph highlight there is a sentence highlight: the sentence under the caret, with
CJK terminators, closing quotes and abbreviations (`Dr.`, `J. K.`) handled by a tested pure helper.

## PDF printing scales almost linearly

A scaling benchmark (`--bench-pdf`) prints 0.5, 1, 2 and 4 MB documents and shows print time growing
slightly faster than size (2.0× → 2.5× per doubling). Splitting into batches and merging was measured
against that and rejected — at most 20% at 4 MB, in exchange for a merge dependency and broken page
numbering. Two fixes came out of it: unique print temp files and a load retry.

## PDF page numbers are optional

PDF export now reports its phases (build, write, load, print), and the measurement showed that
printing is 81% of a 2 MB export with the footer costing 14% of it. **Page numbers** is therefore a
setting: on by default, off for anyone exporting a very large document who does not need them.

## Window bounds survive monitor changes

A saved window position is re-fitted against the displays that actually exist: a window from an
unplugged monitor is moved into a real work area (keeping its size), a window larger than the screen
is shrunk to fit, and a title bar that would sit off-screen comes back where it can be grabbed.

## A vanished tab is reported

If a file behind a restored tab has been deleted, the tab still cannot reopen — but the app now says
so ("2 tabs were not reopened: notes.md, plan.md") instead of dropping it silently. Maximised windows
are restored as maximised, and the caret travels across restarts.

## Tabs reopen where you were reading

Each tab records its caret offset and scroll position; `session.json` carries them and reopening a
long document puts the caret back where it was instead of at the top.

## Recent exports are remembered

The export panel lists the last exports with their format and age; clicking one opens it, and an
entry whose file has been moved says so instead of failing silently. The list can be cleared and
holds at most ten entries.

## Every export ends with the same three actions

A finished export offers **Open**, **Show in folder** and **Copy path** — for documents, sections,
statistics and structure reports alike. Each action reports its own failure (missing file, locked
folder) instead of looking like success.

## The export panel chooses a range

The export panel now has **Range: Whole document / Current section**, so a section export no longer
lives only in the palette. The section button shows which heading it will use, refuses politely when
the caret is not in a heading, and every format follows the same range.

## A section can be exported on its own

The palette has **Export section as HTML** and **Export section as PDF**: the heading at the caret and
everything under it are exported as a standalone document, so a chapter can be sent without the rest.
Fenced code is skipped when finding the section end, so a `## ` line inside a fence cannot split it.

## The outline counts words

Every outline row shows how many words sit under that heading, and a folded row shows how many the
fold is hiding. Long sections become visible at a glance, without selecting them in the document.

## The outline and the editor share one fold state

Folding a section in the outline hides it in the editor too, and folding from the editor updates the
outline. Both use the same keys and the same per-document persistence, so the outline keeps its
folds across restarts — before this it forgot them every time.

## Headings fold in the editor

**Ctrl+Shift+H** (View menu, palette) folds the heading at the caret: its section hides, the heading
gets a `▸` marker, and the fold is remembered **per document** in settings — reopening the file
restores it. The markdown itself is untouched, so folding never changes what gets saved or
exported.

## Statistics export as CSV and Markdown

The statistics panel can write the document counts, the structure issues and the **last 14 days** of
writing as CSV (one metric per row) or Markdown (a readable summary with a table). Both are built
from the same data the panels show, so they cannot disagree with the UI.

## Hints are shown once

Three short tips (palette, shortcut list, dropping an image) appear in a strip above the editor,
**once per profile**: dismissing one stores it in `seenHints` and the next tip takes its place until
the queue is empty. Returning users never see them again.

## Shortcuts list matches the real bindings

The help panel was wrong in several places (it listed Ctrl+Shift+P twice and Ctrl+K as "open
file"). It is rebuilt from the actual menu accelerators and renderer handlers, has a filter box, and
each runnable row has **Run** — the list is a reference *and* an entry point. A check fails if a row
points at a command that does not exist.

## The palette shows what it remembers

With nothing typed, the commands you run appear under a **Recently used** heading. Settings →
Advanced shows how many commands are remembered and can **Clear** them, so the learned order is
visible and reversible.

## Headings are palette targets

The palette lists the current document's headings (first three levels, up to twelve) with their
level as the hint: typing "intro" and pressing Enter puts the caret in that heading. Recent files
now carry ids and folder hints, so they rank with the commands instead of sitting at the bottom.

## The palette learns from the keyboard

Commands rank by **prefix first**, then by how often you run them — and running one with Enter
now counts too (it used to only count clicks). Arrows wrap around the list, an empty search says
"No commands match.", and the active row is scrolled into view.

## Arrow keys walk the settings results

Down/Up move through the matching fields, **Enter** jumps to the control, and **Escape** clears the
query before it closes the panel — so a keyboard user can search, jump and edit without the mouse.

## Folding survives a search

Searching expands the section that holds a hit, and clearing the box puts the sections back the way
you left them — searching never costs the layout you chose.

## Settings search finds fields

The filter in Settings matches **field labels**, not just section names: several words all have to
match, a phrase like "writing goal" still finds "Daily word goal", hits are highlighted, and a
query with no matches says so. A self-check types every label and fails if any field hides itself.

## Copy is audited

`npm run copy-audit` checks both dictionaries: same keys, matching `{placeholders}`, no `...`
where `…` belongs, no stray whitespace, no Latin prose left inside Chinese text, and Title Case on
English menu labels (articles and the brand excepted). The rules run in `node --test`, so a
missing translation or a mismatched placeholder fails the build.

## Quality gates

```
npm test              unit tests (Node runner)
npm run smoke         354 end-to-end checks (dev or packaged)
npm run crash         SIGKILL -> restart -> draft recovery
npm run restart-check clean quit -> relaunch -> two windows and their tabs restored
npm run release-check build -> package -> packaged smoke -> crash -> portable
npm run install-check install -> smoke installed app -> uninstall -> clean
npm run ship          release-check -> installers -> install-check -> SHA256SUMS
```

Current artifacts: `release/mdpad Setup <version>.exe`, `release/mdpad <version>.exe`,
`release/latest.yml`, `release/RELEASE_NOTES.md`.

## First run

A blank untitled tab shows a four-step welcome checklist — start writing, open a folder, insert a
block, export — where each step performs the action rather than describing it ("Insert a block"
types `/` for you). It can be skipped for good, and **Help → Welcome guide** brings it back. An
empty *saved* file is never covered by it.

![Welcome checklist](docs/images/01-empty.png)

## Diagnostics

**Help → Copy diagnostics** (also in Settings) puts version, Electron/Chromium versions, paths,
settings summary and the last 60 log lines on the clipboard. No telemetry, no network: you paste it
into a report yourself. **Open log folder** shows the same file. The log path is
`<userData>/logs/mdpad.log`.

## Signing and updates

The build pipeline can sign: set `CSC_LINK` and `CSC_KEY_PASSWORD` (or run
`npm run cert` for a self-signed development certificate) and `npm run ship` signs the app,
installer and uninstaller, then *fails the build* if an artifact lost its signature. The
difference between "signed" and "trusted by Windows" is reported separately — a self-signed
signature is real but SmartScreen still warns. See [docs/RELEASING.md](docs/RELEASING.md).

### Links in exports

Exports keep links honest: a relative link whose file exists stays untouched, one that does not
is flagged (`data-link-missing`, wavy underline, "File not found" tooltip), anchors keep matching
heading ids, and absolute URLs become real hyperlinks in Word.

### Image audit

Remote images can be **downloaded next to the document** (into `images/`, named by content hash)
and their links rewritten to the local copy — one row at a time or all at once.

A panel lists every image with its kind (local, remote, embedded) and size, marks the ones whose
file is gone in red, and can remove them in one action — the document equivalent of checking that
nothing is broken before shipping.

## Images move by dragging

A dragged image lands between blocks, not at a pixel offset: the drop position is the document
coordinate under the pointer, a line shows the landing spot, and the move is one undo step.

## Tables that move

**Drag a row or column edge** to reorder it: grab the left edge of a cell to move its row, the top
edge to move its column, and a highlight line shows where it will land. The menu offers the same
moves without a mouse.

Right-click a cell to **move a row up/down or a column left/right**. Columns are rebuilt row by
row; merged cells make "the same column" ambiguous, so the action refuses instead of guessing.

### Link audit

The palette has **Link audit…**: every link with its kind (local, external, anchor) and whether
the target resolves. **Fix…** repoints a link at the right file, **Unlink missing** drops dead ones
while keeping the text, and only the dead link goes.
link goes.

## Links between files

`[text](other.md)` opens that file in a tab (relative to the current document, `.md` guessed when
omitted), `[text](#heading)` scrolls to the heading, and a missing target says so instead of
doing nothing. Ctrl+click still sends real URLs to the system browser.

## Recent files panel

**File → Show all recent files…** (or the palette) lists recent documents newest first with
their folder and age, removes entries, and clears the list. A file deleted behind the app's back
stays in the list marked **missing** instead of silently vanishing, and opening it says so.

## Jump history

**Alt+Left / Alt+Right** walk back and forward through the places you jumped from — an outline
click, a find step — per tab. A new jump truncates the forward stack, the way a browser does.

## Outline that folds

The outline panel folds sections (a twisty on any heading with children) and marks the heading at
the top of the viewport while you scroll, not only the one under the caret.

## Block handle

Hovering a block shows a handle in the gutter with a menu: **move up / down**, **duplicate**,
**delete**. Ctrl+Shift+↑/↓ moves the current block from the keyboard, and the caret stays at the same
offset inside the block that moved — one undo puts it back.

## Quotes and nesting

Nested quotes (`> >`) round-trip, a selection of several blocks becomes one quote, and **Tab** nests
a quote while **Shift+Tab** lifts it. Ctrl+] / Ctrl+[ do the same for lists and quotes without
stealing Tab from list indentation.

## Task lists

`- [ ]` and `- [x]` round-trip through the editor, clicking a box writes the new state back to the
markdown, and exports keep it: HTML and EPUB render real checkboxes, Word gets ☐ / ☑ because it has
no checkbox primitive here.

## Find and replace

Find with match case (**Aa**), whole word (**ab**) and regular expressions (**.***), toggled from the
bar or with Alt+C / Alt+W / Alt+R. Replace one or all; in regex mode the replacement expands
`## Typing and pasting markdown` and `$1…$9`. The whole batch is a single undo step, isolated from the typing that came before
it. Ctrl+H opens the bar in its replace field. Options are remembered.

## Typing and pasting markdown

Typing markdown converts as you go: `# `, `- `, `1. `, `> ` and fences are blocks, and
`**bold**`, `*italic*`, `~~strike~~`, ```code``` become marks on the closing delimiter.
Pasting **plain text that is clearly markdown** (a fence, a table rule, a heading with a blank line,
two or more list items) parses it; prose and a lone `#tag` stay literal.

## Typewriter mode

Settings → Appearance → **Keep the caret in the middle**: while you type, the view scrolls so the
caret line sits around 45% of the window, instead of drifting to the bottom edge.

## A failed export leaves nothing behind

All four formats are tested against a path whose parent is a file and against a path that is a
directory: each answers with an error, creates no file, and a **read-only existing file survives
the attempted overwrite untouched**. A partial file from a failed attempt is removed.

## Upgrades keep the profile

`npm run upgrade-check` installs the build, seeds a real profile (dark theme, Chinese UI, a session
with one open file and a recovery draft), launches the installed app and asserts it reads all of
it back — settings, restored tab and draft. It then **reinstalls over the same directory** and
verifies the profile files are byte-for-byte unchanged.

## First run is a test

`npm run first-run` starts the app against an **empty profile** and walks the first minute: the
welcome card is visible, the editor exists, the profile is not yet onboarded, then a document is
created, saved, and exported — all asserted from the rendered state. It runs in `npm run ship`
against the packaged binary.

## Crash recovery is tested across tabs

The crash suite now runs three scenarios against a real SIGKILL: an explicit draft write, typing
120 ms before death, and **two dirty tabs** killed while the second is active — each draft must
hold its own file's text, not the active buffer.

## Closing a dirty tab

Closing a tab with unsaved text writes a recovery draft, says so in a toast and offers **Reopen**,
which restores **the buffer that was closed** — not whatever the file holds on disk now.

## External changes, your call

Settings → **When the file changes on disk** chooses **Ask me** (banner), **Reload automatically**
or **Ignore**. Automatic reload only applies to a clean buffer — unsaved edits always ask, so a
sync client can never quietly replace what you typed.

## Daily word goal

Settings → **Daily word goal** turns the status bar into `Today 620 / 800 words`. Only **positive**
word deltas are counted, so deleting text does not take back words already written; crossing the
goal raises one toast for the day.

## Writing history

Click the goal indicator (or the palette) for a 14-day bar chart with the streak and the best day;
bars are accent-coloured on days that met the goal. The rules live in `src/writing.js` and are
unit-tested: a gap stops the streak, a missing today does not punish writing late at night.

## Current paragraph highlight

Settings → Appearance → **Highlight the current paragraph** tints the block holding the caret with
an accent wash and a thin left rule. It steps aside when focus mode is on — that mode already dims
everything else — and the whole thing respects `prefers-reduced-motion`.

## Structure report

Structure issues can be fixed **in place**: **Fix** demotes a jumped heading to one level below its
predecessor, **Rename…** gives a duplicate heading a unique title, and **Split** breaks an over-long
paragraph at sentence boundaries (text preserved, one undo step). The report itself lists heading
jumps (H2 straight to H4), duplicate headings and paragraphs over 1200 characters, with the counts a
submission asks for. **Save report…** writes that as a markdown checklist (counts, issues, line numbers) next to the document, so a review can be archived or handed on. A second report carries the delta since the previous one ("previous report: 2 issues, now 0). A second report carries the delta since the previous one ("previous report: 2 issues, now 0 (−2)"), which turns the checklist into a record of work.

Heading issues are fixed in place too: **Fix** demotes a jumped heading to one level below its
predecessor, and **Rename…** gives a duplicate heading a unique title. The report is also
diagnosis: heading jumps (H2 straight to H4), duplicate headings and
over-long paragraphs, with a **Go** button that jumps to the heading and the counts a submission
asks for (words, headings, paragraphs, reading time, tables, images, links, tasks).

## Before you export

The export panel counts what is about to be written — words, headings, images, tables,
diagrams, formulas, tasks — and warns about images or links whose target is missing, so a
broken document is visible before the file is produced.

## Three export templates

**default**, **compact** (tighter spacing, narrow margins) and **with contents** (a linked table
of contents, localised, with page breaks before the body). Each has a rendered screenshot in
`docs/images/` so the typography can be reviewed without opening a PDF.

## Formats are checked against each other

One smoke check exports the same document as HTML, Word and EPUB and counts headings, tables,
images, code blocks, list items, bold/italic runs and links in each output, comparing them with the
source. Any format that silently drops a table or an image fails the suite.

## Export consistency

One document exported to HTML, PDF, Word and EPUB is checked block by block — heading, bold text,
table, image, maths, code and diagram — plus the order they appear in. EPUB chapters now carry a
visible `<h1>` (the title used to live only in `<title>`), and Word keeps a Mermaid block as its
source, which is stated in the known limitations instead of being papered over.

## Images

Pasted and dropped images are downscaled to 2200 px on the long edge and re-encoded in the smaller
of JPEG and PNG (JPEG for photos, PNG for screenshots of text), then written to `assets/` next to
the document. An 8.9 MB photo becomes about 110 KB with no visible loss at document size; the toast
reports the saving.

## Extracting old images

Documents written before the image pipeline can still carry pasted pictures as data URLs.
**File → Extract embedded images…** (also in the command palette) writes them into `assets/` and
rewrites the references, through a backup. It refuses while the document has unsaved changes, so it
can never destroy text you are still editing.

## Performance

A 14 000-word document opens in ~190 ms, rebuilds its outline in ~6 ms and costs ~4.8 ms per
keystroke; PDF export takes ~0.5 s. Measured with `npm run perf`; method and caveats in
[docs/PERFORMANCE.md](docs/PERFORMANCE.md).

## Advanced settings

Settings → **Advanced**: export preferences to JSON (never the AI key), import them back, open the
data folder, clear recovery drafts with a count, and reset every preference to its default —
documents, backups and drafts on disk are untouched.

## Concurrency

Opening a file that another window already shows focuses that window instead of creating a second
editor. If a file changes on disk (another window, another app, a sync client), a save refuses to
clobber it: the dialog offers **Overwrite**, and autosave stays dirty instead of pretending to
save. Saving is never silent about losing someone else's work.

## Keyboard and screen readers

The tab strip is a tablist: arrow keys move and activate, Home/End jump, Delete closes, and exactly one tab is selected with a roving `tabindex`. Re-rendering the strip no longer drops the keyboard back to the page. The editor is a named textbox (`role="textbox"`, `aria-multiline`, a localised label) and the outline marks the section containing the caret with `aria-current="location"`, with `aria-expanded` on every foldable heading. Dialogs are real dialogs: `role="dialog"`, `aria-modal`, labelled by their title, and **Tab is
trapped inside** while one is open; Escape returns focus to the editor. Toolbar toggles expose
`aria-pressed`, and every icon button gets an accessible name from its tooltip.

## Multiple windows stay in sync

A settings change (theme, language, accent, typography, hidden file tree) is broadcast to every
open window, including the one that made it. Closing a window leaves the others editing normally.

## Recovery paths are verified

Restoring a backup and saving again is asserted end to end (the replaced version becomes the
next backup), and a recovery draft whose original file was deleted restores into a **new tab**
instead of overwriting whatever is open.

## When something goes wrong

When the backups folder cannot be written, saving still succeeds and a banner says **"Backups are off"** — protection degrades instead of blocking the save. A drafts folder that cannot be written raises a **persistent banner** ("Recovery drafts are off: <reason>") with a shortcut to the data folder; the next successful write clears it. A failed export answers with an error and shows a **Retry** banner instead of throwing into the
console. An unreadable `settings.json` is copied to `settings.json.corrupt-<timestamp>` before
the app continues with defaults, so a broken file is never overwritten silently.

## Typing in a large document stays fast

Off-screen blocks of documents over 200 KB skip layout and paint (`content-visibility`), and the
leading-edge change sync is skipped for them. On a 415 KB file that took a keystroke from
**~50 ms to ~4 ms** (measured by `large-doc-typing`, not eyeballed).

## Large documents load progressively

Above 128 KB a document is parsed and inserted in paragraph-aligned chunks with a yield between
them, so the window keeps painting and the wait is measurable: a 2 MB file went from **15.5 s to
7.2 s** on the reference machine, and the UI stays responsive throughout. `npm run perf-open`
measures it and records the result in `docs/perf-open.csv`.

## Performance is tracked, not remembered

`npm run perf-trend` appends a real measurement (ms per keystroke, outline, find, undo, PDF and
HTML export) to `docs/perf-history.csv`, so a regression shows up as a trend instead of a number
someone has to recall.

## Known limitations

- **The installer is unsigned** — SmartScreen warns, and update download/install is
  disabled until releases are signed and a feed exists (checks work).
- The API key is encrypted via the OS credential store; on systems without one it
  degrades to base64 wrapping, and Settings says so.
- Markdown round-trip covers the modeled nodes; raw HTML blocks and footnotes are not
  modeled, so exotic documents may normalize on first save.
- Word and EPUB embed local images; both leave remote image URLs as alt text.
- File operations are confined to the opened folder: names with separators, `..`, duplicates
  and paths outside the tree are refused by the main process, not only by the dialog.
- Column widths are editor-only: markdown has no syntax for them, so they are kept while the
  document is open and not written to the file.
- Table cell alignment is a view and export setting: markdown tables only describe column
  alignment, so per-cell `text-align` is kept in the editor and in HTML/PDF exports but not in
  the `.md` file.
- Mermaid diagrams are embedded as SVG in HTML, PDF and EPUB exports. Word (.docx) still keeps
  the fenced source, because the Word writer needs a raster image and converting SVG to PNG is a
  separate piece of work.
