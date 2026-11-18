import { formatAmount } from "@/lib/amount";

const clove = { label: "clove", perUnit: 0.1 };

describe("formatAmount", () => {
  it("names one of a counted food in the singular and any other count in the plural", () => {
    expect(formatAmount(1, "lemon", false)).toBe("1 lemon");
    expect(formatAmount(7, "egg", false)).toBe("7 eggs");
    expect(formatAmount(2, "can", false)).toBe("2 cans");
    expect(formatAmount(0, "egg", false)).toBe("0 eggs");
    expect(formatAmount(2.5, "egg", false)).toBe("2.5 eggs");
  });

  it("reads a plural or capitalized count word the same way", () => {
    expect(formatAmount(1, "Lemons", false)).toBe("1 lemon");
    expect(formatAmount(3, "boxes", false)).toBe("3 boxes");
  });

  it("leaves a generic each unchanged", () => {
    expect(formatAmount(3, "each", false)).toBe("3 each");
  });

  it("rounds weights and volumes to what a cook can read", () => {
    expect(formatAmount(570.4, "ml", false)).toBe("570 ml");
    expect(formatAmount(29.6, "ml", false)).toBe("30 ml");
    expect(formatAmount(2.46, "g", false)).toBe("2.5 g");
    expect(formatAmount(0, "g", false)).toBe("0 g");
  });

  it("shows a thousand or more in kilograms or litres", () => {
    expect(formatAmount(3090, "ml", false)).toBe("3.09 l");
    expect(formatAmount(1500, "g", false)).toBe("1.5 kg");
    expect(formatAmount(1995, "g", false)).toBe("1.995 kg");
    expect(formatAmount(999.6, "g", false)).toBe("1 kg");
  });

  it("shows a counted food's fraction in its smaller unit", () => {
    expect(formatAmount(0.2, "head", false, clove)).toBe("2 cloves");
    expect(formatAmount(0.1, "head", false, clove)).toBe("1 clove");
    expect(formatAmount(1.8, "head", false, clove)).toBe("1 head 8 cloves");
    expect(formatAmount(2, "head", false, clove)).toBe("2 heads");
    expect(formatAmount(1.97, "head", false, clove)).toBe("2 heads");
    expect(formatAmount(0.04, "head", false, clove)).toBe("0.04 heads");
  });

  it("ignores a smaller unit for a weighed food", () => {
    expect(formatAmount(250, "g", false, clove)).toBe("250 g");
  });

  it("says about before an estimate", () => {
    expect(formatAmount(750, "ml", true)).toBe("about 750 ml");
    expect(formatAmount(0.25, "container", true)).toBe("about 0.25 containers");
  });
});
