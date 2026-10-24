# Performance

Measured with `npm run perf` (`electron . --perf-report`), which builds the document, drives the
real editor and writes `mdpad-perf.json` next to the exported files. Numbers come from one run on
the development machine; the point is the order of magnitude and the guard, not a benchmark score.

## The document

| Property | Value |
| --- | --- |
| Words | 14 091 |
| Markdown size | 74 KB |
| Structure | 60 sections, 240 paragraphs, a 20-row table, display math, a JS code block, a Mermaid diagram, images |
| ProseMirror nodes | 71 521 |

## Results

| Operation | Time |
| --- | --- |
| Open / `setMarkdown` | **194 ms** |
| Outline rebuild (61 headings) | **6 ms** |
| Find (5 matches) | **< 1 ms** |
| Typing, per keystroke | **4.8 ms** |
| Undo, 10 steps | **13 ms** |
| Export PDF (226 KB) | **484 ms** |
| Export HTML (462 KB) | **11 ms** |
| Renderer heap after load | **~40 MB** |

Typing was **9.3 ms** per keystroke before the fix below.

## What was slow, and the fix

Every transaction used to rescan the whole document twice: once to count words and characters for
the status bar, once to rebuild the outline. In a 14k-word file that is the dominant cost of a
keystroke.

- The word/character count is now debounced (250 ms trailing); the caret line/column stays
  immediate.
- The outline rebuild is debounced (120 ms).

That halved the keystroke cost. Both are covered by `perf-long-doc` in the smoke suite:
41k+ characters, load under 3 s, outline under 500 ms, find under 400 ms, **under 16 ms per
keystroke** (one frame at 60 Hz).

## What this does not measure

- **Paint and compositing.** The smoke and report windows are hidden, where Chromium throttles
  rendering, so scroll smoothness cannot be measured there. Scroll offsets are handled by the
  compositor; what is measured is main-thread work.
- **Very large images.** Images are written as files under `assets/` and downscaled to 2200 px on
  insert, but a document that already contains many large embedded data URLs is limited by memory,
  not by this pipeline.
- **Cold start.** `npm run smoke` asserts `startup-time` separately (around 300 ms to first paint
  on this machine).

## Reproducing

```powershell
npm run perf
```

Prints one JSON object and writes `%TEMP%\mdpad-perf.json`, `mdpad-perf.pdf`, `mdpad-perf.html`.

## Trend log

`npm run perf-trend` runs the perf report and appends one row per run to
[perf-history.csv](perf-history.csv); `node scripts/perf-trend.js --show` prints the last rows
without measuring. The table shows the delta in ms per keystroke against the previous run, which is
the number most likely to drift as features are added.

Two measurements taken on the same machine are enough to see the noise floor (~0.15 ms here), so a
delta under about 0.3 ms is not a regression.
