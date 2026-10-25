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

// Sentence length across a document: the number writers actually argue about ("is this sentence too
// long?"), not a readability score.
function analyzeSentences(text, { limit = 40 } = {}) {
  const source = String(text || '').replace(/\r\n/g, '\n');
  const sentences = [];
  const paragraph = source.split(/\n{2,}/);
  for (const block of paragraph) {
    const flat = block.replace(/\s+/g, ' ').trim();
    if (!flat) continue;
    let rest = flat;
    let guard = 0;
    while (rest && guard < 500) {
      guard += 1;
      const bounds = sentenceBounds(rest, 0);
      if (!bounds) break;
      sentences.push(bounds.text);
      rest = rest.slice(bounds.to).trim();
    }
  }
  const wordsOf = (value) => (value.match(/\S+/g) || []).length;
  const counts = sentences.map(wordsOf);
  const total = counts.reduce((sum, value) => sum + value, 0);
  let longest = { words: 0, text: '' };
  for (const value of sentences) {
    const words = wordsOf(value);
    if (words > longest.words) longest = { words, text: value };
  }
  const long = sentences
    .map((value) => ({ words: wordsOf(value), text: value }))
    .filter((entry) => entry.words > limit)
    .sort((a, b) => b.words - a.words)
    .slice(0, 10);
  return {
    count: sentences.length,
    avgWords: sentences.length ? Math.round((total / sentences.length) * 10) / 10 : 0,
    longest,
    long,
    limit,
  };
}

module.exports = { sentenceBounds, analyzeSentences };
