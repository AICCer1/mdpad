'use strict';

// Style hints: hedges that weaken a sentence and passive constructions that hide the actor.
// These are hints, not verdicts — the report shows where to look, the writer decides.

const WEAK_WORDS = [
  'very', 'really', 'quite', 'just', 'actually', 'basically', 'literally', 'simply', 'definitely',
  'extremely', 'totally', 'absolutely', 'somewhat', 'rather', 'pretty', 'fairly', 'truly', 'highly',
  'completely', 'essentially', 'practically', 'virtually',
];

const BE_VERBS = ['is', 'are', 'was', 'were', 'be', 'been', 'being', 'am'];

// Common irregular past participles: the "-ed" rule misses these entirely.
const IRREGULAR = [
  'made', 'done', 'given', 'taken', 'seen', 'known', 'shown', 'written', 'spoken', 'broken', 'chosen',
  'driven', 'eaten', 'fallen', 'forgotten', 'gotten', 'hidden', 'held', 'kept', 'left', 'lost', 'met',
  'paid', 'put', 'read', 'said', 'sold', 'sent', 'set', 'shown', 'shut', 'spent', 'split', 'spread',
  'told', 'thought', 'understood', 'won', 'worn', 'built', 'brought', 'bought', 'caught', 'cut', 'felt',
  'found', 'heard', 'hit', 'led', 'meant', 'run', 'stolen', 'struck', 'sworn', 'torn', 'thrown', 'woken',
];

// Adjectives that look like participles. A dictionary would be better; this list covers the ones that
// appear in prose often enough to make the hint noisy.
const ADJECTIVAL = new Set([
  'tired', 'interested', 'excited', 'bored', 'worried', 'scared', 'surprised', 'pleased', 'married',
  'crowded', 'complicated', 'detailed', 'limited', 'advanced', 'aged', 'talented', 'gifted', 'skilled',
  'needed', 'red', 'bed', 'fed',
]);

const HEDGE = '(?:quite|really|very|easily|quickly|slowly|carefully|often|rarely|never|always|still|already)';

function sentences(text) {
  const parts = String(text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?。！？])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts;
}

function analyzeStyle(text, { limit = 5 } = {}) {
  const prose = String(text || '');
  const list = sentences(prose);
  const lower = prose.toLowerCase();

  const weakCounts = new Map();
  for (const word of WEAK_WORDS) {
    const pattern = new RegExp('\\b' + word + '\\b', 'gi');
    const count = (lower.match(pattern) || []).length;
    if (count) weakCounts.set(word, count);
  }
  const weak = [...weakCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([word, count]) => ({ word, count }));

  // "was written", "were quickly made", "is often forgotten"
  const passivePattern = new RegExp(
    '\\b(' + BE_VERBS.join('|') + ')\\s+(?:not\\s+)?(?:' + HEDGE + '\\s+)?([a-z]{3,}ed|[a-z]{2,}en|' +
      IRREGULAR.join('|') + ')\\b',
    'i'
  );
  const passive = [];
  for (const sentence of list) {
    const match = passivePattern.exec(sentence);
    if (!match) continue;
    // "is red", "was tired" are adjectives, not participles: require -ed/-en or an irregular form.
    const word = match[2].toLowerCase();
    if (ADJECTIVAL.has(word)) continue;
    const looksParticiple = /^[a-z]{3,}ed$/.test(word) || /^[a-z]{2,}en$/.test(word) || IRREGULAR.includes(word);
    if (!looksParticiple) continue;
    passive.push({ verb: match[1] + ' ' + match[2], text: sentence.slice(0, 160) });
    if (passive.length >= limit) break;
  }

  return { weak, passive, sentences: list.length, passiveCount: passive.length };
}

module.exports = { analyzeStyle, WEAK_WORDS };
