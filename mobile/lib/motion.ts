import { Easing, ReduceMotion } from "react-native-reanimated";

/**
 * The spring the tab bar's selection pill uses, critically damped so it
 * settles without bouncing. Controls that move a selection, such as the
 * segmented control's indicator and the sort menu's highlight, share it so
 * every selection moves the same way.
 */
export const TAB_SPRING = { stiffness: 320, damping: 30, mass: 0.7 } as const;

/** {@link TAB_SPRING} for Reanimated values, landing at once when Reduce Motion is on. */
export const SELECTION_SPRING = {
  ...TAB_SPRING,
  reduceMotion: ReduceMotion.System,
} as const;

/** The spring a dropdown menu opens with, overshooting by about 3 percent. */
export const MENU_SPRING = { stiffness: 380, damping: 26, mass: 0.8 } as const;

/** How long a dropdown menu takes to close, in milliseconds. */
export const MENU_CLOSE_MS = 140;

/** The duration in milliseconds and the easing that sections and menu rows open and close with. */
export const COLLAPSE = {
  duration: 240,
  easing: Easing.out(Easing.cubic),
} as const;

/**
 * The longest fade allowed when Reduce Motion is on, in milliseconds. Slides
 * and scales become fades of at most this long.
 */
export const REDUCED_FADE_MS = 150;
