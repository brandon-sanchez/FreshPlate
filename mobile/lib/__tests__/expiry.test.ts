import { daysUntilExpiration } from "@/lib/expiry";

describe("daysUntilExpiration", () => {
  function localDateString(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  it("returns null when expiration_date is null", () => {
    expect(daysUntilExpiration(null)).toBeNull();
  });

  it("returns 0 when expiration is today", () => {
    expect(daysUntilExpiration(localDateString(new Date()))).toBe(0);
  });

  it("returns a negative number when expiration is in the past", () => {
    const past = new Date();
    past.setDate(past.getDate() - 3);
    expect(daysUntilExpiration(localDateString(past))).toBe(-3);
  });

  it("returns a positive number when expiration is in the future", () => {
    const future = new Date();
    future.setDate(future.getDate() + 7);
    expect(daysUntilExpiration(localDateString(future))).toBe(7);
  });
});
