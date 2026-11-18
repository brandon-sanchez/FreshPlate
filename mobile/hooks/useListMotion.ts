import { useCallback, useEffect, useMemo, useRef } from "react";
import { useSharedValue } from "react-native-reanimated";
import {
  type AnimatedListChange,
  hideRows,
  ListChange,
  type ListChangeKind,
  listLayout,
  MAX_STAGGERED_ROWS,
  rowEntering,
  rowExiting,
  type RowsMotion,
  settleTime,
  showRows,
} from "@/lib/listMotion";

/** The animations a list's rows and section headers take, from {@link useListMotion}. */
export type ListMotion = {
  /** The layout transition for list cells and section headers. */
  layout: ReturnType<typeof listLayout>;
  /** Returns the entering animation for the row at an index in its section. */
  rowEntering: (index: number) => ReturnType<typeof rowEntering>;
  /** The exiting animation for rows and section headers. */
  rowExiting: ReturnType<typeof rowExiting>;
  /** The fade and slide that every row and section header share while the grouping changes. */
  rows: RowsMotion;
};

/**
 * Returns the inventory list's animations and the calls that start them.
 *
 * `animate(kind)` makes the next list update a re-sort or a collapse, and
 * holds that kind for {@link settleTime} so the animation finishes; later
 * updates, such as a typed search or a scroll that mounts rows, land at
 * once. Call it just before the state update it describes.
 *
 * `hide(direction)` and `show(direction)` fade every row out and back in
 * around a change of grouping, sliding them with the tab change: 1 when the
 * chosen tab is right of the last one, -1 when it is left. Both keep their
 * identity while `reducedMotion` stays the same.
 *
 * @param reducedMotion - Whether Reduce Motion is on; the animations become
 * short fades and the layout lands at once.
 */
export function useListMotion(reducedMotion: boolean) {
  const change = useSharedValue<ListChangeKind>(ListChange.none);
  const opacity = useSharedValue(1);
  const translateX = useSharedValue(0);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (settle.current) clearTimeout(settle.current);
    },
    [],
  );

  const animate = useCallback(
    (kind: AnimatedListChange) => {
      change.value = kind;
      if (settle.current) clearTimeout(settle.current);
      settle.current = setTimeout(() => {
        change.value = ListChange.none;
      }, settleTime(kind));
    },
    [change],
  );

  const hide = useCallback(
    (direction: number) =>
      hideRows({ opacity, translateX }, direction, reducedMotion),
    [opacity, translateX, reducedMotion],
  );
  const show = useCallback(
    (direction: number) =>
      showRows({ opacity, translateX }, direction, reducedMotion),
    [opacity, translateX, reducedMotion],
  );

  const motion = useMemo<ListMotion>(() => {
    const enteringByStaggerStep = Array.from(
      { length: MAX_STAGGERED_ROWS + 1 },
      (_, index) => rowEntering(change, reducedMotion, index),
    );
    return {
      layout: listLayout(change, reducedMotion),
      rowEntering: (index) =>
        enteringByStaggerStep[Math.min(index, MAX_STAGGERED_ROWS)],
      rowExiting: rowExiting(change),
      rows: { opacity, translateX },
    };
  }, [change, opacity, translateX, reducedMotion]);

  return { motion, animate, hide, show };
}
