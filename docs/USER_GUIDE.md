# mdpad — user guide

## Install and first run

Run `mdpad Setup <version>.exe` (per-user install, no admin rights) or the portable
`mdpad <version>.exe`. The first empty document shows a guide with three actions:
new document, open a folder, or try AI writing.

![First run](images/01-empty.png)

The first launch shows a one-time hint pointing at AI setup (Ctrl+J) and the update
check; dismiss it and it never returns. The empty-document card has its own × button: once
closed it stays closed, including on new empty tabs.

Settings shows **Unsaved changes** as soon as a field differs from what is stored, and
Cancel discards them, so it is clear whether Save is needed.

Section headings in Settings fold, and the folded state is remembered between visits.
The interface language follows your system locale on first run and can be changed in
Settings (⚙ or Ctrl+,).

![Settings](images/05-settings.png)

Overlays use a theme-aware shadow and border (a soft light-mode shadow turns into a grey
smudge on a dark page).

**Appearance.** Settings offers an editor font (serif, sans, monospace), a text width
(narrow 34 rem, normal 46 rem, wide 58 rem) and four accent colours; all three apply
immediately on save and are remembered.

**File tree.** The ◀ button in the Files header hides the tree and ▶ brings it back; the state
survives a restart.

**Tables.** Hover a table to get a small toolbar with add row, add column and the two delete
actions, so a table can be edited without visiting the bar. The bar above the editor carries the
same actions plus alignment (left, centre, right) for the selected cell. Alignment is a view
setting: markdown can only describe column alignment, so it survives in the editor and in
HTML/PDF exports but not in the .md file.

Settings groups its fields into **Export**, **AI writing** and **Usage**, each of which folds
and remembers its state.

Overlays (settings, palettes, popovers) use a theme-aware shadow and border: the soft light-mode
shadow turns into a grey smudge on a dark page, so dark mode gets a tighter, deeper shadow and a
brighter hairline instead.

Light, dark and sepia themes (body text keeps a WCAG AA contrast ratio in all three):

![Dark theme](images/06-dark.png)

## Editing

Formatting happens in place — there is no separate preview pane. The toolbar keeps one
stroke icon set (with tooltips and accessible labels) instead of platform-dependent glyphs,
and clusters them by purpose — text style, block style, lists, code, insert, math, AI.

![Editor](images/02-editor.png)

| Want | Do |
| --- | --- |
| Headings | type `## ` at the start of a line, or use the paragraph-style dropdown |
| Bold / italic / strike / code | toolbar buttons or the usual markdown shortcuts |
| Lists, quotes | `- `, `1. `, `> `, or the toolbar |
| Table | toolbar ▦ inserts 3×3; the context bar adds/removes rows and columns |
| Code block | toolbar `{ }`; the language dropdown writes the fence language |
| Math | toolbar `$x$` / `$$`, or type `$...$` / `$$...$$` directly; the popover previews as you type, and clicking a rendered formula reopens it for editing. Display math is centred with a hover highlight |
| Diagram | a fenced block with language `mermaid` renders below the code while you type; a broken diagram shows the error instead of hiding the code |
| Image | paste, drag a file in, or toolbar 🖼 |
| Link | toolbar 🔗; paste a URL over a selection to link it; Ctrl+click opens it in the browser, a plain click only places the caret |
| Move a block | Ctrl+Shift+↑ / ↓ |
| In a table | Tab moves to the next cell, Shift+Tab to the previous one |

Images are saved next to the document in `assets/`. Size and alignment are stored in
the markdown link title (`![alt](src "w=50%;align=center")`), so they survive a round
trip through any markdown tool.

## Files, tabs and windows

- **Ctrl+O** opens a file, **Ctrl+K** opens a folder (the tree shows it).
- `mdpad notes.md todo.md` (or dragging several files onto the exe) opens each file as a
  tab in the first window.
- Each tab keeps its own undo history: switching away and back, Ctrl+Z still steps back
  through that tab.
- **Ctrl+T** opens a tab, **×** closes it, **Ctrl+W** closes the current one,
  **Ctrl+Shift+T** brings back the last closed tab (buffer included). With many
  tabs open, scroll arrows appear on either side of the bar.
  Drag a tab onto another to reorder them; the order survives a restart. **Ctrl+Shift+N** opens a new window. Each
  window keeps its own tabs, tree root and timers.
- **File → Open Recent** lists up to 10 files that still exist.
- The session (tabs, active document, tree root, window size) is restored on launch
  after a normal quit or a crash;
  a toast says "Restored N tabs" so a restored session is never mistaken for lost work.
  If some tabs hit the limit (or their file disappeared), a second toast says how many
  were not restored — never silently.
  Restoring reopens up to 4 windows, 20 tabs each.
  At most 20 tabs and 5 untitled buffers are restored.

## Saving, backups, recovery

- Edits are drafted after ~0.6 s and autosaved after 5 s idle (configurable 1–60 s).
- Every save writes atomically (one short retry when antivirus or the indexer holds the
  file) and keeps the previous version in `backups/` (20 kept).
