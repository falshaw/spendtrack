/**
 * Month coverage and the year-to-date mean/median that depend on it.
 *
 * `getMonthCoverage` used to measure only how far INTO the month an account's rows
 * reached, so an account with no rows in the month at all had nothing to measure
 * and the month read "complete" — a whole missing statement for a small account
 * could go unnoticed for months without a badge ever appearing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  transaction: { findMany: vi.fn(), count: vi.fn() },
  category: { findMany: vi.fn() },
  recurringRule: { findMany: vi.fn() },
  account: { findMany: vi.fn(), findFirst: vi.fn() },
  $queryRaw: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));

import { getMonthCoverage, getYearSummary } from "@/lib/finance";

const USER = "user-1";
const AUG = new Date(Date.UTC(2026, 7, 15));
const d = (m: number, day: number) => new Date(Date.UTC(2026, m, day));

/** One `getMonthCoverage` result row, as the raw query returns it. */
const acct = (o: {
  name: string;
  total: number;
  inMonth: number;
  prev1: number;
  prev2: number;
  last: Date | null;
  lastInMonth?: Date | null;
}) => ({
  name: o.name,
  total: BigInt(o.total),
  in_month: BigInt(o.inMonth),
  in_prev1: BigInt(o.prev1),
  in_prev2: BigInt(o.prev2),
  last_date: o.last,
  last_in_month: o.lastInMonth ?? (o.inMonth > 0 ? o.last : null),
});

const BANK_FULL = acct({ name: "Example Bank", total: 1000, inMonth: 106, prev1: 95, prev2: 80, last: d(7, 31) });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getMonthCoverage — a whole statement missing", () => {
  it("flags a major account that was live the two months before and has ZERO rows now", async () => {
    db.$queryRaw.mockResolvedValue([
      BANK_FULL,
      acct({ name: "Card A", total: 400, inMonth: 0, prev1: 59, prev2: 57, last: d(6, 20) }),
    ]);
    const cov = await getMonthCoverage(USER, AUG);
    expect(cov.complete).toBe(false);
    expect(cov.note).toContain("Card A not imported");
    expect(cov.note).toContain("Jul 20");
  });

  it("flags it for a SMALL account too — no 50-row gate (a low-volume account)", async () => {
    db.$queryRaw.mockResolvedValue([
      BANK_FULL,
      acct({ name: "Bank B", total: 30, inMonth: 0, prev1: 10, prev2: 2, last: d(5, 24) }),
    ]);
    const cov = await getMonthCoverage(USER, new Date(Date.UTC(2026, 6, 15))); // judging July
    expect(cov.complete).toBe(false);
    expect(cov.note).toContain("Bank B not imported");
  });

  it("does not flag a dormant account — nothing in the previous months either", async () => {
    db.$queryRaw.mockResolvedValue([
      BANK_FULL,
      acct({ name: "Card B", total: 80, inMonth: 0, prev1: 0, prev2: 0, last: d(1, 10) }),
      acct({ name: "Savings account", total: 29, inMonth: 0, prev1: 0, prev2: 0, last: d(3, 5) }),
    ]);
    expect(await getMonthCoverage(USER, AUG)).toEqual({ complete: true, note: null });
  });

  it("does not flag an account that stopped only ONE month ago", async () => {
    db.$queryRaw.mockResolvedValue([
      BANK_FULL,
      acct({ name: "Savings account", total: 29, inMonth: 0, prev1: 1, prev2: 0, last: d(6, 5) }),
    ]);
    expect((await getMonthCoverage(USER, AUG)).complete).toBe(true);
  });

  it("does not flag a quiet month in the MIDDLE of an account's history", async () => {
    // Later rows exist, so its statements were imported; the month was just empty.
    db.$queryRaw.mockResolvedValue([
      acct({ name: "Example Bank", total: 1000, inMonth: 95, prev1: 80, prev2: 103, last: d(7, 31), lastInMonth: d(6, 31) }),
      acct({ name: "Bank B", total: 200, inMonth: 0, prev1: 10, prev2: 2, last: d(7, 28) }),
    ]);
    expect((await getMonthCoverage(USER, new Date(Date.UTC(2026, 6, 15)))).complete).toBe(true);
  });

  it("an account with no rows at all is ignored", async () => {
    db.$queryRaw.mockResolvedValue([
      BANK_FULL,
      acct({ name: "Cash", total: 0, inMonth: 0, prev1: 0, prev2: 0, last: null }),
    ]);
    expect((await getMonthCoverage(USER, AUG)).complete).toBe(true);
  });
});

