/**
 * Durations for timing animations, in milliseconds.
 *
 * `instant` is also the longest fade used when Reduce Motion is on, where
 * Apple's guidance replaces movement with dissolves and fades.
 */
export const motionDuration = {
  instant: 80,
  fast: 180,
  /** A swiped card thrown off the screen. */
  throw: 260,
  normal: 350,
} as const;

/** Spring configs for `withSpring`. */
export const motionSpring = {
  /** Default for controls: settles quickly with a slight overshoot. */
  snappy: { stiffness: 300, damping: 30, mass: 1 },
} as const;

/** Scale factors for press and toggle feedback. */
export const motionScale = {
  /** Where a toggled icon starts before it springs back to full size. */
  toggle: 0.8,
  /** How far a card shrinks for a moment to confirm a swipe that started a cook. */
  press: 0.96,
} as const;

/** Delays between staggered items, in milliseconds. */
export const motionStagger = {
  /** Between cards leaving the feed together. */
  sweep: 60,
} as const;

/** Travel distances, in points. */
export const motionDistance = {
  /** How far a card slides as it leaves the feed. */
  sweep: 72,
} as const;

/**
 * Returns how long a feed sweep takes, in milliseconds: the last card's
 * stagger delay plus its exit, or one short fade with Reduce Motion on.
 */
export function sweepExitDurationMs(
  longestDelayMs: number,
  reducedMotion: boolean,
): number {
  return reducedMotion
    ? motionDuration.instant
    : longestDelayMs + motionDuration.fast;
}
