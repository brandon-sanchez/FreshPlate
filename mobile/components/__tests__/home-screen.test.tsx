import React from "react";
import { act, render, screen } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SafeAreaProvider } from "react-native-safe-area-context";

type Result = { data: unknown; error: unknown };
type Deferred = { promise: Promise<Result>; resolve: (r: Result) => void };

function deferred(): Deferred {
  let resolve!: (r: Result) => void;
  const promise = new Promise<Result>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const mockProfile = { current: deferred() };
const mockLots = { current: deferred() };

jest.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) =>
      table === "profiles"
        ? { select: () => ({ eq: () => ({ maybeSingle: () => mockProfile.current.promise }) }) }
        : {
            select: () => ({
              eq: () => ({ is: () => ({ order: () => mockLots.current.promise }) }),
            }),
          },
  },
}));
jest.mock("@/stores/auth", () => ({
  useAuthStore: (selector: (s: object) => unknown) =>
    selector({ user: { id: "user-1", user_metadata: {} }, householdId: "household-1" }),
  firstNameFromMetadata: () => null,
}));
jest.mock("expo-router", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("@react-navigation/bottom-tabs", () => ({ useBottomTabBarHeight: () => 0 }));
jest.mock("@expo/vector-icons/FontAwesome", () => () => null);
jest.mock("@/hooks/useReducedMotion", () => ({ useReducedMotion: () => true }));
jest.mock("@/lib/image-api", () => ({ fetchFoodImage: () => new Promise(() => {}) }));

import HomeScreen from "@/app/(tabs)/index";

function inDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function lotRow(id: string, foodId: string, name: string, days: number, storage_location: string) {
  return {
    id,
    quantity: 1,
    initial_quantity: null,
    is_estimate: false,
    expiration_date: inDays(days),
    storage_location,
    notes: null,
    added_by: null,
    opened_at: null,
    created_at: "2026-11-01T12:00:00+00:00",
    updated_at: "2026-11-01T12:00:00+00:00",
    food: {
      id: foodId,
      name,
      stock_base: "g",
      each_label: null,
      whole_units_only: false,
      category: null,
    },
  };
}

function renderHome() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 44, right: 0, bottom: 34, left: 0 },
      }}
    >
      <QueryClientProvider client={client}>
        <HomeScreen />
      </QueryClientProvider>
    </SafeAreaProvider>,
  );
}

async function settle(target: Deferred, result: Result) {
  await act(async () => {
    target.resolve(result);
    await target.promise;
  });
}

beforeEach(() => {
  mockProfile.current = deferred();
  mockLots.current = deferred();
});

it("holds a skeleton instead of a made-up name or zero counts while the kitchen loads", () => {
  renderHome();

  expect(screen.getByLabelText("Loading your kitchen")).toBeTruthy();
  expect(screen.getByLabelText("Loading your name")).toBeTruthy();
  expect(screen.getByLabelText("In kitchen, loading")).toBeTruthy();
  expect(screen.queryByText("Set your name")).toBeNull();
  expect(screen.queryByText("0")).toBeNull();
  expect(screen.queryByText("Loading your fridge…")).toBeNull();
});

it("shows the name and the kitchen's counts once the profile and lots load", async () => {
  renderHome();

  await settle(mockProfile.current, {
    data: { id: "user-1", display_name: "Sam Cook", avatar_url: null },
    error: null,
  });
  await settle(mockLots.current, {
    data: [
      lotRow("milk-1", "milk", "Milk", 3, "fridge"),
      lotRow("milk-2", "milk", "Milk", 20, "freezer"),
      lotRow("rice-1", "rice", "Rice", 90, "pantry"),
      lotRow("cream-1", "cream", "Sour cream", -1, "fridge"),
    ],
    error: null,
  });

  expect(await screen.findByLabelText("3 foods in your kitchen")).toBeTruthy();
  expect(screen.queryByLabelText("Loading your kitchen")).toBeNull();
  expect(screen.getByText("Sam")).toBeTruthy();
  expect(screen.getByText("In kitchen")).toBeTruthy();
  expect(screen.getByLabelText("1 to use this week")).toBeTruthy();
  expect(screen.getByLabelText("1 expired")).toBeTruthy();
});

it("offers to set a name only after the profile loads without one", async () => {
  renderHome();
  await settle(mockLots.current, { data: [], error: null });
  expect(await screen.findByLabelText("0 foods in your kitchen")).toBeTruthy();
  expect(screen.queryByText("Set your name")).toBeNull();

  await settle(mockProfile.current, {
    data: { id: "user-1", display_name: null, avatar_url: null },
    error: null,
  });

  expect(await screen.findByText("Set your name")).toBeTruthy();
});

it("shows no counts when the kitchen fails to load", async () => {
  renderHome();
  await settle(mockProfile.current, {
    data: { id: "user-1", display_name: "Sam", avatar_url: null },
    error: null,
  });
  await settle(mockLots.current, { data: null, error: new Error("offline") });

  expect(await screen.findByText("Try again")).toBeTruthy();
  expect(screen.queryByText("0")).toBeNull();
  expect(screen.getAllByText("–")).toHaveLength(3);
  expect(screen.getByLabelText("In kitchen, unavailable")).toBeTruthy();
});
