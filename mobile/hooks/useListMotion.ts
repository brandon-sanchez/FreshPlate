import { useCallback, useEffect, useMemo, useRef } from "react";
import { useSharedValue } from "react-native-reanimated";
import {
  groupEntering,
  groupExiting,
  ListChange,
  type ListChangeKind,
  listLayout,
  rowEntering,
  rowExiting,
  settleTime,
} from "@/lib/listMotion";

/** The animations a list's sections and rows take, from {@link useListMotion}. */
export type ListMotion = {
  /** The layout transition for sections, row groups and rows. */
  layout: ReturnType<typeof listLayout>;
  /** Returns the entering animation for the row at an index in its section. */
  rowEntering: (index: number) => ReturnType<typeof rowEntering>;
  /** The exiting animation for rows. */
  rowExiting: ReturnType<typeof rowExiting>;
  /** The entering animation for the list of a newly chosen grouping. */
  groupEntering: ReturnType<typeof groupEntering>;
  /** The exiting animation for the list of the grouping being left. */
  groupExiting: ReturnType<typeof groupExiting>;
};

/**
 * Returns the inventory list's animations and two calls that pick them.
 * `animate(kind)` makes the next list update a re-sort or a collapse, and
 * holds that kind for {@link settleTime} so the animation finishes; later
 * updates, such as a typed search, land at once. `slideToward(from, to)`
 * sets which side the next grouping's list slides in from, by tab index.
 * Call either just before the state update it describes.
 *
 * @param reducedMotion - Whether Reduce Motion is on; the animations become
 * short fades and the layout lands at once.
 */
export function useListMotion(reducedMotion: boolean) {
  const change = useSharedValue<ListChangeKind>(ListChange.none);
  const direction = useSharedValue(1);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (settle.current) clearTimeout(settle.current);
    },
    [],
  );

  const animate = useCallback(
    (kind: typeof ListChange.reorder | typeof ListChange.collapse) => {
      change.value = kind;
      if (settle.current) clearTimeout(settle.current);
      settle.current = setTimeout(() => {
        change.value = ListChange.none;
      }, settleTime(kind));
    },
    [change],
  );

  const slideToward = useCallback(
    (from: number, to: number) => {
      direction.value = Math.sign(to - from) || 1;
    },
    [direction],
  );

  const motion = useMemo<ListMotion>(
    () => ({
      layout: listLayout(change, reducedMotion),
      rowEntering: (index) => rowEntering(change, reducedMotion, index),
      rowExiting: rowExiting(change),
      groupEntering: groupEntering(direction, reducedMotion),
      groupExiting: groupExiting(direction, reducedMotion),
    }),
    [change, direction, reducedMotion],
  );

  return { motion, animate, slideToward };
}
