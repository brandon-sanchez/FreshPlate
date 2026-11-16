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
 * moves at once, which is what typing a search or a refetch should do.
 */
export const ListChange = { none: 0, reorder: 1, collapse: 2 } as const;

/** One value of {@link ListChange}. */
export type ListChangeKind = (typeof ListChange)[keyof typeof ListChange];

const ROW_FADE_IN_MS = 200;
const ROW_FADE_OUT_MS = 120;
const ROW_STAGGER_MS = 20;
const MAX_STAGGERED_ROWS = 6;
const GROUP_SLIDE_IN = 24;
const GROUP_SLIDE_OUT = 16;

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
 * Returns the entering animation for the row at `index` in its section.
 * Rows that a filter reveals fade in; rows of a section that opens fade in
 * one after another, 20 ms apart. Rows that appear for any other reason show
 * at once.
 */
export function rowEntering(
  change: SharedValue<ListChangeKind>,
  reducedMotion: boolean,
  index: number,
): EntryExitAnimationFunction {
  return () => {
    "worklet";
    const kind = change.value;
    const duration =
      kind === ListChange.none
        ? 0
        : reducedMotion
          ? REDUCED_FADE_MS
          : ROW_FADE_IN_MS;
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

/** Returns the exiting animation for rows: a short fade during a re-sort, filter or collapse. */
export function rowExiting(
  change: SharedValue<ListChangeKind>,
): EntryExitAnimationFunction {
  return () => {
    "worklet";
    const duration = change.value === ListChange.none ? 0 : ROW_FADE_OUT_MS;
    return {
      initialValues: { opacity: 1 },
      animations: { opacity: withTiming(0, { duration }) },
    };
  };
}

/**
 * Returns the entering animation for the list of a newly chosen grouping.
 * It fades in while sliding 24 points in from the side of the chosen tab
 * with the tab spring. `direction` is 1 when the chosen tab is right of the
 * last one and -1 when it is left. With Reduce Motion on, it only fades.
 */
export function groupEntering(
  direction: SharedValue<number>,
  reducedMotion: boolean,
): EntryExitAnimationFunction {
  return () => {
    "worklet";
    if (reducedMotion) {
      return {
        initialValues: { opacity: 0 },
        animations: { opacity: withTiming(1, { duration: REDUCED_FADE_MS }) },
      };
    }
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
  };
}

/**
 * Returns the exiting animation for the list of the grouping being left: a
 * 120 ms fade that slides 16 points away from the chosen tab. With Reduce
 * Motion on, it only fades.
 */
export function groupExiting(
  direction: SharedValue<number>,
  reducedMotion: boolean,
): EntryExitAnimationFunction {
  return () => {
    "worklet";
    const timing = { duration: ROW_FADE_OUT_MS };
    return {
      initialValues: { opacity: 1, transform: [{ translateX: 0 }] },
      animations: {
        opacity: withTiming(0, timing),
        transform: [
          {
            translateX: reducedMotion
              ? withTiming(0, timing)
              : withTiming(-direction.value * GROUP_SLIDE_OUT, timing),
          },
        ],
      },
    };
  };
}
