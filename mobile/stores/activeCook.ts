import AsyncStorage from "@react-native-async-storage/async-storage";
import { randomUUID } from "expo-crypto";
import { create } from "zustand";
import type { RecipeSuggestion } from "@/types/recipes";

export type ActiveCook = {
  userId: string;
  householdId: string;
  operationId: string;
  recipe: RecipeSuggestion;
};

type ActiveCookState = {
  activeCook: ActiveCook | null;
  hydrated: boolean;
  pending: boolean;
  error: Error | null;
  hydrate: (userId: string, householdId: string) => Promise<void>;
  start: (userId: string, householdId: string, recipe: RecipeSuggestion) => Promise<ActiveCook>;
  clear: () => Promise<void>;
};

const storageKey = (userId: string, householdId: string) =>
  `freshplate.active-cook.${userId}.${householdId}`;

function isRecipe(value: unknown): value is RecipeSuggestion {
  if (!value || typeof value !== "object") return false;
  const recipe = value as Record<string, unknown>;
  return typeof recipe.recipe_id === "string" && typeof recipe.title === "string" &&
    typeof recipe.cook_time_minutes === "number" && typeof recipe.servings === "number" &&
    Array.isArray(recipe.ingredients) && Array.isArray(recipe.steps) &&
    Array.isArray(recipe.saves_expiring);
}

function isActiveCook(value: unknown, userId: string, householdId: string): value is ActiveCook {
  if (!value || typeof value !== "object") return false;
  const cook = value as Record<string, unknown>;
  return cook.userId === userId && cook.householdId === householdId &&
    typeof cook.operationId === "string" && isRecipe(cook.recipe);
}

let hydrationRevision = 0;
let writeChain: Promise<void> = Promise.resolve();

export const useActiveCookStore = create<ActiveCookState>((set, get) => ({
  activeCook: null,
  hydrated: false,
  pending: false,
  error: null,

  hydrate: async (userId, householdId) => {
    const revision = ++hydrationRevision;
    set({ hydrated: false, error: null, activeCook: null });
    try {
      const raw = await AsyncStorage.getItem(storageKey(userId, householdId));
      if (revision !== hydrationRevision) return;
      if (!raw) {
        set({ hydrated: true });
        return;
      }
      const parsed: unknown = JSON.parse(raw);
      if (!isActiveCook(parsed, userId, householdId)) {
        await AsyncStorage.removeItem(storageKey(userId, householdId));
        if (revision === hydrationRevision) set({ hydrated: true });
        return;
      }
      set({ activeCook: parsed, hydrated: true });
    } catch (cause) {
      if (revision !== hydrationRevision) return;
      try {
        await AsyncStorage.removeItem(storageKey(userId, householdId));
      } catch {
        // Keep the original restore error when cleanup also fails.
      }
      set({ hydrated: true, error: cause instanceof Error ? cause : new Error("Unable to restore active cook") });
    }
  },

  start: async (userId, householdId, recipe) => {
    const current = get().activeCook;
    if (current) {
      if (current.userId === userId && current.householdId === householdId && current.recipe.recipe_id === recipe.recipe_id) return current;
      throw new Error("Finish the current cook before starting another");
    }
    const activeCook: ActiveCook = { userId, householdId, operationId: randomUUID(), recipe };
    set({ pending: true, error: null });
    try {
      const key = storageKey(userId, householdId);
      writeChain = writeChain.then(() => AsyncStorage.setItem(key, JSON.stringify(activeCook)));
      await writeChain;
      set({ activeCook, pending: false, hydrated: true });
      return activeCook;
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error("Unable to save active cook");
      set({ pending: false, error });
      throw error;
    }
  },

  clear: async () => {
    const current = get().activeCook;
    ++hydrationRevision;
    if (!current) {
      set({ activeCook: null, hydrated: true });
      return;
    }
    await AsyncStorage.removeItem(storageKey(current.userId, current.householdId));
    set({ activeCook: null, hydrated: true, error: null });
  },
}));
