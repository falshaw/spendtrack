/**
 * F3 splits — pure maths. The parent row stays the reconciled row; the parts must
 * sum to its amount to the cent; `expandSplits` is what the category breakdowns
 * read so a split spreads across categories without changing any grand total.
 */
import { describe, expect, it } from "vitest";
import { expandSplits, largestPart, partsFromReceiptLines, validateSplits } from "@/lib/splits";

describe("validateSplits", () => {
  it("accepts parts that sum to the amount to the cent (float noise tolerated)", () => {
    expect(validateSplits(100, [{ amount: 33.33, categoryId: "a" }, { amount: 33.33, categoryId: "b" }, { amount: 33.34, categoryId: "c" }])).toBeNull();
    expect(validateSplits(0.3, [{ amount: 0.1, categoryId: "a" }, { amount: 0.2, categoryId: "b" }])).toBeNull();
  });
  it("rejects a sum off by a cent, a non-positive part, a single part, and more than 20 parts", () => {
    expect(validateSplits(100, [{ amount: 50, categoryId: "a" }, { amount: 49.99, categoryId: "b" }])).toMatch(/sum/i);
    expect(validateSplits(100, [{ amount: 100, categoryId: "a" }, { amount: 0, categoryId: "b" }])).toMatch(/greater than 0/i);
    expect(validateSplits(100, [{ amount: 100, categoryId: "a" }])).toMatch(/at least two/i);
    expect(validateSplits(21, Array.from({ length: 21 }, () => ({ amount: 1, categoryId: "a" })))).toMatch(/20/);
  });
  it("an empty list is valid: it means unsplit", () => {
    expect(validateSplits(100, [])).toBeNull();
  });
});

describe("largestPart", () => {
  it("returns the category of the biggest part; ties go to the first; null when no part has one", () => {
    expect(largestPart([{ amount: 10, categoryId: "a" }, { amount: 40, categoryId: "b" }, { amount: 40, categoryId: "c" }])).toBe("b");
    expect(largestPart([{ amount: 10, categoryId: null }, { amount: 5, categoryId: "z" }])).toBe("z");
    expect(largestPart([])).toBeNull();
  });
});

describe("expandSplits", () => {
  const rows = [
    { id: "t1", amount: "100.00", currency: "EUR", type: "EXPENSE", categoryId: "b", date: "d", splits: [{ amount: "60.00", categoryId: "a" }, { amount: "40.00", categoryId: "b" }] },
    { id: "t2", amount: "20.00", currency: "EUR", type: "EXPENSE", categoryId: "c", date: "d", splits: [] },
    { id: "t3", amount: "5.00", currency: "EUR", type: "INCOME", categoryId: null, date: "d" },
  ];
  it("replaces a split row by its parts, carrying every other field; unsplit rows pass through", () => {
    const out = expandSplits(rows);
    expect(out).toHaveLength(4);
    expect(out[0]).toMatchObject({ id: "t1", amount: "60.00", categoryId: "a", currency: "EUR", type: "EXPENSE", date: "d" });
    expect(out[1]).toMatchObject({ id: "t1", amount: "40.00", categoryId: "b" });
    expect(out[2]).toMatchObject({ id: "t2", amount: "20.00", categoryId: "c" });
    expect(out[3]).toMatchObject({ id: "t3", amount: "5.00", categoryId: null });
    expect("splits" in out[0]).toBe(false);
  });
  it("the grand total is unchanged by expansion", () => {
    const sum = (xs: { amount: string }[]) => xs.reduce((s, x) => s + Number(x.amount), 0);
    expect(sum(expandSplits(rows))).toBeCloseTo(sum(rows), 2);
  });
});

describe("partsFromReceiptLines", () => {
  const lines = [
    { label: "Milk 1L", amount: 1.2, currency: "EUR" },
    { label: "Bread", amount: 2.3, currency: "EUR" },
    { label: "Subtotal", amount: 3.5, currency: "EUR" },
    { label: "VAT 19%", amount: 0.67, currency: "EUR" },
    { label: "Tip", amount: 0.5, currency: "EUR" },
    { label: "TOTAL", amount: 4.17, currency: "EUR" },
    { label: "Gesamtpreis", amount: 4.17, currency: "EUR" },
    { label: "Change", amount: 0.83, currency: "EUR" },
    { label: "Discount", amount: -0.5, currency: "EUR" },
  ];
  it("keeps the item lines, drops totals / VAT / tip / change / discount and non-positive amounts", () => {
    const parts = partsFromReceiptLines(lines, 4.17);
    expect(parts.map((p) => p.note)).toEqual(["Milk 1L", "Bread"]);
    expect(parts.map((p) => p.amount)).toEqual([1.2, 2.3]);
    expect(parts.every((p) => p.categoryId === null)).toBe(true);
  });
  it("reports the gap between the kept lines and the row amount", () => {
    expect(partsFromReceiptLines(lines, 4.17).reduce((s, p) => s + p.amount, 0)).toBeCloseTo(3.5, 2);
  });
  it("returns nothing when there is no item line at all", () => {
    expect(partsFromReceiptLines([{ label: "TOTAL", amount: 4.17, currency: "EUR" }], 4.17)).toEqual([]);
  });
});
