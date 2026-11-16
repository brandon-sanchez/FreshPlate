/**
 * Durations for timing animations, in milliseconds.
 *
 * `instant` is also the longest fade used when Reduce Motion is on, where
 * Apple's guidance replaces movement with dissolves and fades.
 */
export const motionDuration = {
  instant: 80,
  fast: 180,
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
} as const;
