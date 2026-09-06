import AsyncStorage from "@react-native-async-storage/async-storage";
import { useActiveCookStore } from "@/stores/activeCook";

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(), setItem: jest.fn(), removeItem: jest.fn(),
}));
jest.mock("expo-crypto", () => ({ randomUUID: () => "11111111-1111-4111-8111-111111111111" }));

const recipe = { recipe_id: "r1", title: "Pasta", cook_time_minutes: 20, servings: 2, ingredients: [{ name: "Tomato", inventory_item_id: "i1", use_amount: 1, unit: "each" }], steps: ["Cook"], match_percent: 90, saves_expiring: [] };
const storage = AsyncStorage as jest.Mocked<typeof AsyncStorage>;

beforeEach(() => {
  jest.clearAllMocks();
  useActiveCookStore.setState({ activeCook: null, hydrated: false, pending: false, error: null });
});

it("persists and recovers an active cook", async () => {
  storage.getItem.mockResolvedValueOnce(null);
  await useActiveCookStore.getState().hydrate("u1", "h1");
  const cook = await useActiveCookStore.getState().start("u1", "h1", recipe);
  expect(cook.operationId).toBe("11111111-1111-4111-8111-111111111111");
  expect(storage.setItem).toHaveBeenCalled();
  storage.getItem.mockResolvedValueOnce(JSON.stringify(cook));
  await useActiveCookStore.getState().hydrate("u1", "h1");
  expect(useActiveCookStore.getState().activeCook).toEqual(cook);
});

it("clears corrupt persistence and reports storage failures", async () => {
  storage.getItem.mockResolvedValueOnce("not-json");
  await useActiveCookStore.getState().hydrate("u1", "h1");
  expect(storage.removeItem).toHaveBeenCalled();
  storage.getItem.mockRejectedValueOnce(new Error("disk unavailable"));
  await useActiveCookStore.getState().hydrate("u1", "h1");
  expect(useActiveCookStore.getState().error?.message).toBe("disk unavailable");
});

it("rejects replacement while one cook is active", async () => {
  await useActiveCookStore.getState().start("u1", "h1", recipe);
  await expect(useActiveCookStore.getState().start("u1", "h1", { ...recipe, recipe_id: "r2" })).rejects.toThrow("Finish the current cook");
});

it("does not restore stale auth results after a user switch", async () => {
  let resolve: (value: string | null) => void = () => undefined;
  storage.getItem.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
  const first = useActiveCookStore.getState().hydrate("u1", "h1");
  await useActiveCookStore.getState().hydrate("u2", "h2");
  resolve(null);
  await first;
  expect(useActiveCookStore.getState().hydrated).toBe(true);
  expect(useActiveCookStore.getState().activeCook).toBeNull();
});
