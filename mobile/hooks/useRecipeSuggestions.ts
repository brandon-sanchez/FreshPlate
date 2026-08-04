import { useMutation } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type {
  RecipeSuggestionRequest,
  RecipeSuggestionsResponse,
} from "@/types/recipes";

export function useRecipeSuggestions() {
  return useMutation({
    mutationFn: (request: RecipeSuggestionRequest) =>
      apiFetch<RecipeSuggestionsResponse>("/api/recipes/suggestions", {
        method: "POST",
        body: JSON.stringify(request),
      }),
  });
}
