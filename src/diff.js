'use strict';

// Minimal word-level diff (LCS). Used to review an AI suggestion before applying it.
// Bounded: above MAX_TOKENS per side it degrades to a single replace op.

const MAX_TOKENS = 1500;

function tokenize(text) {
  return String(text ?? '')
    .split(/(\s+)/)
    .filter((part) => part.length > 0);
}

function diffWords(before, after) {
  const a = tokenize(before);
  const b = tokenize(after);

  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) {
    return [
      { type: 'delete', text: a.join('') },
      { type: 'insert', text: b.join('') },
    ];
  }

  const rows = a.length + 1;
  const cols = b.length + 1;
  const lcs = Array.from({ length: rows }, () => new Uint32Array(cols));

  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const ops = [];
  const push = (type, text) => {
    const last = ops[ops.length - 1];
    if (last && last.type === type) last.text += text;
    else ops.push({ type, text });
  };

  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push('equal', a[i]);
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      push('delete', a[i]);
      i += 1;
    } else {
      push('insert', b[j]);
      j += 1;
    }
  }
  while (i < a.length) {
    push('delete', a[i]);
    i += 1;
  }
  while (j < b.length) {
    push('insert', b[j]);
    j += 1;
  }
  return ops;
}

function diffStats(ops) {
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === 'insert') added += op.text.length;
    if (op.type === 'delete') removed += op.text.length;
  }
  return { added, removed, changed: added + removed > 0 };
}

module.exports = { diffWords, diffStats, tokenize, MAX_TOKENS };
