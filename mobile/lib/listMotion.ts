import {
  withDelay,
  withSpring,
  withTiming,
  type EntryExitAnimationFunction,
  type LayoutAnimationFunction,
  type SharedValue,
} from "react-native-reanimated";
import { COLLAPSE, REDUCED_FADE_MS, TAB_SPRING } from "@/lib/motion";

/**
 * The change the inventory list is animating. A list that holds `none`
 * moves at once, which is what typing a search, a refetch or a scroll that
 * mounts rows should do.
 */
export const ListChange = { none: 0, reorder: 1, collapse: 2, group: 3 } as const;

/** One value of {@link ListChange}. */
export type ListChangeKind = (typeof ListChange)[keyof typeof ListChange];

const ROW_FADE_IN_MS = 200;
const ROW_FADE_OUT_MS = 120;
const ROW_STAGGER_MS = 20;
/** How many rows of an opening section fade in one after another. Later rows fade in with the last of them. */
export const MAX_STAGGERED_ROWS = 6;
const GROUP_SLIDE_IN = 24;
const GROUP_SLIDE_OUT = 16;
// TAB_SPRING comes within a pixel of rest in about 500 ms.
const REORDER_SETTLE_MS = 600;

// Rows mount and unmount on every scroll of a virtualized list, so a row
// that isn't part of an animated change skips the animation work entirely.
const NO_ANIMATION = { initialValues: {}, animations: {} };

/** A change a list can be told to animate: every {@link ListChange} but `none`. */
export type AnimatedListChange = Exclude<ListChangeKind, typeof ListChange.none>;

/**
 * Returns how long a change keeps animating, in milliseconds: the longest of
 * its layout, slide, stagger and fade timings, with a little slack. A list
 * should hold the change at least this long.
 */
export function settleTime(kind: AnimatedListChange): number {
  return kind !== ListChange.collapse
    ? REORDER_SETTLE_MS
    : Math.max(
        COLLAPSE.duration,
        MAX_STAGGERED_ROWS * ROW_STAGGER_MS + ROW_FADE_IN_MS,
      ) + 100;
}

/**
 * Returns the layout transition for list rows and sections. A re-sort or
 * filter (`reorder`) springs them to their new places with the tab spring; a
 * section opening or closing (`collapse`) moves them over 240 ms. Any other
 * change, and every change while `reducedMotion` is on, lands at once.
 * `change` is read when the layout changes, so setting it just before the
 * state update picks the motion for that update.
 */
export function listLayout(
  change: SharedValue<ListChangeKind>,
  reducedMotion: boolean,
): LayoutAnimationFunction {
  return (values) => {
    "worklet";
    const kind = reducedMotion ? ListChange.none : change.value;
    const to = (target: number) =>
      kind === ListChange.reorder
        ? withSpring(target, TAB_SPRING)
        : kind === ListChange.collapse
          ? withTiming(target, COLLAPSE)
          : withTiming(target, { duration: 0 });
    return {
      initialValues: {
        originX: values.currentOriginX,
        originY: values.currentOriginY,
        width: values.currentWidth,
        height: values.currentHeight,
      },
      animations: {
        originX: to(values.targetOriginX),
        originY: to(values.targetOriginY),
        width: to(values.targetWidth),
        height: to(values.targetHeight),
      },
    };
  };
}

/**
 * Returns the entering animation for the row or section header at `index`
 * in its section. Rows that a filter reveals fade in. Rows of a section that
 * opens fade in one after another, 20 ms apart. The rows of a newly chosen
 * grouping fade in while sliding 24 points in from the side of the chosen
 * tab with the tab spring. `direction` is 1 when that tab is right of the
 * last one and -1 when it is left. Rows that appear for any other reason,
 * such as a scroll mounting them, show at once. With `reducedMotion` on,
 * every animated entrance is a short fade.
 */
export function rowEntering(
  change: SharedValue<ListChangeKind>,
  direction: SharedValue<number>,
  reducedMotion: boolean,
  index: number,
): EntryExitAnimationFunction {
  return () => {
    "worklet";
    const kind = change.value;
    if (kind === ListChange.none) return NO_ANIMATION;
    if (kind === ListChange.group && !reducedMotion) {
      return {
        initialValues: {
          opacity: 0,
          transform: [{ translateX: direction.value * GROUP_SLIDE_IN }],
        },
        animations: {
          opacity: withTiming(1, { duration: ROW_FADE_IN_MS }),
          transform: [{ translateX: withSpring(0, TAB_SPRING) }],
        },
      };
    }
    const duration = reducedMotion ? REDUCED_FADE_MS : ROW_FADE_IN_MS;
    const delay =
      kind === ListChange.collapse && !reducedMotion
        ? Math.min(index, MAX_STAGGERED_ROWS) * ROW_STAGGER_MS
        : 0;
    return {
      initialValues: { opacity: 0 },
      animations: { opacity: withDelay(delay, withTiming(1, { duration })) },
    };
  };
}

/**
 * Returns the exiting animation for rows and section headers: a 120 ms fade
 * during a re-sort, filter or collapse. Rows of the grouping being left also
 * slide 16 points away from the chosen tab unless `reducedMotion` is on.
 */
export function rowExiting(
  change: SharedValue<ListChangeKind>,
  direction: SharedValue<number>,
  reducedMotion: boolean,
): EntryExitAnimationFunction {
  return () => {
    "worklet";
    const kind = change.value;
    if (kind === ListChange.none) return NO_ANIMATION;
    const timing = { duration: ROW_FADE_OUT_MS };
    const slide =
      kind === ListChange.group && !reducedMotion
        ? -direction.value * GROUP_SLIDE_OUT
        : 0;
    return {
      initialValues: { opacity: 1, transform: [{ translateX: 0 }] },
      animations: {
        opacity: withTiming(0, timing),
        transform: [{ translateX: withTiming(slide, timing) }],
      },
    };
  };
}
