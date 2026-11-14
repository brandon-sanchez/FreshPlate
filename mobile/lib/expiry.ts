/**
 * Returns whole days from today to a `YYYY-MM-DD` date in local time, negative
 * once it has passed, or `null` when there is no date or it is malformed.
 */
export function daysUntilExpiration(expirationDate: string | null): number | null {
  if (!expirationDate) return null;
  const parts = expirationDate.split("-");
  if (parts.length !== 3) return null;
  const [y, m, d] = parts.map((p) => Number(p));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  const exp = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffMs = exp.getTime() - today.getTime();
  return Math.round(diffMs / 86400000);
}

/**
 * Returns the local calendar date `days` from today as `YYYY-MM-DD`. Local
 * rather than UTC, so an evening edit in a negative-UTC zone does not land on
 * the next day.
 */
export function dateInDays(days: number): string {
  const now = new Date();
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
}

/**
 * Returns how a batch's expiry reads on a card: "Expired 3 days ago",
 * "Expires today", "Expires tomorrow", "Expires in 5 days", or "No expiry
 * date" when `days` is `null`.
 *
 * @param days - Days until the expiration date, as {@link daysUntilExpiration} returns.
 */
export function expiryLabel(days: number | null): string {
  if (days === null) return "No expiry date";
  if (days < 0) return `Expired ${Math.abs(days)} day${days === -1 ? "" : "s"} ago`;
  if (days === 0) return "Expires today";
  if (days === 1) return "Expires tomorrow";
  return `Expires in ${days} days`;
}

/** Formats a `YYYY-MM-DD` date as a short local day, such as "Nov 20". */
export function formatShortDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
