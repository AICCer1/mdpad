'use strict';

// AI follow-up turns are only useful for a short while; old entries are pruned so the file
// never grows into a transcript nobody asked for.

const MAX_TURNS = 4;
const MAX_AGE_DAYS = 30;

function pruneTurns(turns, { now = Date.now(), maxTurns = MAX_TURNS, maxAgeDays = MAX_AGE_DAYS } = {}) {
  if (!Array.isArray(turns)) return [];
  const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
  const valid = turns.filter((turn) => {
    if (!turn || typeof turn.instruction !== 'string' || typeof turn.result !== 'string') return false;
    if (!turn.at) return true; // entries written before timestamps existed are kept
    const stamp = Date.parse(turn.at);
    return !Number.isFinite(stamp) || stamp >= cutoff;
  });
  return valid.slice(-maxTurns);
}

module.exports = { pruneTurns, MAX_TURNS, MAX_AGE_DAYS };
