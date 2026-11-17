import React from "react";
import { render, userEvent } from "@testing-library/react-native";
import type { InventoryItem } from "@/hooks/useInventoryItems";
import { stackLots } from "@/lib/foodRows";
import InventoryRow from "@/components/InventoryRow";
import LotOutcomeSwipe from "@/components/LotOutcomeSwipe";

// On iOS, ReanimatedSwipeable's tap gesture keeps a gesture-handler RectButton
// inside it from firing onPress. This RectButton keeps its children and drops
// onPress to match, so only a JS Pressable row can open the food.
jest.mock("react-native-gesture-handler", () => {
  const { View } = jest.requireActual("react-native");
  return {
    ...jest.requireActual("react-native-gesture-handler"),
    RectButton: ({ children, style }: { children?: React.ReactNode; style?: object }) => (
      <View style={style}>{children}</View>
    ),
  };
});
jest.mock("@/hooks/useLotOutcome", () => ({ useLotOutcome: () => ({ record: jest.fn() }) }));
jest.mock("@expo/vector-icons/FontAwesome", () => () => null);

const SPINACH: InventoryItem = {
  id: "lot-1",
  food_id: "food-1",
  name: "Spinach",
  quantity: 1,
  unit: "bag",
  expiration_date: null,
  storage_location: "fridge",
  is_leftover: false,
  notes: null,
  added_by: null,
  opened_at: null,
  created_at: "2026-11-01T12:00:00+00:00",
  updated_at: "2026-11-01T12:00:00.123456+00:00",
  initial_quantity: null,
  is_estimate: false,
  whole_units_only: false,
  category: { id: "c1", name: "Produce", icon: "leaf" },
};

it("opens the food when a row inside the swipe actions is tapped", async () => {
  const [row] = stackLots([SPINACH]);
  const onPress = jest.fn();
  const screen = render(
    <LotOutcomeSwipe lotIds={[SPINACH.id]} name={SPINACH.name}>
      <InventoryRow row={row} onPress={onPress} />
    </LotOutcomeSwipe>,
  );

  await userEvent.press(screen.getByText("Spinach"));

  expect(onPress).toHaveBeenCalledWith(row);
});
