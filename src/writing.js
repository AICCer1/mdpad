'use strict';

// Daily writing history, kept pure so the streak rules can be unit-tested without an app.

function dayKey(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
}

function shiftDay(date, days) {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  next.setDate(next.getDate() + days);
  return next;
}

/**
 * @param {Record<string, number>} days map of YYYY-MM-DD → words
 * @param {number} goal daily goal, 0 for "no goal"
 * @param {Date} today reference day
 */
function buildHistory(days, goal, today = new Date()) {
  const clean = days && typeof days === 'object' ? days : {};
  const list = [];
  for (let offset = 13; offset >= 0; offset -= 1) {
    const date = shiftDay(today, -offset);
    const key = dayKey(date);
    const words = Math.max(0, Math.floor(Number(clean[key]) || 0));
    list.push({ date: key, words, reached: goal > 0 ? words >= goal : words > 0 });
  }

  // A streak counts back from today (or yesterday, so writing late at night is not punished).
  const qualifies = (entry) => (goal > 0 ? entry.words >= goal : entry.words > 0);
  let streak = 0;
  let index = list.length - 1;
  if (!qualifies(list[index])) index -= 1;
  while (index >= 0 && qualifies(list[index])) {
    streak += 1;
    index -= 1;
  }

  let best = 0;
  for (const entry of list) best = Math.max(best, entry.words);
  const total = list.reduce((sum, entry) => sum + entry.words, 0);
  return { days: list, streak, best, total, goal };
}

module.exports = { buildHistory, dayKey };
