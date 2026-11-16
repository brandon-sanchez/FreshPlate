import type { ToastShowParams } from "react-native-toast-message";
import { supabase } from "@/lib/supabase";

/**
 * Thrown when the database refuses a change because a batch is no longer in
 * the state the screen showed, which happens when another phone changed it
 * first.
 */
export class ChangedElsewhereError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "ChangedElsewhereError";
  }
}

/** The second toast line for a failure that a retry on a better connection could fix. */
export const RETRY_HINT = "Check your connection and try again.";

/**
 * Calls a lot RPC and resolves when it succeeds.
 *
 * @param staleCodes - Error messages the RPC raises when the batch changed
 *   since the screen read it.
 * @throws {@link ChangedElsewhereError} for one of `staleCodes`, and the
 *   Supabase error for any other failure.
 */
export async function callLotRpc(
  fn: string,
  args: Record<string, unknown>,
  staleCodes: readonly string[],
): Promise<void> {
  const { error } = await supabase.rpc(fn, args);
  if (!error) return;
  throw staleCodes.includes(error.message) ? new ChangedElsewhereError(error.message) : error;
}

/**
 * Checks the result of a direct write to `lots` that selected the written ids.
 * A write that matches no row is not an error to PostgREST, so only the
 * returned rows show whether the lot was still live.
 *
 * @throws {@link ChangedElsewhereError} when no row was written, because
 *   another phone used up, tossed or deleted the lot first, and the Supabase
 *   error for any other failure.
 */
export function requireLiveLot({
  data,
  error,
}: {
  data: unknown[] | null;
  error: Error | null;
}): void {
  if (error) throw error;
  if (!data || data.length === 0) throw new ChangedElsewhereError("LOT_NOT_LIVE");
}

/**
 * Returns the error toast for a failed change to a food's batches. It says
 * whether another phone changed them first or the connection failed.
 */
export function lotErrorToast(name: string, error: Error): ToastShowParams {
  return error instanceof ChangedElsewhereError
    ? { type: "error", text1: `${name} already changed`, text2: "It was updated on another phone." }
    : { type: "error", text1: `Couldn't update ${name}`, text2: RETRY_HINT };
}
