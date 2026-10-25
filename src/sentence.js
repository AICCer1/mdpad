'use strict';

// Sentence bounds inside a single block of text. Kept pure so the rules can be tested without an
// editor: the highlight is only useful if it ends where a reader thinks the sentence ends.

const TERMINATORS = new Set(['.', '!', '?', ';', '。', '！', '？', '；']);
// CJK sentences do not put a space after the terminator, so they end there directly.
const CJK_TERMINATORS = new Set(['。', '！', '？', '；']);
const CLOSERS = new Set(['"', "'", ')', ']', '”', '’', '）', '】', '»']);

// An abbreviation ends with a dot but does not end the sentence.
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'e.g', 'i.e', 'fig', 'no', 'inc', 'ltd', 'co',
]);

function isAbbreviation(text, dotIndex) {
  let start = dotIndex;
  while (start > 0 && /[A-Za-z.]/.test(text[start - 1])) start -= 1;
  const word = text.slice(start, dotIndex).toLowerCase();
  if (!word) return false;
  return ABBREVIATIONS.has(word) || /^[a-z]$/.test(word);
}

function sentenceBounds(text, offset) {
  const source = String(text || '');
  const at = Math.max(0, Math.min(source.length, Number(offset) || 0));

  // Walk back to the start: a terminator followed by whitespace, or the beginning of the block.
  let start = 0;
  for (let i = at - 1; i >= 0; i -= 1) {
    const ch = source[i];
    if (!TERMINATORS.has(ch)) continue;
    if (ch === '.' && isAbbreviation(source, i)) continue;
    let next = i + 1;
    while (next < source.length && CLOSERS.has(source[next])) next += 1;
    // a terminator at the very end does not start a new sentence after itself
    if (next < source.length && (CJK_TERMINATORS.has(ch) || /\s/.test(source[next]))) {
      start = next;
      while (start < source.length && /\s/.test(source[start])) start += 1;
      break;
    }
  }

  // Walk forward to the end: the first terminator that is followed by whitespace or the end.
  let end = source.length;
  for (let i = Math.max(at, start); i < source.length; i += 1) {
    const ch = source[i];
    if (!TERMINATORS.has(ch)) continue;
    if (ch === '.' && isAbbreviation(source, i)) continue;
    let after = i + 1;
    while (after < source.length && CLOSERS.has(source[after])) after += 1;
    if (CJK_TERMINATORS.has(ch) || after >= source.length || /\s/.test(source[after])) {
      end = after;
      break;
    }
  }

  while (start < end && /\s/.test(source[start])) start += 1;
  while (end > start && /\s/.test(source[end - 1])) end -= 1;
  if (end <= start) return null;
  return { from: start, to: end, text: source.slice(start, end) };
}

module.exports = { sentenceBounds };
