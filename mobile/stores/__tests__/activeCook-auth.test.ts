import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  bindActiveCookAuthLifecycle,
  useActiveCookStore,
} from "@/stores/activeCook";
import { useAuthStore } from "@/stores/auth";

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
}));
jest.mock("expo-crypto", () => ({
  randomUUID: () => "11111111-1111-4111-8111-111111111111",
}));

const storage = AsyncStorage as jest.Mocked<typeof AsyncStorage>;
const recipe = {
  recipe_id: "r1",
  title: "Pasta",
  cook_time_minutes: 20,
  servings: 2,
  ingredients: [
    { name: "Tomato", inventory_item_id: "i1", use_amount: 1, unit: "each" },
  ],
  steps: ["Cook"],
  match_percent: 90,
  saves_expiring: [],
};
const user = { id: "u1" } as never;

beforeEach(() => {
  jest.clearAllMocks();
  storage.getItem.mockResolvedValue(null);
  storage.setItem.mockResolvedValue(undefined);
  storage.removeItem.mockResolvedValue(undefined);
  useActiveCookStore.getState().leaveScope();
  useAuthStore.setState({ user: null, householdId: null });
});

it("restores a saved cook for the authenticated scope", async () => {
  const saved = {
    userId: "u1",
    householdId: "h1",
    operationId: "11111111-1111-4111-8111-111111111111",
    recipe,
  };
  storage.getItem.mockResolvedValue(JSON.stringify(saved));
  const stop = bindActiveCookAuthLifecycle();
  useAuthStore.setState({ user, householdId: "h1" });
  await new Promise(setImmediate);
  expect(useActiveCookStore.getState().activeCook?.operationId).toBe(
    saved.operationId,
  );
  stop();
});

it("clears memory on logout while leaving persisted progress", async () => {
  const stop = bindActiveCookAuthLifecycle();
  useAuthStore.setState({ user, householdId: "h1" });
  await useActiveCookStore.getState().start("u1", "h1", recipe);
  storage.removeItem.mockClear();
  useAuthStore.setState({ user: null, householdId: null });
  expect(useActiveCookStore.getState().activeCook).toBeNull();
  expect(storage.removeItem).not.toHaveBeenCalled();
  stop();
});

it("does not show the old cook after a household switch", async () => {
  const stop = bindActiveCookAuthLifecycle();
  useAuthStore.setState({ user, householdId: "h1" });
  await useActiveCookStore.getState().start("u1", "h1", recipe);
  useAuthStore.setState({ user, householdId: "h2" });
  expect(useActiveCookStore.getState().activeCook).toBeNull();
  stop();
});

it("does not rehydrate on a token refresh for the same scope", async () => {
  const stop = bindActiveCookAuthLifecycle();
  useAuthStore.setState({ user, householdId: "h1" });
  await new Promise(setImmediate);
  storage.getItem.mockClear();
  useAuthStore.setState({
    user: { id: "u1", token: "new" } as never,
    householdId: "h1",
  });
  await new Promise(setImmediate);
  expect(storage.getItem).not.toHaveBeenCalled();
  stop();
});

it("unsubscribes and clears memory on cleanup", async () => {
  const stop = bindActiveCookAuthLifecycle();
  useAuthStore.setState({ user, householdId: "h1" });
  stop();
  storage.getItem.mockClear();
  useAuthStore.setState({ user, householdId: "h2" });
  await new Promise(setImmediate);
  expect(storage.getItem).not.toHaveBeenCalled();
  expect(useActiveCookStore.getState().activeCook).toBeNull();
});

it("reconciles an initially signed-out auth state before allowing starts", async () => {
  useActiveCookStore.setState({
    activeCook: {
      userId: "old",
      householdId: "h1",
      operationId: "11111111-1111-4111-8111-111111111111",
      recipe,
    },
    hydrated: true,
  });
  const stop = bindActiveCookAuthLifecycle();
  expect(useActiveCookStore.getState().activeCook).toBeNull();
  await expect(
    useActiveCookStore.getState().start("old", "h1", recipe),
  ).rejects.toThrow("Cooking account changed");
  stop();
});
