import { useCallback, useEffect, useMemo, useRef } from "react";
import { useSharedValue } from "react-native-reanimated";
import {
  type AnimatedListChange,
  ListChange,
  type ListChangeKind,
  listLayout,
  MAX_STAGGERED_ROWS,
  rowEntering,
  rowExiting,
  settleTime,
} from "@/lib/listMotion";

/** The animations a list's rows and section headers take, from {@link useListMotion}. */
export type ListMotion = {
  /** The layout transition for list cells and section headers. */
  layout: ReturnType<typeof listLayout>;
  /** Returns the entering animation for the row at an index in its section. */
  rowEntering: (index: number) => ReturnType<typeof rowEntering>;
  /** The exiting animation for rows and section headers. */
  rowExiting: ReturnType<typeof rowExiting>;
};

/**
 * Returns the inventory list's animations and two calls that pick them.
 * `animate(kind)` makes the next list update a re-sort or a collapse, and
 * holds that kind for {@link settleTime} so the animation finishes; later
 * updates, such as a typed search or a scroll that mounts rows, land at
 * once. `slideToward(from, to)` makes the next update a change of grouping
 * whose rows slide in from the side of the chosen tab, by tab index. Call
 * either just before the state update it describes.
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
    (kind: AnimatedListChange) => {
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
      animate(ListChange.group);
    },
    [animate, direction],
  );

  // One entering animation per stagger step, so a memoized row gets the
  // same animation object on every render.
  const motion = useMemo<ListMotion>(() => {
    const entering = Array.from({ length: MAX_STAGGERED_ROWS + 1 }, (_, index) =>
      rowEntering(change, direction, reducedMotion, index),
    );
    return {
      layout: listLayout(change, reducedMotion),
      rowEntering: (index) => entering[Math.min(index, MAX_STAGGERED_ROWS)],
      rowExiting: rowExiting(change, direction, reducedMotion),
    };
  }, [change, direction, reducedMotion]);

  return { motion, animate, slideToward };
}
