import { memo, useMemo } from "react";
import Animated from "react-native-reanimated";
import InventoryRow from "@/components/InventoryRow";
import LotOutcomeSwipe from "@/components/LotOutcomeSwipe";
import type { ListMotion } from "@/hooks/useListMotion";
import type { FoodRow } from "@/lib/foodRows";

const ROW_GAP = 6;

type InventoryListRowProps = {
  /** The food to show. */
  row: FoodRow;
  /** The row's position in its section, which staggers rows as a section opens. */
  index: number;
  /** When true, the row pulses once to draw the eye. */
  highlight: boolean;
  /** Whether the row may request the food's photo; see {@link InventoryRow}. */
  photoEnabled: boolean;
  /** Called with `row` on tap. Keep it stable so unchanged rows skip rendering. */
  onPress: (row: FoodRow) => void;
  /** The animations the row enters and leaves with. */
  motion: ListMotion;
};

/**
 * One row of the inventory list: an {@link InventoryRow} that swipes left to
 * record its counted batches as used up or tossed. It renders again only
 * when one of its props changes.
 */
function InventoryListRow({
  row,
  index,
  highlight,
  photoEnabled,
  onPress,
  motion,
}: InventoryListRowProps) {
  const lotIds = useMemo(() => row.countedLots.map((lot) => lot.id), [row]);
  return (
    <Animated.View
      entering={motion.rowEntering(index)}
      exiting={motion.rowExiting}
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
