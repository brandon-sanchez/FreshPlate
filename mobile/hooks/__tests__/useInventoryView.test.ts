import AsyncStorage from "@react-native-async-storage/async-storage";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import { useInventoryView } from "@/hooks/useInventoryView";

async function openScreen() {
  const view = renderHook(() => useInventoryView());
  await waitFor(() => expect(view.result.current.hydrated).toBe(true));
  return view;
}

beforeEach(async () => {
  jest.restoreAllMocks();
  await AsyncStorage.clear();
});

it("opens grouped by location, soonest expiry first", async () => {
  const { result } = await openScreen();

  expect(result.current).toMatchObject({ groupBy: "Location", sortBy: "expiry-soonest" });
});

it("restores the grouping and sort chosen on an earlier visit", async () => {
  const first = await openScreen();
  act(() => {
    first.result.current.setGroupBy("Category");
    first.result.current.setSortBy("name-desc");
  });
  await waitFor(async () =>
    expect(JSON.parse((await AsyncStorage.getItem("freshplate.inventory-view")) ?? "{}")).toEqual({
      groupBy: "Category",
      sortBy: "name-desc",
    }),
  );
  first.unmount();

  const { result } = await openScreen();

  expect(result.current).toMatchObject({ groupBy: "Category", sortBy: "name-desc" });
});

it("falls back to the default for a stored value it does not recognize", async () => {
  await AsyncStorage.setItem(
    "freshplate.inventory-view",
    JSON.stringify({ groupBy: "Shelf", sortBy: "recent" }),
  );

  const { result } = await openScreen();

  expect(result.current).toMatchObject({ groupBy: "Location", sortBy: "recent" });
});

it("falls back to the defaults when the stored text is not JSON", async () => {
  await AsyncStorage.setItem("freshplate.inventory-view", "{not json");

  const { result } = await openScreen();

  expect(result.current).toMatchObject({ groupBy: "Location", sortBy: "expiry-soonest" });
});

it("opens with the defaults when storage cannot be read", async () => {
  jest.spyOn(AsyncStorage, "getItem").mockRejectedValueOnce(new Error("disk full"));

  const { result } = await openScreen();

  expect(result.current).toMatchObject({ groupBy: "Location", sortBy: "expiry-soonest" });
});

it("keeps a choice for the visit when storage cannot be written", async () => {
  jest.spyOn(AsyncStorage, "setItem").mockRejectedValue(new Error("disk full"));
  const { result } = await openScreen();

  await act(async () => result.current.setSortBy("amount-desc"));

  expect(result.current.sortBy).toBe("amount-desc");
});
