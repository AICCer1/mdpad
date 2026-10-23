'use strict';

// Saved window bounds are only useful if they still land on a connected display.
// After unplugging a monitor, restoring the old coordinates can put the window
// completely offscreen, which looks like the app failed to start.

function fitBounds(bounds, displays, { minWidth = 720, minHeight = 480 } = {}) {
  if (
    !bounds ||
    !Number.isFinite(bounds.x) ||
    !Number.isFinite(bounds.y) ||
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height) ||
    bounds.width <= 0 ||
    bounds.height <= 0
  ) {
    return null;
  }

  const onScreen = (displays || []).some((display) => {
    const area = display.workArea || display.bounds;
    if (!area) return false;
    const overlapsX = bounds.x < area.x + area.width && bounds.x + bounds.width > area.x;
    const overlapsY = bounds.y < area.y + area.height && bounds.y + bounds.height > area.y;
    return overlapsX && overlapsY;
  });

  if (!onScreen) return null;
  return {
    x: bounds.x,
    y: bounds.y,
    width: Math.max(minWidth, bounds.width),
    height: Math.max(minHeight, bounds.height),
  };
}

module.exports = { fitBounds };
