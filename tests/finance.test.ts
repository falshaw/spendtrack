import { describe, expect, it } from "vitest";
import { makeIsRefund, occurrenceMonths } from "@/lib/finance";

// The refund rule is the money-critical branch every aggregate shares:
// INCOME in a spend category nets against spend; INCOME in an INCOME-group
// category (or uncategorised) is real income.
describe("makeIsRefund", () => {
  const groups = new Map<string, string>([
    ["cat-salary", "INCOME"],
    ["cat-groceries", "NEEDS"],
    ["cat-dining", "WANTS"],
  ]);
  const isRefund = makeIsRefund(groups);

  it("treats INCOME in a spend category as a refund", () => {
    expect(isRefund("INCOME", "cat-groceries")).toBe(true);
    expect(isRefund("INCOME", "cat-dining")).toBe(true);
  });

  it("treats INCOME in an INCOME-group category as real income", () => {
    expect(isRefund("INCOME", "cat-salary")).toBe(false);
  });

  it("treats uncategorised INCOME as real income", () => {
    expect(isRefund("INCOME", null)).toBe(false);
  });

  it("never flags EXPENSE rows", () => {
    expect(isRefund("EXPENSE", "cat-groceries")).toBe(false);
    expect(isRefund("EXPENSE", null)).toBe(false);
  });

  it("treats an unknown category id as real income (no group info)", () => {
    expect(isRefund("INCOME", "cat-does-not-exist")).toBe(false);
  });
});

// The projection walk decides whether the year-end forecast invents income
// that will never arrive. A salary that ends mid-year and a contract that starts
// later must both be honoured exactly.
describe("occurrenceMonths", () => {
  const d = (s: string) => new Date(s + "T00:00:00Z");

  it("projects every remaining month for an open-ended monthly rule", () => {
    // firstOpenMonth = 7 (Aug): Jan–Jul are closed, their actuals are imported.
    expect(occurrenceMonths(d("2026-08-31"), null, "MONTHLY", 2026, 7)).toEqual([
      7, 8, 9, 10, 11,
    ]);
  });

  it("stops at the end date — ended income is not forecast forward", () => {
    // A salary whose final payment is 31 Jul.
    expect(occurrenceMonths(d("2026-07-31"), d("2026-07-31"), "MONTHLY", 2026, 6)).toEqual([6]);
  });

  it("returns nothing when the rule ended before the open window", () => {
    expect(occurrenceMonths(d("2026-03-31"), d("2026-03-31"), "MONTHLY", 2026, 7)).toEqual([]);
  });

  it("does not skip a month when the pay day is the 31st", () => {
    // Naive date mutation turns 31 Aug + 1 month into 1 Oct, losing September.
    expect(occurrenceMonths(d("2026-08-31"), null, "MONTHLY", 2026, 7)).toContain(8);
  });

  it("clamps the pay day to short months", () => {
    // A 31st rule must still fire in 30-day months (Sep, Nov).
    const months = occurrenceMonths(d("2026-01-31"), null, "MONTHLY", 2026, 0);
    expect(months).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("honours quarterly and yearly cadence", () => {
    expect(occurrenceMonths(d("2026-09-16"), null, "QUARTERLY", 2026, 0)).toEqual([8, 11]);
    expect(occurrenceMonths(d("2026-03-27"), null, "YEARLY", 2026, 0)).toEqual([2]);
  });

  it("starts a future rule only from its own start month", () => {
    // A new contract: first payment lands end Sep, so Aug must stay empty.
    expect(occurrenceMonths(d("2026-09-30"), d("2026-12-31"), "MONTHLY", 2026, 7)).toEqual([
      8, 9, 10, 11,
    ]);
  });

  it("never projects into a month that is already closed", () => {
    // A stale rule (salary imported but "log now" never pressed) must not add a
    // projected bar on top of the imported actual.
    expect(occurrenceMonths(d("2026-01-31"), null, "MONTHLY", 2026, 7)).toEqual([
      7, 8, 9, 10, 11,
    ]);
  });
});

describe("occurrenceMonths with today", () => {
  const dd = (s: string) => new Date(s + "T00:00:00Z");

  it("skips an occurrence already behind today in the open month, keeps the rest", () => {
    // Salary due on the 1st and already imported; today is the 3rd: September
    // must not be projected on top of the actual.
    expect(occurrenceMonths(dd("2026-09-01"), null, "MONTHLY", 2026, 8, dd("2026-09-03"))).toEqual([
      9, 10, 11,
    ]);
    // Due on the 25th, today the 3rd: September is still a forecast.
    expect(occurrenceMonths(dd("2026-09-25"), null, "MONTHLY", 2026, 8, dd("2026-09-03"))).toEqual([
      8, 9, 10, 11,
    ]);
  });
});
