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
