import AsyncStorage from "@react-native-async-storage/async-storage";
import { act, renderHook } from "@testing-library/react-native";
import Toast from "react-native-toast-message";
import { useActiveCook } from "@/hooks/useActiveCook";
import { useActiveCookStore } from "@/stores/activeCook";
import { useAuthStore } from "@/stores/auth";

jest.mock("@/lib/supabase", () => ({ supabase: {} }));
jest.mock("react-native-toast-message", () => ({ show: jest.fn() }));
jest.mock("expo-crypto", () => ({
  randomUUID: () => "11111111-1111-4111-8111-111111111111",
}));

const recipe = (id: string, title: string) => ({
  recipe_id: id,
  title,
  cook_time_minutes: 20,
  servings: 2,
  match_percent: 90,
  ingredients: [
    { name: "Tomato", inventory_item_id: "i1", use_amount: 1, unit: "each" },
  ],
  steps: ["Cook"],
  saves_expiring: [],
});
const pasta = recipe("r1", "Pasta");
const soup = recipe("r2", "Soup");

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  useAuthStore.setState({ user: { id: "u1" } as never, householdId: "h1" });
  await useActiveCookStore.getState().hydrate("u1", "h1");
});

afterEach(() => useActiveCookStore.getState().leaveScope());

it("persists one active cook and refuses a second recipe until it is finished", async () => {
  const { result } = renderHook(() => useActiveCook());

  await act(async () => {
    expect(await result.current.start(pasta)).toBe(true);
  });
  expect(result.current.activeCook?.recipe.title).toBe("Pasta");
  expect(await AsyncStorage.getItem("freshplate.active-cook.u1.h1")).toContain(
    "11111111-1111-4111-8111-111111111111",
  );

  await act(async () => {
    expect(await result.current.start(soup)).toBe(false);
  });
  expect(result.current.activeCook?.recipe.title).toBe("Pasta");
  expect(Toast.show).toHaveBeenCalledWith(
    expect.objectContaining({ text2: "You're still cooking Pasta." }),
  );

  await act(async () => {
    expect(await result.current.start(pasta)).toBe(true);
  });

  await act(async () => {
    expect(await result.current.finish()).toBe(true);
  });
  expect(result.current.activeCook).toBeNull();
  expect(await AsyncStorage.getItem("freshplate.active-cook.u1.h1")).toBeNull();
});
