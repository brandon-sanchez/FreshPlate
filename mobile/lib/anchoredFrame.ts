/** A rectangle on screen, in window points. */
export type WindowRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const EDGE = 8;
const GAP_BELOW_ANCHOR = 6;
const BOTTOM_MARGIN = 14;
// Keeps the scale origin off the menu's rounded corners.
const ORIGIN_INSET = 14;

/**
 * Returns where a dropdown of `menuWidth` points hangs under `anchor`: its
 * top-left corner, its width and the most height it may take, all in window
 * points. The menu lines up with the anchor's right edge, stays at least
 * 8 points inside the window, and stops above the bottom safe-area inset.
 * `originX` is the x offset, inside the menu, of the anchor's center, so the
 * menu can grow out of the anchor.
 */
export function anchoredFrame(
  anchor: WindowRect,
  window: { width: number; height: number },
  bottomInset: number,
  menuWidth: number,
): {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  originX: number;
} {
  const width = Math.min(menuWidth, window.width - EDGE * 2);
  const left = Math.max(
    EDGE,
    Math.min(anchor.x + anchor.width - width, window.width - width - EDGE),
  );
  const top = anchor.y + anchor.height + GAP_BELOW_ANCHOR;
  const maxHeight =
    window.height - top - Math.max(bottomInset, BOTTOM_MARGIN) - BOTTOM_MARGIN;
  const originX = Math.max(
    ORIGIN_INSET,
    Math.min(anchor.x + anchor.width / 2 - left, width - ORIGIN_INSET),
  );
  return { top, left, width, maxHeight, originX };
}
