import AsyncStorage from "@react-native-async-storage/async-storage";
import { randomUUID } from "expo-crypto";
import { create } from "zustand";
import type { RecipeSuggestion } from "@/types/recipes";

type Scope = { userId: string; householdId: string };
export type ActiveCook = Scope & {
  operationId: string;
  recipe: RecipeSuggestion;
};
type State = {
  activeCook: ActiveCook | null;
  hydrated: boolean;
  pending: boolean;
  error: Error | null;
  hydrate: (userId: string, householdId: string) => Promise<void>;
  start: (
    userId: string,
    householdId: string,
    recipe: RecipeSuggestion,
  ) => Promise<ActiveCook>;
  clear: () => Promise<void>;
  leaveScope: () => void;
};

const keyFor = (scope: Scope) =>
  "freshplate.active-cook." +
  encodeURIComponent(scope.userId) +
  "." +
  encodeURIComponent(scope.householdId);
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function isRecipe(value: unknown): value is RecipeSuggestion {
  if (!record(value)) return false;
  return (
    text(value.recipe_id) &&
    text(value.title) &&
    positive(value.cook_time_minutes) &&
    Number.isInteger(value.cook_time_minutes) &&
    positive(value.servings) &&
    Number.isInteger(value.servings) &&
    typeof value.match_percent === "number" &&
    Number.isInteger(value.match_percent) &&
    value.match_percent >= 0 &&
    value.match_percent <= 100 &&
    Array.isArray(value.ingredients) &&
    value.ingredients.length > 0 &&
    value.ingredients.every(
      (item: unknown) =>
        record(item) &&
        text(item.name) &&
        (item.inventory_item_id === null || text(item.inventory_item_id)) &&
        positive(item.use_amount) &&
        text(item.unit),
    ) &&
    Array.isArray(value.steps) &&
    value.steps.length > 0 &&
    value.steps.every(text) &&
    Array.isArray(value.saves_expiring) &&
    value.saves_expiring.every(text)
  );
}

function isCook(value: unknown, scope: Scope): value is ActiveCook {
  return (
    record(value) &&
    value.userId === scope.userId &&
    value.householdId === scope.householdId &&
    typeof value.operationId === "string" &&
    uuid.test(value.operationId) &&
    isRecipe(value.recipe)
  );
}

function copyRecipe(recipe: RecipeSuggestion): RecipeSuggestion {
  return {
    ...recipe,
    ingredients: recipe.ingredients.map((item) => ({ ...item })),
    steps: [...recipe.steps],
    saves_expiring: [...recipe.saves_expiring],
  };
}
function copyCook(cook: ActiveCook): ActiveCook {
  return { ...cook, recipe: copyRecipe(cook.recipe) };
}

export function createActiveCookStore() {
  return create<State>((set, get) => {
    let binding: Scope | "unbound" | "signed-out" = "unbound";
    let revision = 0;
    let pendingCount = 0;
    const queues = new Map<string, Promise<void>>();

    function requireScope(expected: number) {
      if (revision !== expected || typeof binding !== "object")
        throw new Error("Cooking account changed");
    }

    function enqueue<T>(
      target: Scope,
      operation: () => Promise<T>,
    ): Promise<T> {
      const expected = revision;
      const key = keyFor(target);
      pendingCount += 1;
      set({ pending: true });
      const result = (queues.get(key) ?? Promise.resolve()).then(async () => {
        requireScope(expected);
        try {
          return await operation();
        } catch (cause) {
          if (revision === expected) {
            set({
              error:
                cause instanceof Error
                  ? cause
                  : new Error("Unable to update cooking progress"),
            });
          }
          throw cause;
        } finally {
          if (revision === expected) {
            pendingCount -= 1;
            set({ pending: pendingCount > 0 });
          }
        }
      });
      const settled = result.then(
        () => undefined,
        () => undefined,
      );
      queues.set(key, settled);
      void settled.then(() => {
        if (queues.get(key) === settled) queues.delete(key);
      });
      return result;
    }

    return {
      activeCook: null,
      hydrated: false,
      pending: false,
      error: null,
      hydrate: (userId, householdId) => {
        const target = { userId, householdId };
        if (typeof binding !== "object" || keyFor(binding) !== keyFor(target)) {
          binding = target;
          revision += 1;
          pendingCount = 0;
          set({
            activeCook: null,
            hydrated: false,
            pending: false,
            error: null,
          });
        }
        const expected = revision;
        return enqueue(target, async () => {
          set({ hydrated: false, error: null });
          const raw = await AsyncStorage.getItem(keyFor(target));
          requireScope(expected);
          let restored: unknown = null;
          if (raw !== null) {
            try {
              restored = JSON.parse(raw);
            } catch {
              /* Invalid JSON is discarded below. */
            }
            if (!isCook(restored, target)) {
              await AsyncStorage.removeItem(keyFor(target));
              requireScope(expected);
              restored = null;
            }
          }
          set({
            activeCook: isCook(restored, target) ? restored : null,
            hydrated: true,
          });
        }).catch(() => undefined);
      },
      start: (userId, householdId, recipe) => {
        const target = { userId, householdId };
        if (
          binding === "signed-out" ||
          (typeof binding === "object" && keyFor(binding) !== keyFor(target))
        )
          return Promise.reject(new Error("Cooking account changed"));
        if (!isRecipe(recipe))
          return Promise.reject(new Error("Recipe cannot be used for cooking"));
        if (binding === "unbound") void get().hydrate(userId, householdId);
        const expected = revision;
        const snapshot = copyRecipe(recipe);
        return enqueue(target, async () => {
          if (!get().hydrated)
            throw new Error("Restore cooking progress before starting");
          const current = get().activeCook;
          if (current) {
            if (current.recipe.recipe_id !== snapshot.recipe_id)
              throw new Error(
                "Finish the current cook before starting another",
              );
            return copyCook(current);
          }
          const cook = {
            ...target,
            operationId: randomUUID(),
            recipe: snapshot,
          };
          await AsyncStorage.setItem(keyFor(target), JSON.stringify(cook));
          requireScope(expected);
          set({ activeCook: cook, error: null });
          return copyCook(cook);
        });
      },
      clear: () => {
        if (typeof binding !== "object") return Promise.resolve();
        const target = binding;
        const expected = revision;
        return enqueue(target, async () => {
          if (!get().hydrated)
            throw new Error("Restore cooking progress before clearing it");
          if (get().activeCook) await AsyncStorage.removeItem(keyFor(target));
          requireScope(expected);
          set({ activeCook: null, error: null });
        });
      },
      leaveScope: () => {
        binding = "signed-out";
        revision += 1;
        pendingCount = 0;
        set({ activeCook: null, hydrated: false, pending: false, error: null });
      },
    };
  });
}

export const useActiveCookStore = createActiveCookStore();
