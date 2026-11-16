import { useCallback, useEffect, useRef, useState } from "react";
import { motionStagger, sweepExitDurationMs } from "@/constants/motion";
import { planSteerSweep, type SteerDirection } from "@/lib/recipe-steering";
import type { RecipeSuggestion } from "@/types/recipes";

// Past this many cards the rest leave together: they are below the screen,
// and a longer stagger would only delay the list closing up.
const MAX_STAGGERED_EXITS = 5;

type UseRecipeSweepOptions = {
  /** The feed's cards, top to bottom. */
  recipes: readonly RecipeSuggestion[];
  /** Fades every leaving card at once instead of staggering slides. */
  reducedMotion: boolean;
  /**
   * Whether a steered batch can load. When it can't, "More like this" keeps
   * the cards below, because nothing would arrive to replace them.
   */
  canLoadMore: boolean;
  /** Receives every press, before any card leaves. */
  onSteer: (direction: SteerDirection, recipe: RecipeSuggestion) => void;
  /** Receives each sweep's card ids once their exits finish. */
  onDismiss: (recipeIds: readonly string[]) => void;
};

/**
 * Runs the feed's "More like this" and "Less like this" sweeps: picks the
 * cards that leave with {@link planSteerSweep}, staggers their exits, then
 * removes them in one `onDismiss` so the cards that stay close up together.
 *
 * Returns `steer`, for the card buttons, and `exitDelayMs`, which gives a
 * leaving card's exit delay or `undefined` for a card at rest. A sweep still
 * running at unmount is committed right away, so its cards never come back.
 */
export function useRecipeSweep({
  recipes,
  reducedMotion,
  canLoadMore,
  onSteer,
  onDismiss,
}: UseRecipeSweepOptions) {
  const [leaving, setLeaving] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );
  const recipesRef = useRef(recipes);
  const leavingRef = useRef(leaving);
  const onDismissRef = useRef(onDismiss);
  const pendingRef = useRef(new Map<ReturnType<typeof setTimeout>, string[]>());
  useEffect(() => {
    recipesRef.current = recipes;
    leavingRef.current = leaving;
    onDismissRef.current = onDismiss;
  }, [leaving, onDismiss, recipes]);

  useEffect(() => {
    const pending = pendingRef.current;
    return () => {
      for (const [timer, ids] of pending) {
        clearTimeout(timer);
        onDismissRef.current(ids);
      }
      pending.clear();
    };
  }, []);

  const steer = useCallback(
    (direction: SteerDirection, recipe: RecipeSuggestion) => {
      onSteer(direction, recipe);
      if (direction === "more" && !canLoadMore) return;
      const ids = planSteerSweep(
        recipesRef.current,
        recipe.recipe_id,
        direction,
      ).filter((id) => !leavingRef.current.has(id));
      if (ids.length === 0) return;
      const delays = ids.map((id, order): [string, number] => [
        id,
        reducedMotion
          ? 0
          : Math.min(order, MAX_STAGGERED_EXITS) * motionStagger.sweep,
      ]);
      const next = new Map([...leavingRef.current, ...delays]);
      leavingRef.current = next;
      setLeaving(next);
      const longestDelay = Math.max(...delays.map(([, delay]) => delay));
      const timer = setTimeout(
        () => {
          pendingRef.current.delete(timer);
          onDismissRef.current(ids);
          setLeaving((previous) => {
            const rest = new Map(previous);
            for (const id of ids) rest.delete(id);
            return rest;
          });
        },
        sweepExitDurationMs(longestDelay, reducedMotion),
      );
      pendingRef.current.set(timer, ids);
    },
    [canLoadMore, onSteer, reducedMotion],
  );

  const exitDelayMs = useCallback(
    (recipeId: string) => leaving.get(recipeId),
    [leaving],
  );

  return { steer, exitDelayMs };
}
