'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fitBounds } = require('../src/window-bounds');

const displays = [
  { workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
  { workArea: { x: 1920, y: 0, width: 1280, height: 1024 } },
];

test('keeps bounds that are on a display', () => {
  const bounds = { x: 100, y: 80, width: 1180, height: 800 };
  assert.deepEqual(fitBounds(bounds, displays), bounds);
});

test('rejects bounds from a disconnected monitor', () => {
  // A third monitor at x=5000 is gone now.
  assert.equal(fitBounds({ x: 5000, y: 100, width: 900, height: 700 }, displays), null);
});

test('accepts a window spanning two displays', () => {
  const bounds = { x: 1500, y: 100, width: 1200, height: 800 };
  assert.deepEqual(fitBounds(bounds, displays), bounds);
});

test('clamps a window that was saved too small', () => {
  const fitted = fitBounds({ x: 10, y: 10, width: 100, height: 50 }, displays);
  assert.equal(fitted.width, 720);
  assert.equal(fitted.height, 480);
});

test('malformed bounds are ignored', () => {
  assert.equal(fitBounds(null, displays), null);
  assert.equal(fitBounds({ x: 'a', y: 0, width: 100, height: 100 }, displays), null);
  assert.equal(fitBounds({ x: 0, y: 0, width: 0, height: 100 }, displays), null);
  assert.equal(fitBounds({ x: 0, y: 0, width: 100, height: 100 }, []), null);
});
