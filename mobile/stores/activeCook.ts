import AsyncStorage from "@react-native-async-storage/async-storage";
import { randomUUID } from "expo-crypto";
import { create } from "zustand";
import type { RecipeSuggestion } from "@/types/recipes";

export type ActiveCook = { userId: string; householdId: string; operationId: string; recipe: RecipeSuggestion };
type State = { activeCook: ActiveCook | null; hydrated: boolean; pending: boolean; error: Error | null; hydrate: (userId: string, householdId: string) => Promise<void>; start: (userId: string, householdId: string, recipe: RecipeSuggestion) => Promise<ActiveCook>; clear: () => Promise<void> };
const keyFor = (u: string, h: string) => `freshplate.active-cook.${u}.${h}`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function isRecipe(v: unknown): v is RecipeSuggestion {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return typeof r.recipe_id === "string" && typeof r.title === "string" && Number.isInteger(r.cook_time_minutes) && Number.isInteger(r.servings) && Number.isInteger(r.match_percent) && Array.isArray(r.ingredients) && Array.isArray(r.steps) && Array.isArray(r.saves_expiring) && r.ingredients.every((x) => { if (!x || typeof x !== "object") return false; const i = x as Record<string, unknown>; return typeof i.name === "string" && (i.inventory_item_id === null || typeof i.inventory_item_id === "string") && finite(i.use_amount) && typeof i.unit === "string"; }) && r.steps.every((x) => typeof x === "string") && r.saves_expiring.every((x) => typeof x === "string");
}
function isCook(v: unknown, userId: string, householdId: string): v is ActiveCook {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return c.userId === userId && c.householdId === householdId && typeof c.operationId === "string" && uuid.test(c.operationId) && isRecipe(c.recipe);
}
let epoch = 0;
let queue: Promise<unknown> = Promise.resolve();
let reserved: ActiveCook | null = null;
let reservedPromise: Promise<ActiveCook> | null = null;
function enqueue<T>(operation: () => Promise<T>): Promise<T> { const next = queue.catch(() => undefined).then(operation); queue = next.catch(() => undefined); return next; }

export const useActiveCookStore = create<State>((set, get) => ({
  activeCook: null, hydrated: false, pending: false, error: null,
  hydrate: (userId, householdId) => {
    const currentEpoch = ++epoch; reserved = null; reservedPromise = null; set({ activeCook: null, hydrated: false, error: null });
    return (async () => {
      let raw: string | null;
      try {
        raw = await AsyncStorage.getItem(keyFor(userId, householdId));
      } catch (cause) {
        if (currentEpoch === epoch) set({ hydrated: true, error: cause instanceof Error ? cause : new Error("Unable to restore active cook") });
        return;
      }
      if (currentEpoch !== epoch) return;
      if (!raw) { set({ hydrated: true }); return; }
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch (cause) { await AsyncStorage.removeItem(keyFor(userId, householdId)); if (currentEpoch === epoch) set({ hydrated: true, error: cause instanceof Error ? cause : new Error("Unable to restore active cook") }); return; }
      if (!isCook(parsed, userId, householdId)) { await AsyncStorage.removeItem(keyFor(userId, householdId)); if (currentEpoch === epoch) set({ hydrated: true }); return; }
      if (currentEpoch === epoch) set({ activeCook: clone(parsed), hydrated: true });
    })();
  },
  start: (userId, householdId, recipe) => {
    const current = reserved ?? get().activeCook;
    if (current) { if (current.userId === userId && current.householdId === householdId && current.recipe.recipe_id === recipe.recipe_id) return reservedPromise ?? Promise.resolve(current); return Promise.reject(new Error("Finish the current cook before starting another")); }
    const currentEpoch = epoch;
    const cook: ActiveCook = { userId, householdId, operationId: randomUUID(), recipe: clone(recipe) };
    reserved = cook; set({ pending: true, error: null });
    const pending = enqueue(async () => { await AsyncStorage.setItem(keyFor(userId, householdId), JSON.stringify(cook)); if (currentEpoch === epoch) set({ activeCook: cook, pending: false, hydrated: true }); return cook; }).catch((cause) => { if (currentEpoch === epoch) { reserved = null; reservedPromise = null; set({ pending: false, error: cause instanceof Error ? cause : new Error("Unable to save active cook") }); } throw cause; });
    reservedPromise = pending; return pending;
  },
  clear: () => {
    const currentEpoch = ++epoch; const current = reserved ?? get().activeCook; reserved = null; reservedPromise = null;
    if (!current) { set({ activeCook: null, hydrated: true, pending: false }); return Promise.resolve(); }
    set({ activeCook: null, pending: true });
    return enqueue(async () => { await AsyncStorage.removeItem(keyFor(current.userId, current.householdId)); if (currentEpoch === epoch) set({ activeCook: null, pending: false, hydrated: true, error: null }); });
  },
}));
