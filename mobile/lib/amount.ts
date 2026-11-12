/**
 * Formats an amount in its unit, with "about" when it was eyeballed:
 * "about 750 ml", "0.25 container".
 *
 * @param estimate - Whether the amount, or any amount summed into it, is an estimate.
 */
export function formatAmount(quantity: number, unit: string, estimate: boolean): string {
  const amount = `${formatQuantity(quantity)} ${unit}`;
  return estimate ? `about ${amount}` : amount;
}

// Two decimals, so a quarter of a container or of 5 heads reads exactly.
function formatQuantity(q: number): string {
  return String(Number(q.toFixed(2)));
}
