import { useMutation } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type {
  RecipeSuggestionRequest,
  RecipeSuggestionsResponse,
} from "@/types/recipes";

export type RecipeSuggestionMutationInput = {
  request: RecipeSuggestionRequest;
  signal?: AbortSignal;
};

type RecipeSuggestionMutationValue =
  | RecipeSuggestionRequest
  | RecipeSuggestionMutationInput;

function isMutationInput(
  value: RecipeSuggestionMutationValue,
): value is RecipeSuggestionMutationInput {
  return "request" in value;
}

export function useRecipeSuggestions() {
  return useMutation({
    mutationFn: (value: RecipeSuggestionMutationValue) => {
      const request = isMutationInput(value) ? value.request : value;
      const signal = isMutationInput(value) ? value.signal : undefined;

      return apiFetch<RecipeSuggestionsResponse>("/api/recipes/suggestions", {
        method: "POST",
        body: JSON.stringify(request),
        signal,
      });
    },
  });
}
