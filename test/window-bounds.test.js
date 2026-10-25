'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fitBounds, MIN_VISIBLE_WIDTH, MIN_VISIBLE_HEIGHT } = require('../src/window-bounds');

const displays = [
  { workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
  { workArea: { x: 1920, y: 0, width: 1280, height: 1024 } },
];

test('keeps bounds that are on a display', () => {
  const bounds = { x: 100, y: 80, width: 1180, height: 800 };
  assert.deepEqual(fitBounds(bounds, displays), bounds);
});

test('a window from a disconnected monitor is moved into the primary work area', () => {
  // The third monitor at x=5000 is gone; the size is still useful, so keep it.
  const fitted = fitBounds({ x: 5000, y: 100, width: 900, height: 700 }, displays);
  assert.ok(fitted, 'bounds were dropped instead of relocated');
  assert.ok(fitted.x >= 0 && fitted.x + fitted.width <= 1920, `x=${fitted.x} is outside the primary display`);
  assert.equal(fitted.width, 900);
  assert.equal(fitted.height, 700);
});

test('accepts a window spanning two displays when its title bar is reachable', () => {
  const bounds = { x: 1500, y: 100, width: 1200, height: 800 };
  assert.deepEqual(fitBounds(bounds, displays), bounds);
});

test('clamps a window that was saved too small', () => {
  const fitted = fitBounds({ x: 10, y: 10, width: 100, height: 50 }, displays);
  assert.equal(fitted.width, 720);
  assert.equal(fitted.height, 480);
});

test('shrinks a window larger than the work area', () => {
  const fitted = fitBounds({ x: 0, y: 0, width: 3000, height: 2000 }, displays);
  assert.ok(fitted.width <= 1920, `width ${fitted.width} exceeds the display`);
  assert.ok(fitted.height <= 1040, `height ${fitted.height} exceeds the display`);
  assert.ok(fitted.x >= 0 && fitted.x + fitted.width <= 1920);
  assert.ok(fitted.y >= 0 && fitted.y + fitted.height <= 1040);
});

test('a window hanging off the right edge is pulled back in', () => {
  // On the second display (1920..3200) but running past its right edge, with too little title bar
  // visible to grab.
  const fitted = fitBounds({ x: 3100, y: 100, width: 800, height: 600 }, displays);
  assert.ok(fitted.x + fitted.width <= 3200, `right edge ${fitted.x + fitted.width} is outside`);
  assert.equal(fitted.width, 800);
});

test('a window with its title bar above the screen comes back down', () => {
  const fitted = fitBounds({ x: 200, y: -300, width: 900, height: 700 }, displays);
  assert.ok(fitted.y >= 0, `y=${fitted.y} leaves the title bar unreachable`);
});

test('a window on a removed monitor to the left is relocated, not dropped', () => {
  const fitted = fitBounds({ x: -900, y: 100, width: 800, height: 700 }, displays);
  assert.ok(fitted);
  assert.ok(fitted.x >= 0);
  assert.equal(fitted.width, 800);
});

test('a tiny visible sliver is not considered reachable', () => {
  const fitted = fitBounds({ x: 1919, y: 100, width: 800, height: 600 }, displays);
  // 1px of title bar is not enough, so the window is moved; the second display could legitimately
  // hold it, so only the invariant matters: a usable title bar is on some display.
  const reachable = displays.some((display) => {
    const area = display.workArea;
    const left = Math.max(fitted.x, area.x);
    const right = Math.min(fitted.x + fitted.width, area.x + area.width);
    const top = Math.max(fitted.y, area.y);
    const bottom = Math.min(fitted.y + 40, area.y + area.height);
    return right - left >= MIN_VISIBLE_WIDTH && bottom - top >= MIN_VISIBLE_HEIGHT;
  });
  assert.ok(reachable, `title bar not reachable after fitting: ${JSON.stringify(fitted)}`);
});

test('malformed bounds are ignored', () => {
  assert.equal(fitBounds(null, displays), null);
  assert.equal(fitBounds({ x: 'a', y: 0, width: 100, height: 100 }, displays), null);
  assert.equal(fitBounds({ x: 0, y: 0, width: 0, height: 100 }, displays), null);
  assert.equal(fitBounds({ x: 0, y: 0, width: Infinity, height: 100 }, displays), null);
  assert.equal(fitBounds({ x: 0, y: 0, width: 100, height: 100 }, []), null);
  assert.equal(fitBounds({ x: 0, y: 0, width: 100, height: 100 }, null), null);
});

test('a single small display still yields a window that fits it', () => {
  const small = [{ workArea: { x: 0, y: 0, width: 800, height: 600 } }];
  const fitted = fitBounds({ x: 100, y: 100, width: 1400, height: 900 }, small);
  assert.ok(fitted.width <= 800);
  assert.ok(fitted.height <= 600);
  assert.ok(fitted.x + fitted.width <= 800);
  assert.ok(fitted.y + fitted.height <= 600);
});
