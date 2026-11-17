import { act, renderHook } from "@testing-library/react-native";
import type { ViewToken } from "react-native";
import { useSeenKeys } from "@/hooks/useSeenKeys";

type Row = { foodId: string };

function token(foodId: string): ViewToken<Row> {
  return { item: { foodId }, key: foodId, index: 0, isViewable: true };
}

it("remembers every row that has been on screen", () => {
  const { result } = renderHook(() => useSeenKeys<Row>((row) => row.foodId));
  expect(result.current.seen.size).toBe(0);

  act(() =>
    result.current.listProps.onViewableItemsChanged({
      viewableItems: [token("a"), token("b")],
      changed: [],
    }),
  );
  act(() =>
    result.current.listProps.onViewableItemsChanged({
      viewableItems: [token("c")],
      changed: [],
    }),
  );

  expect([...result.current.seen]).toEqual(["a", "b", "c"]);
});

it("keeps the same set, so the list skips a re-render, when no new row comes on screen", () => {
  const { result } = renderHook(() => useSeenKeys<Row>((row) => row.foodId));
  act(() =>
    result.current.listProps.onViewableItemsChanged({
      viewableItems: [token("a")],
      changed: [],
    }),
  );
  const before = result.current.seen;

  act(() =>
    result.current.listProps.onViewableItemsChanged({
      viewableItems: [token("a")],
      changed: [],
    }),
  );

  expect(result.current.seen).toBe(before);
});

it("skips section headers", () => {
  const { result } = renderHook(() => useSeenKeys<Row>((row) => row.foodId));
  act(() =>
    result.current.listProps.onViewableItemsChanged({
      viewableItems: [{ ...token("header"), index: null }, token("a")],
      changed: [],
    }),
  );

  expect([...result.current.seen]).toEqual(["a"]);
});
