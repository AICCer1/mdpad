# mdpad 2.0

2.0 is the version where the long-document tools stopped being separate features and started
working together: folding, the outline, word counts, section export and the command palette all
read the same document state.

## What is new since 1.0

- **Command palette**: prefix-first ranking that learns from keyboard use, a "Recently used" group,
  document headings as jump targets, recent files with folder hints, and an empty state.
- **Settings**: search by field label with highlighted hits, folding that survives a search, and a
  keyboard model (↓/↑, Enter, Escape clears before it closes).
- **Long documents**: heading folds in the editor and the outline share one state and survive a
  restart; outline rows carry per-section word counts and the number a fold hides.
- **Exports**: a range switch (whole document / current section), section export that skips fenced
  code correctly, statistics export as CSV and Markdown, and link/image audits before shipping.
- **Reliability**: external changes are detected even when `fs.watch` goes quiet; a broken backups or
  drafts folder degrades to a warning instead of blocking a save; a half-written export removes
  itself; crash drafts are recovered into their own tabs.
- **First run**: a walkthrough, three one-time tips that never return, and an upgrade check that
  proves a reinstall keeps the profile.

## How it is verified

- `npm test` — unit tests for the pure logic (markdown, exports, CLI, encoding, storage, writing).
- `npm run smoke` — end-to-end checks driving a real window (338 at this version).
- `npm run ship` — release check, crash recovery (three scenarios), first-run walkthrough, restart,
  install/uninstall and upgrade, then the installer and checksums.

## Known limitations

- The installer is unsigned: SmartScreen warns, and automatic updates stay off until releases are
  signed and a feed exists (the checks themselves work).
- Word lists export as `• ` paragraphs, not Word numbering; table cell widths and alignment are
  editor-only; DOCX keeps Mermaid source instead of a rendered diagram.
- Folding is a view state: it is remembered per document in settings, not written into the markdown.

## Getting it

Download `mdpad Setup 2.0.0.exe` (installer) or `mdpad 2.0.0.exe` (portable) from the release page,
and check `SHA256SUMS.txt` if you want to verify the download.
