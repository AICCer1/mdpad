'use strict';

// Repetition: the words a writer leans on too hard and the phrases that repeat themselves.
// Pure so the rules can be tested; the report only presents what this returns.

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can', 'had', 'her', 'was', 'one', 'our',
  'out', 'day', 'get', 'has', 'him', 'his', 'how', 'its', 'may', 'new', 'now', 'old', 'see', 'two', 'way',
  'who', 'boy', 'did', 'she', 'use', 'that', 'with', 'have', 'this', 'will', 'your', 'from', 'they',
  'know', 'want', 'been', 'good', 'much', 'some', 'time', 'very', 'when', 'come', 'here', 'just', 'like',
  'long', 'make', 'many', 'more', 'only', 'over', 'such', 'take', 'than', 'them', 'well', 'were', 'what',
  'into', 'then', 'than', 'these', 'also', 'because', 'would', 'could', 'should', 'there', 'their',
  'about', 'other', 'after', 'first', 'which', 'where', 'while', 'being', 'under', 'between', 'before',
  'through', 'during', 'without', 'again', 'against', 'above', 'below', 'each', 'every', 'both', 'few',
  'most', 'same', 'own', 'too', 'does', 'doing', 'done', 'said', 'says', 'say', 'went', 'made', 'much',
]);

const CJK_STOP = new Set(['的', '了', '是', '在', '和', '也', '就', '都', '而', '及', '与', '着', '或', '一个', '我们', '你们', '他们']);

function normalizeWords(text) {
  const source = String(text || '').toLowerCase();
  const latin = source.match(/[a-z][a-z'’-]*/g) || [];
  const cjk = source.match(/[\u4e00-\u9fff]{2,}/g) || [];
  return { latin, cjk };
}

function analyzeRepetition(text, { limit = 10, minCount = 3, phraseLength = 3 } = {}) {
  const { latin, cjk } = normalizeWords(text);

  const counts = new Map();
  for (const word of latin) {
    if (STOP_WORDS.has(word)) continue;
    counts.set(word, (counts.get(word) || 0) + 1);
  }
  const words = [...counts.entries()]
    .filter(([, count]) => count >= minCount)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([word, count]) => ({ word, count }));

  // A word repeated back to back reads like a typo far more often than a style choice.
  const doubled = [];
  for (let index = 1; index < latin.length; index += 1) {
    if (latin[index] === latin[index - 1] && latin[index].length > 1) {
      doubled.push({ phrase: latin[index] + ' ' + latin[index], count: 1 });
    }
  }

  // Repeated phrases of a few words, counted across the whole text.
  const phrases = new Map();
  for (let index = 0; index + phraseLength <= latin.length; index += 1) {
    const slice = latin.slice(index, index + phraseLength);
    if (slice.every((word) => STOP_WORDS.has(word))) continue;
    const phrase = slice.join(' ');
    phrases.set(phrase, (phrases.get(phrase) || 0) + 1);
  }
  const repeated = [...phrases.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([phrase, count]) => ({ phrase, count }));

  const cjkCounts = new Map();
  for (const chunk of cjk) {
    for (let index = 0; index + 1 < chunk.length; index += 1) {
      const bigram = chunk.slice(index, index + 2);
      if (CJK_STOP.has(bigram)) continue;
      cjkCounts.set(bigram, (cjkCounts.get(bigram) || 0) + 1);
    }
  }
  const cjkRepeated = [...cjkCounts.entries()]
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word, count]) => ({ word, count }));

  return { words, doubled, repeated, cjkRepeated };
}

module.exports = { analyzeRepetition, STOP_WORDS };
