import React from "react";
import { renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

type Call = { method: string; args: unknown[] };

const mockCalls: Call[] = [];
const mockResult: { current: { data: unknown; error: unknown } } = {
  current: { data: [], error: null },
};

// Stands in for the PostgREST builder: each call is recorded and returns the
// builder, and awaiting the builder yields `mockResult`.
function mockBuilder(): unknown {
  const builder: unknown = new Proxy(
    {},
    {
      get: (_, method: string) =>
        method === "then"
          ? (
              resolve: (v: unknown) => unknown,
              reject: (e: unknown) => unknown,
            ) => Promise.resolve(mockResult.current).then(resolve, reject)
          : (...args: unknown[]) => {
              mockCalls.push({ method, args });
              return builder;
            },
    },
  );
  return builder;
}

jest.mock("@/lib/supabase", () => ({
  supabase: {
    from: (...args: unknown[]) => {
      mockCalls.push({ method: "from", args });
      return mockBuilder();
    },
  },
}));

const mockHouseholdId = { current: "household-1" as string | null };
jest.mock("@/stores/auth", () => ({
  useAuthStore: jest.fn(
    (selector: (state: { householdId: string | null }) => unknown) =>
      selector({ householdId: mockHouseholdId.current }),
  ),
}));

import { useHouseholdFoods } from "@/hooks/useHouseholdFoods";

let client: QueryClient;

function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(QueryClientProvider, { client }, children);
}

function localTimestamp(y: number, m: number, d: number, hour: number): string {
  return new Date(y, m - 1, d, hour).toISOString();
}

const calls = (method: string) =>
  mockCalls.filter((call) => call.method === method).map((call) => call.args);

const foodRow = {
  category_id: null,
  each_label: null,
  grams_per_each: null,
  ml_per_each: null,
  archived_at: null,
  merged_into_id: null,
  lots: [],
};

const milkRow = {
  ...foodRow,
  id: "food-milk",
  name: "Milk",
  name_key: "milk",
  category_id: "cat-dairy",
  stock_base: "ml",
  lots: [
    {
      initial_quantity: 1000,
      package_size: 1000,
      package_label: "bottle",
      storage_location: "fridge",
      expiration_date: "2026-11-08",
      created_at: localTimestamp(2026, 11, 1, 23),
    },
  ],
};

const cokeRow = {
  ...foodRow,
  id: "food-coke",
  name: "Coke",
  name_key: "coke",
  category_id: "cat-bev",
  stock_base: "each",
  each_label: "can",
  ml_per_each: 330,
  lots: [
    {
      initial_quantity: 12,
      package_size: null,
      package_label: null,
      storage_location: "pantry",
      expiration_date: null,
      created_at: localTimestamp(2026, 11, 5, 9),
    },
  ],
};

const saltRow = {
  ...foodRow,
  id: "food-salt",
  name: "Salt",
  name_key: "salt",
  stock_base: "g",
  archived_at: "2026-11-02T00:00:00Z",
};

const wholeMilkRow = {
  ...saltRow,
  id: "food-whole-milk",
  name: "Whole milk",
  name_key: "whole milk",
  stock_base: "ml",
  merged_into_id: "food-milk",
};

async function loadFoods() {
  const { result } = renderHook(() => useHouseholdFoods(), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  return result.current.data!;
}

describe("useHouseholdFoods", () => {
  beforeEach(() => {
    client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    mockCalls.length = 0;
    mockResult.current = { data: [], error: null };
    mockHouseholdId.current = "household-1";
  });

  it("reads every food of the household, archived ones included, with its stored name key", async () => {
    await loadFoods();

    expect(calls("from")).toEqual([["foods"]]);
    expect(calls("eq")).toEqual([["household_id", "household-1"]]);
    expect(calls("is")).toEqual([]);
    expect(calls("select")[0][0]).toMatch(
      /name_key.*archived_at.*merged_into_id/s,
    );
    expect(
      client
        .getQueryCache()
        .find({ queryKey: ["inventory", "household-1", "foods"] }),
    ).toBeDefined();
  });

  it("takes the last lot from lots not corrected away, keeping lots still in stock", async () => {
    await loadFoods();

    expect(calls("or")).toEqual([
      [
        "depleted_reason.is.null,depleted_reason.neq.corrected",
        { referencedTable: "lots" },
      ],
    ]);
  });

  it("orders foods by their last lot and maps stock, package, shelf life and status", async () => {
    mockResult.current = {
      data: [saltRow, milkRow, wholeMilkRow, cokeRow],
      error: null,
    };

    expect(await loadFoods()).toEqual([
      {
        id: "food-coke",
        name: "Coke",
        nameKey: "coke",
        categoryId: "cat-bev",
        stock: {
          base: "each",
          eachLabel: "can",
          sizeEach: { amount: 330, base: "ml" },
        },
        lastLot: {
          storage: "pantry",
          shelfLifeDays: null,
          initialQuantity: 12,
          package: null,
        },
        status: { kind: "live" },
      },
      {
        id: "food-milk",
        name: "Milk",
        nameKey: "milk",
        categoryId: "cat-dairy",
        stock: { base: "ml" },
        lastLot: {
          storage: "fridge",
          shelfLifeDays: 7,
          initialQuantity: 1000,
          package: { label: "bottle", size: 1000 },
        },
        status: { kind: "live" },
      },
      {
        id: "food-salt",
        name: "Salt",
        nameKey: "salt",
        categoryId: null,
        stock: { base: "g" },
        lastLot: null,
        status: { kind: "archived" },
      },
      {
        id: "food-whole-milk",
        name: "Whole milk",
        nameKey: "whole milk",
        categoryId: null,
        stock: { base: "ml" },
        lastLot: null,
        status: { kind: "merged", intoId: "food-milk" },
      },
    ]);
  });

  it("has no shelf life for a lot dated on or before the day it was added", async () => {
    const sameDay = {
      ...milkRow,
      lots: [{ ...milkRow.lots[0], expiration_date: "2026-11-01" }],
    };
    mockResult.current = { data: [sameDay], error: null };

    expect((await loadFoods())[0].lastLot?.shelfLifeDays).toBeNull();
  });

  it("surfaces a query error", async () => {
    mockResult.current = { data: null, error: new Error("boom") };
    const { result } = renderHook(() => useHouseholdFoods(), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe("boom");
  });

  it("waits for the household id", () => {
    mockHouseholdId.current = null;
    const { result } = renderHook(() => useHouseholdFoods(), { wrapper });

    expect(result.current.fetchStatus).toBe("idle");
    expect(mockCalls).toEqual([]);
  });
});
