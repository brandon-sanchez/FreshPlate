import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PostgrestError } from "@supabase/supabase-js";
import Toast, { type ToastShowParams } from "@/lib/toast";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth";

/** One ingredient the household always has, such as salt. */
export type KitchenBasic = {
  id: string;
  name: string;
};

/** The most basics a household may keep, enforced by the `prepare_kitchen_basic` trigger. */
export const MAX_KITCHEN_BASICS = 30;

/** The longest name the `kitchen_basics.name` CHECK constraint accepts. */
export const MAX_KITCHEN_BASIC_NAME_LENGTH = 40;

const RETRY_HINT = "Check your connection and try again.";

const POSTGRES_UNIQUE_VIOLATION = "23505";

function addErrorToast(error: PostgrestError, name: string): ToastShowParams {
  if (error.code === POSTGRES_UNIQUE_VIOLATION) {
    return { type: "info", text1: `${name} is already a basic` };
  }
  if (error.message === "KITCHEN_BASICS_FULL") {
    return { type: "info", text1: "Your basics list is full", text2: `Remove one to add ${name}.` };
  }
  return { type: "error", text1: `Couldn't add ${name}`, text2: RETRY_HINT };
}

function basicsKey(householdId: string | null) {
  return ["kitchen_basics", householdId] as const;
}

/**
 * Returns the signed-in household's kitchen basics, oldest first.
 *
 * Reads the `kitchen_basics` table under the key `['kitchen_basics', householdId]`
 * and stays idle until the auth store has a `householdId`. Recipes may use these
 * ingredients without stock, and cooking never deducts them.
 */
export function useKitchenBasics() {
  const householdId = useAuthStore((s) => s.householdId);
  return useQuery({
    queryKey: basicsKey(householdId),
    enabled: householdId !== null,
    queryFn: async (): Promise<KitchenBasic[]> => {
      const { data, error } = await supabase
        .from("kitchen_basics")
        .select("id, name")
        .eq("household_id", householdId!)
        .order("created_at")
        .order("name");
      if (error) throw error;
      return data;
    },
  });
}

/**
 * Returns a mutation that adds a basic by name to the signed-in household.
 *
 * Inserts into `kitchen_basics` with surrounding whitespace trimmed, and
 * invalidates `['kitchen_basics', householdId]` when it settles. A name the list
 * already has, in any case, shows an "already a basic" toast, and a full list
 * shows a "list is full" toast. Other failures show a connection toast.
 */
export function useAddKitchenBasic() {
  const householdId = useAuthStore((s) => s.householdId);
  const queryClient = useQueryClient();
  return useMutation<void, PostgrestError, string>({
    mutationFn: async (name) => {
      const { error } = await supabase
        .from("kitchen_basics")
        .insert({ household_id: householdId, name: name.trim() });
      if (error) throw error;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: basicsKey(householdId) }),
    onError: (error, name) => Toast.show(addErrorToast(error, name.trim())),
  });
}

/**
 * Returns a mutation that removes one of the household's basics by id.
 *
 * Deletes from `kitchen_basics`, invalidates `['kitchen_basics', householdId]`
 * when it settles, and shows a connection toast when the delete fails. Recipes
 * generated afterwards treat the ingredient like any other untracked food.
 */
export function useRemoveKitchenBasic() {
  const householdId = useAuthStore((s) => s.householdId);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: KitchenBasic) => {
      const { error } = await supabase.from("kitchen_basics").delete().eq("id", id);
      if (error) throw error;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: basicsKey(householdId) }),
    onError: (_error, { name }) =>
      Toast.show({ type: "error", text1: `Couldn't remove ${name}`, text2: RETRY_HINT }),
  });
}
