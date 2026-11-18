/** Where a section header sits in a list, and what it sticks under, in points. */
export type StickyHeaderFrame = {
  /** The list's vertical scroll offset. */
  scrollY: number;
  /** The height of the pinned header that section headers stick below. */
  pinHeight: number;
  /** Where the header sits in the list content. */
  top: number;
  /** The header's height, or -1 before the header has been laid out. */
  height: number;
  /** Where the next section's header starts, or `null` when no header follows. */
  nextTop: number | null;
};

/**
 * Returns how far to move a section header down from its place in the list,
 * in points, so that it sticks just below the pinned header while its
 * section scrolls under it. The next section's header pushes it up and away.
 * A header that hasn't been laid out stays in place.
 */
export function stickyOffset({
  scrollY,
  pinHeight,
  top,
  height,
  nextTop,
}: StickyHeaderFrame): number {
  "worklet";
  if (height < 0) return 0;
  const overlap = scrollY + pinHeight - top;
  const room = nextTop === null ? overlap : nextTop - height - top;
  return Math.max(0, Math.min(overlap, room));
}

/**
 * Returns how far to move the pinned header down from its place in the list,
 * in points, so that it stays at the top once the list scrolls past it.
 */
export function pinnedOffset(scrollY: number, top: number): number {
  "worklet";
  return Math.max(0, scrollY - top);
}
