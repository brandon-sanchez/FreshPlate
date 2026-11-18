import React from "react";
import { renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockRows = jest.fn();
const mockCalls: unknown[][] = [];

jest.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) => ({
      select: (columns: string) => ({
        eq: async (column: string, value: string) => {
          mockCalls.push([table, columns, column, value]);
          return { data: mockRows(), error: null };
        },
      }),
    }),
  },
}));
jest.mock("@/stores/auth", () => ({
  useAuthStore: (selector: (state: { householdId: string }) => unknown) =>
    selector({ householdId: "household-1" }),
}));

import { useFoodSubUnits } from "@/hooks/useFoodSubUnits";

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return React.createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  mockCalls.length = 0;
  mockRows.mockReset();
});

it("maps each food to its largest unit that splits one stock unit into whole parts", async () => {
  mockRows.mockReturnValue([
    { food_id: "garlic", unit_key: "clove", base_per_unit: 0.1 },
    { food_id: "garlic", unit_key: "bulb", base_per_unit: 1 },
    { food_id: "lemon", unit_key: "wedge", base_per_unit: 0.125 },
    { food_id: "lemon", unit_key: "half", base_per_unit: 0.5 },
    { food_id: "onion", unit_key: "slice", base_per_unit: 0.3 },
    { food_id: "rice", unit_key: "cup", base_per_unit: 185 },
  ]);

  const { result } = renderHook(() => useFoodSubUnits(), { wrapper });

  await waitFor(() =>
    expect(result.current).toEqual({
      garlic: { label: "clove", perUnit: 0.1 },
      lemon: { label: "half", perUnit: 0.5 },
    }),
  );
  expect(mockCalls).toEqual([
    ["food_units", "food_id, unit_key, base_per_unit", "household_id", "household-1"],
  ]);
});
