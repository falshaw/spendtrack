/**
 * Accrual bucketing, end to end.
 *
 * The worked case: EUR 450.00 of flights + car hire for a September business trip,
 * charged on 20.08 with `accrualDate` = 10.09. It is September's cost.
 * Every aggregate filters by `periodWhere` (accrual first) — and must also BUCKET by
 * it, or the row sits in August's bar and falls off the chart when August leaves the
 * window. One fixture, every aggregate.
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

import {
  getDashboard,
  getIncomeOverview,
  getMonthlyTrend,
  getYearSummary,
  nextUnsettledOccurrence,
  periodDate,
  periodWhere,
  recurringHasStarted,
} from "@/lib/finance";

const USER = "user-1";
const AUG = new Date(Date.UTC(2026, 7, 15));
const SEP = new Date(Date.UTC(2026, 8, 15));

const CATS = [
  { id: "c-travel", name: "Business travel", color: "#5e7d2e", group: "NEEDS", monthlyBudget: null, excludeFromTotals: false, isArchived: false, sortOrder: 0 },
  { id: "c-salary", name: "Salary", color: "#5e6b4f", group: "INCOME", monthlyBudget: null, excludeFromTotals: false, isArchived: false, sortOrder: 1 },
];

const row = (o: Record<string, unknown>) => ({
  id: "t-" + Math.random().toString(36).slice(2, 8),
  currency: "EUR",
  type: "EXPENSE",
  categoryId: "c-travel",
  accountId: "a-card",
  merchant: "Example Flights",
  note: null,
  reviewed: true,
  createdAt: new Date(Date.UTC(2026, 7, 26)),
  category: null,
  account: { name: "Card A", color: "#111111" },
  ...o,
});

// Charged 20 Aug, counts on 10 Sep.
const ACCRUED = row({ amount: 450, date: new Date(Date.UTC(2026, 7, 20)), accrualDate: new Date(Date.UTC(2026, 8, 10)) });
// Invoice paid 27 Aug for work accrued to September — the income mirror of the same rule.
const ACCRUED_INCOME = row({
  amount: 9000, type: "INCOME", categoryId: "c-salary", merchant: "Example Ltd",
  date: new Date(Date.UTC(2026, 7, 27)), accrualDate: new Date(Date.UTC(2026, 8, 1)),
});

beforeEach(() => {
  vi.clearAllMocks();
  db.transaction.findMany.mockResolvedValue([ACCRUED, ACCRUED_INCOME]);
  db.transaction.count.mockResolvedValue(0);
  db.category.findMany.mockImplementation((args: { where?: Record<string, unknown> }) =>
    Promise.resolve(args?.where?.excludeFromTotals === true ? [] : CATS),
  );
  db.account.findMany.mockResolvedValue([]);
  db.recurringRule.findMany.mockResolvedValue([]);
  db.$queryRaw.mockResolvedValue([]);
});

describe("a row charged 20.08 and accrued 10.09", () => {
  it("counts on its accrual date", () => {
    expect(periodDate(ACCRUED as never).toISOString().slice(0, 10)).toBe("2026-09-10");
    expect(periodDate({ date: new Date(Date.UTC(2026, 7, 20)), accrualDate: null }).toISOString().slice(0, 10)).toBe("2026-08-20");
  });

  it("is asked for by accrual, in every aggregate's query", async () => {
    await getMonthlyTrend(USER, 3, "all", SEP);
    const where = db.transaction.findMany.mock.calls[0][0].where;
    expect(where.AND).toEqual(periodWhere(new Date(Date.UTC(2026, 6, 1)), new Date(Date.UTC(2026, 9, 1))).AND);
  });

  it("lands in September's trend bar, not August's", async () => {
    const trend = await getMonthlyTrend(USER, 3, "all", SEP);
    const by = Object.fromEntries(trend.map((t) => [t.monthRef, t]));
    expect(by["2026-09"].expense).toBe(450);
    expect(by["2026-09"].income).toBe(9000);
    expect(by["2026-08"]).toMatchObject({ expense: 0, income: 0 });
  });

  it("does not leak into a chart window that ends in August", async () => {
    const trend = await getMonthlyTrend(USER, 3, "all", AUG);
    expect(trend.map((t) => t.monthRef)).toEqual(["2026-06", "2026-07", "2026-08"]);
    expect(trend.every((t) => t.expense === 0 && t.income === 0)).toBe(true);
  });

  it("starts September's pace line on the 10th, not the 20th", async () => {
    const dash = await getDashboard(USER, SEP);
    expect(dash.spent).toBeCloseTo(450, 2);
    expect(dash.pace.find((p) => p.day === 9)!.actual).toBe(0);
    expect(dash.pace.find((p) => p.day === 10)!.actual).toBe(450);
  });

  it("is a September month in the year summary", async () => {
    const y = await getYearSummary(USER, SEP);
    expect(y.total).toBeCloseTo(450, 2);
    expect(y.months).toBe(1);
    // Nine months elapsed to September, one of them with spend.
    expect(y.avgPerMonth).toBeCloseTo(450 / 9, 6);
  });

  it("is September income in the income overview", async () => {
    const ov = await getIncomeOverview(USER, SEP);
    expect(ov.byMonth[8].actual).toBe(9000);
    expect(ov.byMonth[7].actual).toBe(0);
    expect(ov.totalYtd).toBe(9000);
  });
});

describe("nextUnsettledOccurrence — the Upcoming widget", () => {
  const TODAY = Date.UTC(2026, 8, 18);
  const rent = {
    nextDate: new Date(Date.UTC(2026, 7, 15)), cadence: "MONTHLY", amount: 1200,
    currency: "EUR", type: "EXPENSE", accountId: "a-bank",
  };
  const paid = (m: number, day: number, o: Record<string, unknown> = {}) => ({
    amount: 1200, currency: "EUR", type: "EXPENSE", date: new Date(Date.UTC(2026, m, day)), accountId: "a-bank", ...o,
  });

  it("skips every occurrence a bank row has settled and shows the next one", () => {
    const next = nextUnsettledOccurrence(rent, [paid(7, 15), paid(8, 14)], TODAY);
    expect(next.toISOString().slice(0, 10)).toBe("2026-10-15");
  });

  it("leaves a genuinely unpaid bill overdue", () => {
    const next = nextUnsettledOccurrence(rent, [paid(7, 15)], TODAY);
    expect(next.toISOString().slice(0, 10)).toBe("2026-09-15");
  });

  it("does not let one payment settle two occurrences", () => {
    // A single row 7 days after August and well short of September.
    const next = nextUnsettledOccurrence(rent, [paid(7, 22)], TODAY);
    expect(next.toISOString().slice(0, 10)).toBe("2026-09-15");
  });

  it("ignores another account, the wrong type, and an amount more than 10% off", () => {
    const rows = [
      paid(7, 15, { accountId: "a-other" }),
      paid(7, 15, { type: "INCOME" }),
      paid(7, 15, { amount: 1400 }),
    ];
    expect(nextUnsettledOccurrence(rent, rows, TODAY).toISOString().slice(0, 10)).toBe("2026-08-15");
  });

  it("lets an unlinked rule match a row on any account", () => {
    const next = nextUnsettledOccurrence({ ...rent, accountId: null }, [paid(7, 15, { accountId: "a-other" })], TODAY);
    expect(next.toISOString().slice(0, 10)).toBe("2026-09-15");
  });

  it("clamps the 31st to month length instead of skipping February", () => {
    const rule = { ...rent, nextDate: new Date(Date.UTC(2026, 0, 31)) };
    const rows = [paid(0, 31), paid(1, 28)];
    expect(nextUnsettledOccurrence(rule, rows, TODAY).toISOString().slice(0, 10)).toBe("2026-03-31");
  });

  it("never touches an occurrence that is still ahead", () => {
    const rule = { ...rent, nextDate: new Date(Date.UTC(2026, 9, 15)) };
    expect(nextUnsettledOccurrence(rule, [paid(9, 15)], TODAY).toISOString().slice(0, 10)).toBe("2026-10-15");
  });
});

describe("recurringHasStarted", () => {
  const today = new Date(Date.UTC(2026, 8, 18));
  it("counts a rule whose date has passed, and one due within its own cadence", () => {
    expect(recurringHasStarted(new Date(Date.UTC(2026, 8, 15)), "MONTHLY", today)).toBe(true);
    expect(recurringHasStarted(new Date(Date.UTC(2026, 9, 7)), "MONTHLY", today)).toBe(true);
    expect(recurringHasStarted(new Date(Date.UTC(2027, 2, 27)), "YEARLY", today)).toBe(true);
  });
  it("leaves out a replacement bill that has not begun", () => {
    expect(recurringHasStarted(new Date(Date.UTC(2027, 2, 1)), "MONTHLY", today)).toBe(false);
    expect(recurringHasStarted(new Date(Date.UTC(2027, 0, 5)), "QUARTERLY", today)).toBe(false);
  });
});
