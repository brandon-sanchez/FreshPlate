import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth";

export type Profile = {
  id: string;
  display_name: string | null;
  avatar_url: string | null;
};

export function useProfile() {
  const userId = useAuthStore((s) => s.user?.id ?? null);

  return useQuery({
    queryKey: ["profile", userId],
    enabled: !!userId,
    queryFn: async (): Promise<Profile | null> => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, display_name, avatar_url")
        .eq("id", userId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

export function useUpdateProfile() {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (patch: { display_name?: string | null; avatar_url?: string | null }) => {
      if (!userId) throw new Error("not signed in");
      const { error } = await supabase
        .from("profiles")
        .update(patch)
        .eq("id", userId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["profile", userId] });
    },
  });
}

/**
 * Pulls the user's first name from the profiles row (preferred) or OAuth metadata
 * (fallback). Returns null when neither has a usable value, so the caller can show
 * a "set your name" prompt.
 */
export function firstNameFromProfile(displayName: string | null | undefined): string | null {
  const trimmed = displayName?.trim();
  if (!trimmed) return null;
  const first = trimmed.split(/\s+/)[0];
  return first ?? null;
}
