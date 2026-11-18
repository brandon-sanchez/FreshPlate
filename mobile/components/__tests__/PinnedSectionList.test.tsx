import React from "react";
import { FlatList, Text } from "react-native";
import { act, render, screen } from "@testing-library/react-native";
import { useSharedValue } from "react-native-reanimated";
import PinnedSectionList from "@/components/PinnedSectionList";

type Row = { id: string };
const sections = [
  { key: "fridge", data: [{ id: "milk" }, { id: "eggs" }] },
  { key: "pantry", data: [{ id: "rice" }] },
];

function List({ onViewableItemsChanged }: { onViewableItemsChanged: jest.Mock }) {
  const opacity = useSharedValue(1);
  const translateX = useSharedValue(0);
  return (
    <PinnedSectionList<Row, (typeof sections)[number]>
      rowsMotion={{ opacity, translateX }}
      sections={sections}
      keyExtractor={(row) => row.id}
      renderItem={({ item, index }) => <Text>{`${item.id} ${index}`}</Text>}
      renderSectionHeader={({ section }) => <Text>{section.key.toUpperCase()}</Text>}
      pinned={<Text>Controls</Text>}
      onViewableItemsChanged={onViewableItemsChanged}
    />
  );
}

function renderList(onViewableItemsChanged = jest.fn()) {
  render(<List onViewableItemsChanged={onViewableItemsChanged} />);
  return onViewableItemsChanged;
}

it("renders the pinned content, then each section's header and rows numbered within the section", () => {
  renderList();

  expect(screen.getAllByText(/^(Controls|FRIDGE|PANTRY|\w+ \d)$/).map((node) => node.props.children)).toEqual([
    "Controls",
    "FRIDGE",
    "milk 0",
    "eggs 1",
    "PANTRY",
    "rice 0",
  ]);
});

it("reports only rows as viewable, with their index in their section", () => {
  const listener = renderList();
  const list = screen.UNSAFE_getByType(FlatList);
  const tokens = list.props.data.map((item: unknown, index: number) => ({
    item,
    index,
    key: String(index),
    isViewable: true,
  }));

  act(() => list.props.onViewableItemsChanged({ viewableItems: tokens, changed: [] }));

  expect(
    listener.mock.calls[0][0].viewableItems.map((token: { item: Row; index: number }) => [token.item.id, token.index]),
  ).toEqual([
    ["milk", 0],
    ["eggs", 1],
    ["rice", 0],
  ]);
});