- The header shows the save state: **Unsaved** while there are edits, **Saving…** during a
  write, then **Saved HH:MM**. An untitled buffer stays at *Unsaved* because there is no file
  yet — it is not a failure.
- The status bar shows the backup count and the time of the newest backup. Click it for a
  restore list: choosing an entry loads that version into the editor as unsaved changes,
  so you can inspect it and save only if it is right.
- If the file cannot be written (permissions, read-only media), mdpad stops autosaving
  and says so; your text is kept, and Retry resumes once the permission is fixed.
- If a write fails, the buffer stays marked dirty and a banner explains why (permission,
  disk full, missing path, file busy) with a Retry action.
- If the app is killed, the draft is offered back the next time you open that file.
- Closing a window with unsaved buffers lists their names in the confirmation; either way the buffers are kept as
  drafts.

File → **Recover Drafts…** lists every recovery draft (name, time, size); choosing one
opens its file and loads the unsaved text, which you can then keep or discard.
The × on a row deletes just that draft (after a confirmation); each row also says how old the draft is ("25 min ago"), so a stale recovery is obvious.
**Clean up old drafts** removes drafts older than 30 days after a confirmation showing how
many will go.

Data lives in `%APPDATA%\mdpad`: `backups/`, `draftsRecover/`, `session.json`,
`settings.json`, `ai-history.json`, `logs/mdpad.log`.

## Export

HTML, PDF, Word (.docx) and EPUB, from the File menu. Word embeds local images at their
aspect ratio; EPUB copies them into the book and declares them in the manifest. Remote
image URLs stay as alt text in both. **File → Preview Export**
(Ctrl+Shift+V) opens the HTML result in a child window before you write a file. The preview says
that its page breaks may differ from the exported PDF, names the active template, and
has 75% / 100% / 125% zoom buttons in its header. Esc closes the preview. In dark or sepia theme the preview
follows the editor, while the exported file itself stays light so it prints predictably.

Settings also has **Preview export**, which saves the template and CSS you are looking at and
opens the same preview window, so styling can be judged before writing a file.

Settings → **Export file name** sets the suggested name; `{title}`, `{date}` and `{time}`
are substituted (default `{title}`), and a live example appears under the field as you type.

Settings → **Export template** chooses the layout; a hint under the selector describes the
chosen one, and a small thumbnail shows its page margins (plus a marker for the contents
page):

- **Default** — the normal document
- **Compact** — tighter margins and spacing
- **With table of contents** — a TOC linking to heading anchors, on its own page when
  printing

PDFs carry a footer with the document title and `page / total`, and HTML/PDF exports end
with a word/character count.

If an export ends up very large (over 20 MB), mdpad says so — usually a few camera
photos are the cause, and shrinking them keeps the file portable.

The settings panel has a filter box at the top — type part of a label to jump to it —
and section headings collapse when clicked.

Settings → **Custom CSS for exports** appends your own rules to HTML and PDF output
(e.g. a serif body font). `<style>`, `</style>`, `<script>` and `@import` are stripped,
so pasted CSS cannot inject markup.

## AI writing

Open the panel with **Ctrl+J**.

![AI panel](images/04-ai.png)

The AI header keeps a single row on narrow windows (Run stays text, Retry/Stop/settings are
labelled icons). The six presets stay on one horizontally scrollable row whose faded right edge hints that
more are available, so the panel keeps its height on
narrow windows.

Opened without an endpoint or key, the panel names what is missing, offers **Open AI
settings**, and keeps Run disabled until it is configured.

1. Pick a provider in Settings: DeepSeek, OpenAI, Ollama (local) or Custom, then enter
   the API key. Keys are encrypted with the OS credential store. **Test connection**
   pulls the model list from `/v1/models` when the gateway has it (so the name can be picked
   instead of typed), and verifies endpoint, model and key before you rely on them — a success shows the model name,
   latency and a sample reply, and a failure explains what to change (key, base URL, local
   server, timeout) instead of only relaying the raw error.
2. Choose the context scope — whole document, current paragraph, or selection only — so a
   long file does not get sent when one paragraph is enough. On documents over ~8k
   characters the panel suggests the paragraph scope, and over ~20k characters the request
   auto-narrows to the current paragraph (marked "auto") unless you picked a scope yourself.
3. Type an instruction (Ctrl+Enter runs it), or use a preset: Continue, Tighten, → English,
   → 中文, Summarize, Table. Pasting a very long instruction warns you before it becomes an
   expensive request. The panel shows how much document context will be sent, and says
   when it was trimmed, so nothing is silently dropped.
3. The answer streams in and its box scrolls on its own, so Run/Insert stay reachable while a
long rewrite arrives. **Copy** puts the result on the clipboard without touching the
   document. **Preview changes** shows a word-level diff against your selection.
   **Insert** puts the text at the cursor, **New paragraph** starts a fresh block first (so
   the result does not merge into the current paragraph), and **Replace selection** swaps
   your selection — or, with nothing selected, rewrites the paragraph the cursor is in.
   All three scroll the result into view. The panel narrows with the window, so it stays
   usable down to the 720 px minimum width.
