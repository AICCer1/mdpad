# mdpad

A WYSIWYG markdown editor for Windows, built on Tiptap (ProseMirror) with a
crash-safe save pipeline: atomic writes, timestamped backup rotation, debounced
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
| Editing | find with a bounded match list; WYSIWYG markdown: headings, lists, tables (Tab in the last cell appends a row), code with highlighting, KaTeX math (centred display blocks, hover cue, live preview, click-to-edit), Mermaid diagrams that replace their fence and open for editing on click (Esc previews again), images with size/alignment, task lists, pasting a URL over a selection links it, Ctrl+click opens links in the browser (a plain click just places the caret) |
| Files | drag-reorderable tabs with per-tab undo history (Ctrl+T, reopen with Ctrl+Shift+T), command-line files opened as tabs, multiple windows (Ctrl+Shift+N), lazy file tree (Ctrl+K), recent files, multi-window session restore with truncation notice and crash-loop protection |
| Safety | atomic save with a transient-lock retry, 20-version backup rotation with one-click restore, crash drafts with relative age, a recovery panel with per-draft delete and confirmed cleanup, read-only protection, save-failure recovery with Retry, close guard |
| Export | one panel for format, template, document font, page margins and file name, with a page sketch and a live summary before writing; HTML, PDF (page numbers, verified to paginate), Word and EPUB with their document parts opened and checked; default / compact / table-of-contents templates with a live thumbnail, optional custom CSS, in-app preview with zoom and Esc-to-close that follows the editor theme, an Open / Show-in-folder prompt after each export, word/character footer, name template |
| AI | Ctrl+J panel against any OpenAI-compatible endpoint; presets, streaming with a self-scrolling result box, Stop, word-level diff review, Retry, persistent context that expires after 30 days, token guard before expensive requests, failure cooldown, local usage log with CSV export reachable from the panel, connection test, a scrolling AI settings pane with the key under the endpoint and a Clear button, endpoint normalisation (a bare host is retried against /v1), custom style guidance, history chips with arrow-key navigation, insert as inline text or a new paragraph, replace the current paragraph, scrolls into view, selectable context scope that is remembered and never auto-narrows once chosen, large-export warning |
| Polish | one design scale for control heights, radii and motion; toolbar active states, a tab indicator, one stroke icon set across the chrome (no emoji), thin theme-aware scrollbars, file-tree rows with relative modification times, an action-first empty tree, an outline that counts headings and marks the section holding the caret, sidebar and outline hover/active states, a composed empty state, visible focus rings, a theme-swap transition guard and prefers-reduced-motion support; window minimum size, responsive AI panel (readable scope control, scroll-hinted presets) and sidebars, consistent SVG toolbar icons grouped by purpose, command palette with shortcuts, match highlighting and usage ranking, recent files, shortcut help, first-run guide (dismissible for good), collapsible Export/AI/Usage settings sections whose state is remembered, a filter that matches section names, with an unsaved-changes hint, a live export-name example and labelled history chips, WCAG contrast audit per theme, theme-aware overlay shadows, focus mode (View menu, Ctrl+Shift+K) that dims everything but the current block, including lighting a whole table from a cell, adapts to the theme and works with find, a Saving…/Saved/Unsaved indicator with separated status items, statistics with selection size and last-saved time, light/dark/sepia themes with ten editor fonts, three text widths and four accent colours, five typography presets (Book, Report, Minimal, Technical, Chinese) that set the three together, an Aa toolbar button and palette entry that open Appearance directly, a collapsible file tree that keeps a rail, F11 full screen that Esc exits, localised table/image bars, light/dark/sepia themes, English and 简体中文 |

## Quality gates

```
npm test              142 unit tests
npm run smoke         226 end-to-end checks (dev or packaged)
npm run crash         SIGKILL -> restart -> draft recovery
npm run restart-check clean quit -> relaunch -> two windows and their tabs restored
npm run release-check build -> package -> packaged smoke -> crash -> portable
npm run install-check install -> smoke installed app -> uninstall -> clean
npm run ship          release-check -> installers -> install-check -> SHA256SUMS
```

Current artifacts: `release/mdpad Setup <version>.exe`, `release/mdpad <version>.exe`,
`release/latest.yml`, `release/RELEASE_NOTES.md`.

## Known limitations

- **The installer is unsigned** — SmartScreen warns, and update download/install is
  disabled until releases are signed and a feed exists (checks work).
- The API key is encrypted via the OS credential store; on systems without one it
  degrades to base64 wrapping, and Settings says so.
- Markdown round-trip covers the modeled nodes; raw HTML blocks and footnotes are not
  modeled, so exotic documents may normalize on first save.
- Word and EPUB embed local images; both leave remote image URLs as alt text.
- Table cell alignment is a view and export setting: markdown tables only describe column
  alignment, so per-cell `text-align` is kept in the editor and in HTML/PDF exports but not in
  the `.md` file.
- Mermaid diagrams are embedded as SVG in HTML, PDF and EPUB exports. Word (.docx) still keeps
  the fenced source, because the Word writer needs a raster image and converting SVG to PNG is a
  separate piece of work.
