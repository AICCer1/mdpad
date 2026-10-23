'use strict';

// AI context scope: a stored value means the user picked it, so it must not be auto-narrowed
// on long documents. Only the untouched default is allowed to narrow itself.

const SCOPES = ['doc', 'paragraph', 'selection', 'none'];
const AUTO_NARROW_CHARS = 20000;

function initialScope(stored) {
  if (SCOPES.includes(stored)) return { scope: stored, explicit: true };
  return { scope: 'doc', explicit: false };
}

function effectiveScope(scope, explicit, textLength, threshold = AUTO_NARROW_CHARS) {
  const value = SCOPES.includes(scope) ? scope : 'doc';
  if (!explicit && value === 'doc' && Number(textLength) > threshold) return 'paragraph';
  return value;
}

module.exports = { SCOPES, AUTO_NARROW_CHARS, initialScope, effectiveScope };
