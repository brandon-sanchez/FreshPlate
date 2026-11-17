import { useRef, useState } from "react";
import type { ViewabilityConfig, ViewToken } from "react-native";

const VISIBLE_PERCENT = 15;

/**
 * Tracks which rows of a virtualized list have been on screen, so rows can
 * defer work such as a paid image request until the user reaches them.
 *
 * Spread `listProps` onto the `FlatList` or `SectionList`. Its `extraData`
 * re-renders the rows when `seen` grows. A row stays seen after it scrolls
 * away.
 *
 * @param keyOf - Returns the key to remember for a row, such as its food id.
 * @returns `seen`, the keys of every row seen so far, which keeps its
 * identity until a new key arrives, and `listProps` for the list.
 */
export function useSeenKeys<T>(keyOf: (item: T) => string) {
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set());
  const keyOfRef = useRef(keyOf);
  keyOfRef.current = keyOf;
  const viewabilityConfig = useRef<ViewabilityConfig>({
    itemVisiblePercentThreshold: VISIBLE_PERCENT,
  }).current;
  // The list reads this callback once, so it must keep its identity.
  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: ViewToken<T>[]; changed: ViewToken<T>[] }) => {
      setSeen((previous) => {
        const next = new Set(previous);
        // A SectionList reports its section headers and footers with a null index.
        for (const { item, index } of viewableItems) {
          if (index !== null) next.add(keyOfRef.current(item));
        }
        return next.size === previous.size ? previous : next;
      });
    },
  ).current;
  return {
    seen,
    listProps: { extraData: seen, viewabilityConfig, onViewableItemsChanged },
  };
}
