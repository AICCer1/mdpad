'use strict';

// Saved window bounds are only useful if they still land on a connected display.
// A monitor can be unplugged, the resolution can shrink, or the window can be saved partly outside
// the work area. Dropping the bounds entirely loses the user's size; keeping them untouched can put
// the title bar where no mouse can reach it. The rules below keep a window visible and keep its size
// whenever the size still fits.

const TITLE_BAR = 40;
// Enough of the title bar has to be reachable, not just one pixel of the window.
const MIN_VISIBLE_WIDTH = 200;
const MIN_VISIBLE_HEIGHT = 32;

function valid(bounds) {
  return (
    bounds &&
    [bounds.x, bounds.y, bounds.width, bounds.height].every((value) => Number.isFinite(value)) &&
    bounds.width > 0 &&
    bounds.height > 0
  );
}

function intersect(a, b) {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (width <= 0 || height <= 0) return null;
  return { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), width, height };
}

function fitBounds(bounds, displays, { minWidth = 720, minHeight = 480 } = {}) {
  if (!valid(bounds) || !Array.isArray(displays) || !displays.length) return null;

  const areas = displays
    .map((display) => (display && (display.workArea || display.bounds)) || null)
    .filter((area) => area && Number.isFinite(area.x) && Number.isFinite(area.y) && area.width > 0 && area.height > 0);
  if (!areas.length) return null;

  const titleBar = { x: bounds.x, y: bounds.y, width: bounds.width, height: TITLE_BAR };
  let visible = null;
  let bestArea = null;
  let bestOverlap = 0;
  for (const area of areas) {
    const overlap = intersect(titleBar, area);
    if (overlap) {
      if (!visible || overlap.width * overlap.height > visible.width * visible.height) visible = overlap;
    }
    const whole = intersect(bounds, area);
    const size = whole ? whole.width * whole.height : 0;
    if (size > bestOverlap) {
      bestOverlap = size;
      bestArea = area;
    }
  }

  // A reachable title bar is enough — unless the window is larger than the display it mostly sits
  // on, in which case it would hide its own edges (and its resize handles) off-screen.
  const oversized = bestArea && (bounds.width > bestArea.width || bounds.height > bestArea.height);
  if (!oversized && visible && visible.width >= MIN_VISIBLE_WIDTH && visible.height >= MIN_VISIBLE_HEIGHT) {
    return {
      x: bounds.x,
      y: bounds.y,
      width: Math.max(minWidth, bounds.width),
      height: Math.max(minHeight, bounds.height),
    };
  }

  // Otherwise move it into the display it overlaps most (or the first one when it overlaps none),
  // and shrink it only as far as that display requires.
  const area = bestArea || areas[0];
  const width = Math.max(minWidth, Math.min(bounds.width, area.width));
  const height = Math.max(minHeight, Math.min(bounds.height, area.height));
  const maxX = area.x + area.width - width;
  const maxY = area.y + area.height - height;
  return {
    x: Math.round(Math.min(Math.max(bounds.x, area.x), Math.max(area.x, maxX))),
    y: Math.round(Math.min(Math.max(bounds.y, area.y), Math.max(area.y, maxY))),
    width: Math.round(width),
    height: Math.round(height),
  };
}

module.exports = { fitBounds, MIN_VISIBLE_WIDTH, MIN_VISIBLE_HEIGHT };
