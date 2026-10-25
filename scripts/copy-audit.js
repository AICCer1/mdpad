'use strict';

// Copy audit: keeps the two dictionaries honest. Run directly for a report, and through the unit test
// so a regression fails the suite.

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

function loadDictionaries() {
  const source = fs.readFileSync(path.join(root, 'src', 'i18n.js'), 'utf8');
  // evaluate the module in a tiny sandbox: it only builds DICT and exports it
  const module = { exports: {} };
  const wrapper = new Function('module', 'exports', 'require', source + '\nreturn module.exports;');
  const exported = wrapper(module, module.exports, require);
  const dict = exported.DICT || exported.en ? exported : module.exports;
  return dict.DICT ? dict.DICT : dict;
}

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
const PLACEHOLDER = /\{([a-zA-Z0-9_]+)\}/g;

function placeholders(text) {
  return [...String(text).matchAll(PLACEHOLDER)].map((match) => match[1]).sort();
}

function audit(dict) {
  const problems = [];
  const en = dict.en || {};
  const zh = dict.zh || {};
  const enKeys = Object.keys(en);
  const zhKeys = Object.keys(zh);

  for (const key of enKeys) {
    if (!(key in zh)) problems.push({ key, kind: 'missing-zh', detail: 'no Chinese text' });
  }
  for (const key of zhKeys) {
    if (!(key in en)) problems.push({ key, kind: 'missing-en', detail: 'no English text' });
  }

  for (const key of enKeys) {
    const value = en[key];
    const cvalue = zh[key];
    if (typeof value !== 'string') {
      problems.push({ key, kind: 'not-string', detail: String(value) });
      continue;
    }
    if (!value.trim()) problems.push({ key, kind: 'empty', detail: '' });
    if (value !== value.trim()) problems.push({ key, kind: 'whitespace', detail: JSON.stringify(value) });
    if (/ {2,}/.test(value)) problems.push({ key, kind: 'double-space', detail: JSON.stringify(value) });
    if (value.includes('...')) problems.push({ key, kind: 'ellipsis', detail: 'use … instead of ...' });
    // A Chinese-language preset label is the one legitimate CJK value in the English dictionary.
    if (CJK.test(value) && !key.endsWith('Zh')) problems.push({ key, kind: 'cjk-in-en', detail: value });
    // Menu labels are title case in English ("New Window", not "new window").
    // Parenthesised values are annotations ("(empty)"), not labels with casing rules.
    if (key.startsWith('menu.') && value.length <= 40 && !/\.$/.test(value) && !/^\(.*\)$/.test(value)) {
      const stopWords = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'for', 'in', 'into', 'on', 'to', 'with', 'from', 'by', 'mdpad']);
      const words = value
        .replace(/[^A-Za-z ]/g, '')
        .split(/\s+/)
        .filter((word) => word && /^[a-z]/.test(word) && !stopWords.has(word));
      if (words.length) {
        problems.push({ key, kind: 'menu-case', detail: value + ' → ' + words.join(', ') });
      }
    }
    if (typeof cvalue === 'string') {
      if (!cvalue.trim()) problems.push({ key, kind: 'empty-zh', detail: '' });
      if (cvalue !== cvalue.trim()) problems.push({ key, kind: 'whitespace-zh', detail: JSON.stringify(cvalue) });
      if (cvalue.includes('...')) problems.push({ key, kind: 'ellipsis-zh', detail: 'use … instead of ...' });
      if (/[A-Za-z]{2,}/.test(cvalue) && CJK.test(cvalue)) {
        // Chinese text may carry technical terms and placeholders; anything else is prose that was
        // probably left in English.
        const terms =
          /Markdown|PDF|HTML|EPUB|Word|AI|JSON|CSV|URL|CSS|API|OpenAI|Electron|Chromium|Node|mdpad|token|tokens|KB|MB|ms|http|https|Ctrl|Shift|Alt|Enter|Esc|Tab|UI|Georgia|Cambria|Segoe|Arial|Helvetica|Noto|Inter|Consolas|rem|assets/gi;
        const stripped = cvalue
          .replace(/\{[^}]*\}/g, '')
          .replace(/https?:\/\/\S+/g, '')
          .replace(terms, '');
        if (/[A-Za-z]{2,}/.test(stripped)) {
          problems.push({ key, kind: 'latin-in-zh', detail: cvalue });
        }
      }
      const a = placeholders(value);
      const b = placeholders(cvalue);
      if (a.join(',') !== b.join(',')) {
        problems.push({ key, kind: 'placeholder-mismatch', detail: `en={${a.join(',')}} zh={${b.join(',')}}` });
      }
      // Identical values are fine for brands and format strings, not for prose.
      if (value === cvalue && CJK.test(cvalue) && !key.endsWith('Zh')) {
        problems.push({ key, kind: 'untranslated', detail: value });
      }
    }
  }
  return problems;
}

if (require.main === module) {
  const dict = loadDictionaries();
  const problems = audit(dict);
  const byKind = problems.reduce((map, problem) => {
    map[problem.kind] = (map[problem.kind] || 0) + 1;
    return map;
  }, {});
  console.log(`${Object.keys(dict.en || {}).length} keys · ${problems.length} problems`);
  console.log(JSON.stringify(byKind));
  for (const problem of problems) {
    console.log(`${problem.kind.padEnd(20)} ${problem.key.padEnd(28)} ${problem.detail}`);
  }
  process.exit(problems.length ? 1 : 0);
}

module.exports = { loadDictionaries, audit, placeholders };
