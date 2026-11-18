import AsyncStorage from "@react-native-async-storage/async-storage";
import type { SteerDirection } from "@/lib/recipe-steering";

/**
 * What the cook did to one feed session's cards that the backend doesn't
 * store, kept on the device so a restored feed looks the way the cook left it.
 */
export type RecipeFeedMemory = {
  sessionId: string;
  /** Cards the cook discarded or steering swept away or held back. */
  dismissedIds: string[];
  /** The session's "More like this" and "Less like this" picks, oldest first. */
  signals: { direction: SteerDirection; recipeId: string }[];
};

const NEWEST_SESSION_MEMORY_KEY = "freshplate.recipe-feed-memory";

const isText = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isSignal = (value: unknown) =>
  isRecord(value) &&
  (value.direction === "more" || value.direction === "less") &&
  isText(value.recipeId);

function isMemory(value: unknown): value is RecipeFeedMemory {
  return (
    isRecord(value) &&
    isText(value.sessionId) &&
    Array.isArray(value.dismissedIds) &&
    value.dismissedIds.every(isText) &&
    Array.isArray(value.signals) &&
    value.signals.every(isSignal)
  );
}

/**
 * Returns the stored memory for `sessionId`, or an empty one when the device
 * holds none for that session or can't read it. Never rejects.
 */
export async function loadRecipeFeedMemory(
  sessionId: string,
): Promise<RecipeFeedMemory> {
  const empty = { sessionId, dismissedIds: [], signals: [] };
  try {
    const raw = await AsyncStorage.getItem(NEWEST_SESSION_MEMORY_KEY);
    const stored: unknown = raw ? JSON.parse(raw) : null;
    return isMemory(stored) && stored.sessionId === sessionId ? stored : empty;
  } catch (error) {
    console.warn("Failed to read recipe feed memory:", error);
    return empty;
  }
}

/**
 * Stores `memory` in place of any earlier session's. Never rejects: a failed
 * write means a restored feed can show cards the cook dismissed and lose the
 * steer picks.
 */
export async function saveRecipeFeedMemory(memory: RecipeFeedMemory): Promise<void> {
  try {
    await AsyncStorage.setItem(NEWEST_SESSION_MEMORY_KEY, JSON.stringify(memory));
  } catch (error) {
    console.warn("Failed to save recipe feed memory:", error);
  }
}