4. **Retry** re-runs the last instruction against the current selection — handy for
   regenerating one paragraph.
5. The status line shows an estimated prompt/output token count. If it exceeds the
   confirm threshold in Settings (default 20000 tokens), the panel asks before sending.
6. The last four exchanges are remembered (and persisted, pruned after 30 days); chips under
   the panel bring an earlier result back into the boxes, arrow keys move between chips
   (Home/End jump to the ends), and the ⤓ button on a chip inserts that result into the
   document. "Make it shorter" therefore refers to the previous answer;
   **Clear context** forgets them.

Esc closes the panel and puts the caret back in the document.

 Stop releases the panel immediately and keeps whatever text already streamed.
Transient failures (connection drop, HTTP 429/5xx) are retried once automatically; the
status line says so while it happens, and shows elapsed seconds so a long request does
not look hung. After a hard failure the Run button pauses for a few seconds ("retry in
3s") so a misconfigured endpoint cannot be hammered. A request that already streamed text is never retried.

Nothing is inserted automatically; you always review first.

Settings → **Writing style guidance** appends your own instructions to the system
prompt (for example "keep sentences short"), applied to every request. Preset buttons
fill it with a concise, academic, marketing or friendly style.

Settings → **Usage** lists the last requests with estimated input/output tokens, duration
and model, so cost stays visible. **Export CSV** writes the log out for a spreadsheet.
The log itself is a local file (`ai-usage.jsonl`).

The statistics panel (Ctrl+Shift+D from the palette) shows word/character counts, the size
of the current selection, reading time and **Last saved**, which makes a stalled autosave visible at a glance.

Replace All applies every match in a single undo step and reports the count; if the search
hit the 2000-match cap it says so, so "replace all" never silently leaves matches behind.

The command palette (Ctrl+Shift+P) shows each command's shortcut and, with nothing typed,
puts the commands you run most often at the top (usage ranking is stored in settings). As
you type, the matching part of each command name is highlighted.

The outline column lists headings and jumps to them on click; while a document has no
headings it says "Headings will appear here" instead of showing an empty strip.

**Focus mode** (View → Focus mode, or Ctrl+Shift+K) dims every block except the one the
caret is in, which helps while drafting; the state is remembered between sessions. With the caret inside a table the whole table lights up. The dim
level adapts to the theme (32% light, 38% sepia, 45% dark) so faded text stays readable.

The ▤ button in the AI panel (or "Open AI usage log" in the palette) jumps straight to the
usage section of Settings, expanding it if it was folded.

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| Ctrl+N / Ctrl+T | New document / new tab |
| Ctrl+W | Close the current tab |
| Ctrl+Shift+T | Reopen the last closed tab |
| Ctrl+O / Ctrl+K | Open file / open folder |
| Ctrl+S / Ctrl+Shift+S | Save / save as |
| Ctrl+F | Find & replace |
| Ctrl+J | AI writing |
| Ctrl+, | Settings |
| Ctrl+Shift+P | Command palette (also lists recent files) |
| Ctrl+Shift+O | Toggle outline |
| Ctrl+Shift+N | New window |
| Ctrl+Shift+E / Ctrl+Shift+P | Export HTML / PDF |
| Ctrl+Shift+↑ / ↓ | Move the current block |
| F1 | Shortcut list |

Press Ctrl+Shift+P for the command palette:

![Command palette](images/03-palette.png)

Settings validates before saving: the endpoint must look like a URL, autosave must be
1–60 s and the token threshold must be within 0–500000 — errors appear in the panel.

## Troubleshooting

- **"The data folder is not writable"** — mdpad checked at startup and cannot create
  its probe file; saving will fail until permissions are fixed.
- **Narrow windows** — below 780 px the AI panel header wraps onto two rows and the side
  columns shrink to 150 px; nothing is hidden, so the Outline toggle still works.
- **Window will not shrink further** — the editor needs at least 720×480; a smaller saved
  size is enlarged on restore so the toolbar stays usable.
- **Window opens on a screen that no longer exists** — mdpad validates saved window
  bounds against connected displays and falls back to a visible position.
- **Two crashes in a row** — mdpad stops replaying the saved session (it is copied to
  `session.json.crashloop` first) and opens a clean window, so a bad session cannot trap you
  in a start-crash loop.
- **Recovery drafts waiting** — a badge in the status bar shows how many drafts exist and
  opens the recovery panel.
- **Something went wrong** — File → Show Logs Folder; `mdpad.log` records uncaught
  errors, renderer errors, save failures and AI request outcomes.
- **Migrating machines** — File → Export Settings writes a JSON file (never the API key,
  which is machine-bound). Import it on the new machine and re-enter the key.
- **Checking for updates** — Help → Check for Updates queries the configured feed.
  Download/install is disabled until releases are signed.
