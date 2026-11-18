import { memo, useMemo } from "react";
import Animated, { type EntryExitAnimationFunction } from "react-native-reanimated";
import InventoryRow from "@/components/InventoryRow";
import LotOutcomeSwipe from "@/components/LotOutcomeSwipe";
import type { FoodRow } from "@/lib/foodRows";

const ROW_GAP = 6;

type InventoryListRowProps = {
  /** The food to show. */
  row: FoodRow;
  /** When true, the row pulses once to draw the eye. */
  highlight: boolean;
  /** Whether the row may request the food's photo. See {@link InventoryRow}. */
  photoEnabled: boolean;
  /** Called with `row` on tap. Keep it stable so unchanged rows skip rendering. */
  onPress: (row: FoodRow) => void;
  /** The animation the row mounts with, such as a fade as a filter reveals it. */
  entering: EntryExitAnimationFunction;
  /** The animation the row unmounts with. */
  exiting: EntryExitAnimationFunction;
};

/**
 * One row of the inventory list: an {@link InventoryRow} that swipes left to
 * record its counted batches as used up or tossed.
 */
function InventoryListRow({
  row,
  highlight,
  photoEnabled,
  onPress,
  entering,
  exiting,
}: InventoryListRowProps) {
  const lotIds = useMemo(() => row.countedLots.map((lot) => lot.id), [row]);
  return (
    <Animated.View
      entering={entering}
      exiting={exiting}
      style={{ paddingHorizontal: 16, paddingBottom: ROW_GAP }}
    >
      <LotOutcomeSwipe lotIds={lotIds} name={row.name}>
        <InventoryRow
          row={row}
          highlight={highlight}
          photoEnabled={photoEnabled}
          onPress={onPress}
        />
      </LotOutcomeSwipe>
    </Animated.View>
  );
}

export default memo(InventoryListRow);
