import { apiFetch } from "@/lib/api";
import type {
  CookConfirmationRequest,
  CookPlan,
  CookPlanRequest,
} from "@/types/cook";

/**
 * Returns the done-cooking checklist for a recipe, calling
 * `POST /api/cook/plan` with the session JWT. The backend reads the
 * household's current stock and converts each ingredient, and changes
 * nothing, so calling it again reloads stock.
 *
 * @throws {@link ApiError} with status 503 when the household's foods can't
 * be read.
 */
export async function fetchCookPlan(body: CookPlanRequest): Promise<CookPlan> {
  const response = await apiFetch<{ data: CookPlan }>("/api/cook/plan", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return response.data;
}

/**
 * Deducts a confirmed cook from the household's stock and records it,
 * calling `POST /api/cook/confirm` with the session JWT. Repeating a call
 * with the same operation id and body deducts once.
 *
 * @throws {@link ApiError} with status 409 and code `STOCK_CHANGED` when a
 * food has less stock than the checklist expected. Nothing was deducted then.
 * Status 409 `COOK_REJECTED` means the database refused the cook for another
 * reason, and 503 `COOK_UNAVAILABLE` means the backend can't reach it.
 */
export async function confirmCook(body: CookConfirmationRequest): Promise<void> {
  await apiFetch("/api/cook/confirm", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
