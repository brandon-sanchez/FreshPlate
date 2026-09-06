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
  storage.getItem.mockResolvedValue(null);
  storage.setItem.mockResolvedValue(undefined);
  storage.removeItem.mockResolvedValue(undefined);
  useActiveCookStore.setState({ activeCook: null, hydrated: false, pending: false, error: null });
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

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

it("start before hydration preserves an existing persisted operation", async () => {
  const saved = { userId: "u1", householdId: "h1", operationId: "11111111-1111-4111-8111-111111111111", recipe };
  storage.getItem.mockResolvedValueOnce(JSON.stringify(saved));
  const started = await useActiveCookStore.getState().start("u1", "h1", recipe);
  expect(started.operationId).toBe(saved.operationId);
  expect(storage.setItem).not.toHaveBeenCalled();
});

it("fails closed after a hydration read error", async () => {
  storage.getItem.mockRejectedValueOnce(new Error("disk error"));
  await useActiveCookStore.getState().hydrate("u1", "h1");
  await expect(useActiveCookStore.getState().start("u1", "h1", recipe)).rejects.toThrow();
  expect(storage.setItem).not.toHaveBeenCalled();
});

it("settles pending start state when hydration overlaps a write", async () => {
  let complete: (() => void) | undefined;
  storage.setItem.mockImplementationOnce(() => new Promise<void>((resolve) => { complete = resolve; }));
  const started = useActiveCookStore.getState().start("u1", "h1", recipe);
  await tick();
  const hydrated = useActiveCookStore.getState().hydrate("u1", "h1");
  complete?.();
  await Promise.all([started, hydrated]);
  expect(useActiveCookStore.getState().pending).toBe(false);
  expect(useActiveCookStore.getState().activeCook).not.toBeNull();
});

it("keeps clear retryable after a remove failure", async () => {
  await useActiveCookStore.getState().start("u1", "h1", recipe);
  storage.removeItem.mockRejectedValueOnce(new Error("disk error"));
  await expect(useActiveCookStore.getState().clear()).rejects.toThrow("disk error");
  await useActiveCookStore.getState().clear();
  expect(storage.removeItem).toHaveBeenCalledTimes(2);
});

it("does not alias the returned cook snapshot", async () => {
  const started = await useActiveCookStore.getState().start("u1", "h1", recipe);
  started.recipe.steps.push("mutated");
  expect(useActiveCookStore.getState().activeCook?.recipe.steps).toEqual(["Cook"]);
});

it("cannot resurrect a cook when hydration overlaps clear", async () => {
  await useActiveCookStore.getState().start("u1", "h1", recipe);
  let complete: (() => void) | undefined;
  storage.removeItem.mockImplementationOnce(() => new Promise<void>((resolve) => { complete = resolve; }));
  const cleared = useActiveCookStore.getState().clear();
  await tick();
  storage.getItem.mockResolvedValueOnce(JSON.stringify({ userId: "u1", householdId: "h1", operationId: "11111111-1111-4111-8111-111111111111", recipe }));
  const hydrated = useActiveCookStore.getState().hydrate("u1", "h1");
  complete?.();
  await Promise.all([cleared, hydrated]);
  expect(useActiveCookStore.getState().activeCook).toBeNull();
});

it("rejects a stale old-user start after a new auth scope hydrates", async () => {
  await useActiveCookStore.getState().hydrate("new-user", "new-household");
  await expect(useActiveCookStore.getState().start("old-user", "old-household", recipe)).rejects.toThrow();
  expect(useActiveCookStore.getState().activeCook).toBeNull();
});
