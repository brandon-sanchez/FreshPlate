import React from "react";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RecipeSuggestion } from "@/types/recipes";

const mockOrder = jest.fn();
const mockEq = jest.fn((_column: string, _value: unknown) => ({ order: mockOrder }));
const mockSelect = jest.fn(() => ({ eq: mockEq }));
let deleteError: Error | null = null;
const mockDeleteEq = jest.fn(() => ({ eq: mockDeleteEq, then: (resolve: (value: { error: Error | null }) => unknown) => resolve({ error: deleteError }) }));
const mockDelete = jest.fn(() => ({ eq: mockDeleteEq }));
const mockInsert = jest.fn(() => Promise.resolve({ error: null }));
const mockFrom = jest.fn((table: string) => ({ select: mockSelect, delete: mockDelete, insert: mockInsert, table }));
const household = { current: "household-a" as string | null };
const user = { current: { id: "user-a" } as { id: string } | null };

jest.mock("@/lib/supabase", () => ({ supabase: { from: (table: string) => mockFrom(table) } }));
jest.mock("@/stores/auth", () => ({
  useAuthStore: Object.assign(
    jest.fn((selector: (state: { householdId: string | null }) => unknown) => selector({ householdId: household.current })),
    { getState: () => ({ householdId: household.current, user: user.current }) },
  ),
}));

import { useSavedRecipes } from "@/hooks/useSavedRecipes";

const recipe = { recipe_id: "11111111-1111-4111-8111-111111111111", title: "Pasta", cook_time_minutes: 20, servings: 2, ingredients: [], steps: [], match_percent: 100, saves_expiring: [] } as RecipeSuggestion;
function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  return React.createElement(QueryClientProvider, { client }, children);
}

describe("useSavedRecipes", () => {
  beforeEach(() => { jest.clearAllMocks(); household.current = "household-a"; user.current = { id: "user-a" }; mockOrder.mockResolvedValue({ data: [], error: null }); });

  it("loads only the active household and exposes saved ids", async () => {
    mockOrder.mockResolvedValue({ data: [{ id: "s1", household_id: "household-a", recipe_id: recipe.recipe_id, recipe, saved_by: "user-a", created_at: "now" }], error: null });
    const { result } = renderHook(() => useSavedRecipes(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockFrom).toHaveBeenCalledWith("saved_recipes");
    expect(mockEq).toHaveBeenCalledWith("household_id", "household-a");
    expect(result.current.savedIds.has(recipe.recipe_id)).toBe(true);
    expect(result.current.data?.[0].recipe).toEqual(recipe);
  });

  it("surfaces list errors and does not query without a household", async () => {
    mockOrder.mockResolvedValue({ data: null, error: new Error("RLS denied") });
    const { result } = renderHook(() => useSavedRecipes(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe("RLS denied");
    household.current = null;
    const second = renderHook(() => useSavedRecipes(), { wrapper });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(second.result.current.fetchStatus).toBe("idle");
  });

  it("saves the immutable recipe id and full snapshot, then invalidates on success", async () => {
    const { result } = renderHook(() => useSavedRecipes(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    act(() => result.current.toggle({ recipe, saved: false }));
    await waitFor(() => expect(mockInsert).toHaveBeenCalled());
    expect(mockInsert).toHaveBeenCalledWith({ household_id: "household-a", recipe_id: recipe.recipe_id, recipe, saved_by: "user-a" });
  });

  it("deletes by household and recipe id and surfaces mutation failures", async () => {
    const { result } = renderHook(() => useSavedRecipes(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    act(() => result.current.toggle({ recipe, saved: true }));
    await waitFor(() => expect(mockDeleteEq).toHaveBeenCalledWith("recipe_id", recipe.recipe_id));
    deleteError = new Error("delete failed");
    act(() => result.current.toggle({ recipe, saved: true }));
    await waitFor(() => expect(result.current.toggleError?.message).toBe("delete failed"));
  });
});