describe("getMonthCoverage — the existing mid-month cut-off rule still holds", () => {
  it("flags a major account whose rows stop well behind the month's frontier", async () => {
    db.$queryRaw.mockResolvedValue([
      acct({ name: "Bank C", total: 500, inMonth: 30, prev1: 38, prev2: 22, last: d(7, 30) }),
      acct({ name: "Example Bank", total: 1000, inMonth: 12, prev1: 95, prev2: 80, last: d(7, 7) }),
    ]);
    const cov = await getMonthCoverage(USER, AUG);
    expect(cov.complete).toBe(false);
    expect(cov.note).toBe("Example Bank ends Aug 7");
  });

  it("does not flag a statement-cycle card that closes on the 20th", async () => {
    db.$queryRaw.mockResolvedValue([
      acct({ name: "Bank C", total: 500, inMonth: 30, prev1: 38, prev2: 22, last: d(7, 30) }),
      acct({ name: "Card A", total: 400, inMonth: 39, prev1: 59, prev2: 57, last: d(7, 20) }),
    ]);
    expect((await getMonthCoverage(USER, AUG)).complete).toBe(true);
  });

  it("measures the frontier inside the judged month, not by a later-dated row", async () => {
    // Card A's newest row overall is in September; July must still judge on July.
    db.$queryRaw.mockResolvedValue([
      acct({ name: "Bank C", total: 500, inMonth: 38, prev1: 22, prev2: 15, last: d(8, 2), lastInMonth: d(6, 31) }),
      acct({ name: "Card A", total: 400, inMonth: 59, prev1: 57, prev2: 33, last: d(8, 2), lastInMonth: d(6, 20) }),
    ]);
    expect((await getMonthCoverage(USER, new Date(Date.UTC(2026, 6, 15)))).complete).toBe(true);
  });

  it("does not flag a quiet account whose balance is dated at month end", async () => {
    db.$queryRaw.mockResolvedValue([
      acct({ name: "Bank C", total: 500, inMonth: 30, prev1: 38, prev2: 22, last: d(7, 30) }),
      { ...acct({ name: "Bank D", total: 200, inMonth: 1, prev1: 40, prev2: 20, last: d(7, 7) }), balance_in_month: d(7, 31) },
    ]);
    expect((await getMonthCoverage(USER, AUG)).complete).toBe(true);
  });

  it("still flags an account whose balance stops mid-month with its rows", async () => {
    db.$queryRaw.mockResolvedValue([
      acct({ name: "Bank C", total: 500, inMonth: 30, prev1: 38, prev2: 22, last: d(7, 30) }),
      { ...acct({ name: "Example Bank", total: 1000, inMonth: 12, prev1: 95, prev2: 80, last: d(7, 7) }), balance_in_month: d(7, 7) },
    ]);
    expect((await getMonthCoverage(USER, AUG)).note).toBe("Example Bank ends Aug 7");
  });
});

describe("getYearSummary — mean and median", () => {
  const CATS = [
    { id: "c-tax", name: "Tax", color: "#5b4a9e", group: "NEEDS", excludeFromTotals: false },
  ];
  const spend = (month: number, amount: number) => ({
    amount,
    currency: "EUR",
    type: "EXPENSE",
    date: d(month, 10),
    accrualDate: null,
    categoryId: "c-tax",
  });

  beforeEach(() => {
    db.account.findMany.mockResolvedValue([]);
    db.category.findMany.mockImplementation((args: { where?: Record<string, unknown> }) =>
      Promise.resolve(args?.where?.excludeFromTotals === true ? [] : CATS),
    );
  });

  it("divides the mean by the months ELAPSED, not the months that had spend", async () => {
    // A business scope with spend in 3 of the 8 months to August.
    db.transaction.findMany.mockResolvedValue([spend(0, 300), spend(3, 600), spend(7, 900)]);
    db.$queryRaw.mockResolvedValue([BANK_FULL]); // August is complete
    const y = await getYearSummary(USER, AUG);
    expect(y.total).toBe(1800);
    expect(y.months).toBe(3);
    expect(y.avgPerMonth).toBeCloseTo(1800 / 8, 6); // was 1800 / 3
    expect(y.typicalPerMonth).toBe(600);
  });

  it("leaves an INCOMPLETE viewed month out of mean and median, but not out of the total", async () => {
    db.transaction.findMany.mockResolvedValue([spend(5, 1000), spend(6, 3000), spend(7, 100)]);
    db.$queryRaw.mockResolvedValue([
      BANK_FULL,
      acct({ name: "Card A", total: 400, inMonth: 0, prev1: 59, prev2: 57, last: d(6, 20) }),
    ]);
    const y = await getYearSummary(USER, AUG);
    expect(y.total).toBe(4100); // the €100 was spent — it stays in the total
    expect(y.avgPerMonth).toBeCloseTo(4000 / 7, 6); // Jan–Jul only
    expect(y.typicalPerMonth).toBe(2000); // median of June + July, August ignored
  });

  it("falls back to the month itself when it is the only one there is", async () => {
    db.transaction.findMany.mockResolvedValue([spend(0, 500)]);
    db.$queryRaw.mockResolvedValue([
      BANK_FULL,
      acct({ name: "Card A", total: 400, inMonth: 0, prev1: 59, prev2: 57, last: new Date(Date.UTC(2025, 11, 20)) }),
    ]);
    const y = await getYearSummary(USER, new Date(Date.UTC(2026, 0, 15)));
    expect(y.avgPerMonth).toBe(500);
    expect(y.typicalPerMonth).toBe(500);
  });
});
