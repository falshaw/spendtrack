/**
 * The aggregation engine, driven over a mocked Prisma.
 *
 * The fixture is small but deliberately contains the three shapes that can
 * each silently distort the totals:
 *
 *   - a REFUND (INCOME sitting in a spend category), which must subtract from
 *     that category rather than count as income,
 *   - a TRANSFER (a category flagged excludeFromTotals), which must not appear
 *     in spend, income or budgets at all — untagged, one month of broker
 *     deposits would read as ~EUR 30k of spending,
 *   - a BUSINESS account row, which must drop out under the Personal scope while
 *     account-less manual rows stay in.
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
  businessAccountIds,
  defaultDashboardMonth,
  getBudgetStatus,
  getDashboard,
  getIncomeOverview,
  getMonthCoverage,
  getMonthlyTrend,
  getTopMerchants,
  getYearSummary,
  latestTxnMonth,
  periodWhere,
  scopeAccountFilter,
} from "@/lib/finance";

const USER = "user-1";
const REF = new Date(Date.UTC(2026, 6, 15)); // July 2026

const CATEGORIES = [
  { id: "c-groceries", name: "Groceries", color: "#5E6B4F", group: "NEEDS", monthlyBudget: 400, excludeFromTotals: false, isArchived: false, sortOrder: 0 },
  { id: "c-dining", name: "Dining", color: "#BF5A36", group: "WANTS", monthlyBudget: 200, excludeFromTotals: false, isArchived: false, sortOrder: 1 },
  { id: "c-salary", name: "Salary", color: "#2F6E8F", group: "INCOME", monthlyBudget: null, excludeFromTotals: false, isArchived: false, sortOrder: 2 },
  { id: "c-transfers", name: "Transfers", color: "#B8AD99", group: "SAVINGS", monthlyBudget: null, excludeFromTotals: true, isArchived: false, sortOrder: 3 },
];

const ACCOUNTS = [
  { id: "a-personal", name: "Main account", biz: "PERSONAL", currency: "EUR", type: "BANK", color: "#111111" },
  { id: "a-biz", name: "Business current", biz: "BUSINESS", currency: "EUR", type: "BANK", color: "#222222" },
  { id: "a-biz2", name: "Business savings", biz: "BUSINESS", currency: "EUR", type: "BANK", color: "#333333" },
];

const txn = (o: Partial<Record<string, unknown>>) => ({
  id: "t" + Math.random().toString(36).slice(2, 8),
  amount: 0,
  currency: "EUR",
  type: "EXPENSE",
  date: new Date(Date.UTC(2026, 6, 10)),
  accrualDate: null,
  categoryId: null,
  accountId: "a-personal",
  merchant: "Freshmart",
  note: null,
  reviewed: true,
  createdAt: new Date(Date.UTC(2026, 6, 10)),
  category: null,
  account: { name: "Main account" },
  ...o,
});

const TXNS = [
  txn({ amount: 300, categoryId: "c-groceries", merchant: "Freshmart" }),
  txn({ amount: 150, categoryId: "c-dining", merchant: "Pizza Place" }),
  // A refund: money IN, but sitting in a spend category.
  txn({ amount: 50, type: "INCOME", categoryId: "c-groceries", merchant: "Freshmart refund" }),
  // Real income.
  txn({ amount: 8000, type: "INCOME", categoryId: "c-salary", merchant: "Example Ltd" }),
  // A transfer — excluded from every total.
  txn({ amount: 30000, categoryId: "c-transfers", merchant: "Broker deposit" }),
  // Business spend, and a manual row with no account at all.
  txn({ amount: 500, categoryId: "c-dining", accountId: "a-biz", merchant: "Client dinner" }),
  txn({ amount: 20, categoryId: "c-groceries", accountId: null, merchant: "Cash top-up" }),
];

beforeEach(() => {
  vi.clearAllMocks();
  db.transaction.findMany.mockResolvedValue(TXNS);
  db.transaction.count.mockResolvedValue(2);
  db.category.findMany.mockImplementation((args: { where?: Record<string, unknown> }) => {
    const w = args?.where ?? {};
    if (w.excludeFromTotals === true) {
      return Promise.resolve(CATEGORIES.filter((c) => c.excludeFromTotals));
    }
    if (w.excludeFromTotals === false) {
      return Promise.resolve(CATEGORIES.filter((c) => !c.excludeFromTotals));
    }
    return Promise.resolve(CATEGORIES);
  });
  db.account.findMany.mockImplementation((args: { where?: Record<string, unknown> }) => {
    const biz = (args?.where as { biz?: { not?: string } })?.biz;
    if (biz?.not === "PERSONAL") {
      return Promise.resolve(ACCOUNTS.filter((a) => a.biz !== "PERSONAL"));
    }
    return Promise.resolve(ACCOUNTS);
  });
  db.account.findFirst.mockResolvedValue(ACCOUNTS[0]);
  db.recurringRule.findMany.mockResolvedValue([
    {
      id: "r-rent", merchant: "Rent", amount: 1200, currency: "EUR", type: "EXPENSE",
      cadence: "MONTHLY", nextDate: new Date(Date.UTC(2026, 7, 1)), endDate: null,
      active: true, categoryId: "c-groceries", accountId: "a-personal",
      category: CATEGORIES[0], account: ACCOUNTS[0],
    },
    {
      id: "r-invoice", merchant: "Example Ltd", amount: 14000, currency: "EUR", type: "INCOME",
      cadence: "MONTHLY", nextDate: new Date(Date.UTC(2026, 7, 28)),
      endDate: new Date(Date.UTC(2026, 11, 31)),
      active: true, categoryId: "c-salary", accountId: "a-biz",
      category: CATEGORIES[2], account: ACCOUNTS[1],
    },
  ]);
  db.$queryRaw.mockResolvedValue([
    { m: new Date(Date.UTC(2026, 6, 1)), n: BigInt(40) },
    { m: new Date(Date.UTC(2026, 5, 1)), n: BigInt(35) },
  ]);
});

describe("periodWhere", () => {
  it("matches on the accrual date when there is one, else the charge date", () => {
    const start = new Date(Date.UTC(2026, 9, 1));
    const end = new Date(Date.UTC(2026, 10, 1));
    expect(periodWhere(start, end)).toEqual({
      AND: [
        {
          OR: [
            { accrualDate: null, date: { gte: start, lt: end } },
            { accrualDate: { gte: start, lt: end } },
          ],
        },
      ],
    });
  });

  it("wraps in AND, never a bare OR — a bare OR collides with the scope filter", () => {
    const w = periodWhere(new Date(), new Date());
    expect(Object.keys(w)).toEqual(["AND"]);
  });
});

describe("scopeAccountFilter", () => {
  it("is unfiltered for the combined view", async () => {
    expect(await scopeAccountFilter(USER, "all")).toEqual({});
  });

  it("keeps account-less manual rows in the Personal scope", async () => {
    const w = await scopeAccountFilter(USER, "personal");
    // NOT IN drops NULLs in SQL, so the null branch must be explicit.
    expect(w).toEqual({
      OR: [{ accountId: null }, { accountId: { notIn: ["a-biz", "a-biz2"] } }],
    });
  });

  it("selects every business account for the Business scope", async () => {
    expect(await scopeAccountFilter(USER, "business")).toEqual({
      accountId: { in: ["a-biz", "a-biz2"] },
    });
  });

  it("lists the business account ids", async () => {
    expect(await businessAccountIds(USER)).toEqual(["a-biz", "a-biz2"]);
  });
});

describe("getBudgetStatus", () => {
  it("nets a refund against its own category instead of counting it as income", async () => {
    const rows = await getBudgetStatus(USER, REF);
    const groceries = rows.find((r) => r.id === "c-groceries")!;
    // 300 + 20 spent, 50 refunded.
    expect(groceries.spent).toBe(270);
  });

  it("never returns a category flagged out of totals", async () => {
    db.category.findMany.mockResolvedValue(CATEGORIES.filter((c) => !c.excludeFromTotals));
    const rows = await getBudgetStatus(USER, REF);
    expect(rows.map((r) => r.id)).not.toContain("c-transfers");
  });

  it("computes the budget ratio, and leaves it null with no budget", async () => {
    const rows = await getBudgetStatus(USER, REF);
    expect(rows.find((r) => r.id === "c-groceries")!.pct).toBeCloseTo(270 / 400, 6);
    expect(rows.find((r) => r.id === "c-salary")!.pct).toBeNull();
  });

  it("keeps uncategorised spend out of every budget row but in its own un-capped slice", async () => {
    db.transaction.findMany.mockResolvedValue([txn({ amount: 99, categoryId: null })]);
    const rows = await getBudgetStatus(USER, REF);
    // No real category absorbs it …
    expect(rows.filter((r) => r.id !== "__uncat__").every((r) => r.spent === 0)).toBe(true);
    // … but it is spend, so "Spent this month" must still see it (it used to vanish).
    const uncat = rows.find((r) => r.id === "__uncat__")!;
    expect(uncat.spent).toBe(99);
    expect(uncat.budget).toBeNull();
    expect(["NEEDS", "WANTS", "SAVINGS", "INCOME"]).not.toContain(uncat.group); // never an editable row
  });
});

describe("getDashboard", () => {
  it("excludes transfers from both spend and income", async () => {
    const d = await getDashboard(USER, REF);
    expect(d.spent).toBeLessThan(30000);
    expect(d.income).toBe(8000);
  });

  it("nets the refund out of spend", async () => {
    const d = await getDashboard(USER, REF);
    // 300 + 150 + 500 + 20 − 50
    expect(d.spent).toBe(920);
  });

  it("carries the to-review count through", async () => {
    expect((await getDashboard(USER, REF)).toReviewCount).toBe(2);
  });

  it("returns the pace series and recent rows", async () => {
    const d = await getDashboard(USER, REF);
    expect(Array.isArray(d.pace)).toBe(true);
    expect(d.recent.length).toBeGreaterThan(0);
    expect(d.upcoming.length).toBeGreaterThan(0);
  });

  it("scopes to business accounts when asked", async () => {
    await getDashboard(USER, REF, "business");
    const where = db.transaction.findMany.mock.calls[0][0].where;
    expect(where.accountId).toEqual({ in: ["a-biz", "a-biz2"] });
  });
});

describe("getYearSummary", () => {
  it("summarises the year with mean and median per month", async () => {
    const y = await getYearSummary(USER, REF);
    expect(y.year).toBe(2026);
    expect(y.total).toBeGreaterThan(0);
    expect(y.income).toBe(8000);
    expect(y.net).toBe(y.income - y.total);
    expect(y.avgPerMonth).toBeGreaterThan(0);
    expect(y.typicalPerMonth).toBeGreaterThan(0);
  });

  it("ranks categories by spend, transfers excluded", async () => {
    const y = await getYearSummary(USER, REF);
    expect(y.categories.map((c) => c.name)).not.toContain("Transfers");
  });

  it("names the tax and business-travel money inside the total, and the months the mean divides by", async () => {
    const y = await getYearSummary(USER, REF);
    const tax = y.categories.find((c) => c.name === "Tax")?.total ?? 0;
    const travel = y.categories.find((c) => c.name === "Business travel")?.total ?? 0;
    expect(y.taxTotal).toBeCloseTo(tax, 2);
    expect(y.businessTravelTotal).toBeCloseTo(travel, 2);
    expect(y.taxTotal + y.businessTravelTotal).toBeLessThanOrEqual(y.total + 1e-6);
    expect(y.elapsedMonths).toBeGreaterThanOrEqual(1);
  });

  it("lists the excluded money separately — out, in and net — without touching the total", async () => {
    const y = await getYearSummary(USER, REF);
    const transfers = y.excluded.find((c) => c.name === "Transfers");
    expect(transfers).toBeDefined();
    expect(transfers!.out).toBe(30000);
    expect(transfers!.inflow).toBe(0);
    expect(transfers!.net).toBe(30000);
    // The excluded block is a separate list: nothing in it leaks into the spend total.
    const counted = y.categories.reduce((s, c) => s + c.total, 0);
    expect(y.total).toBeCloseTo(counted, 6);
  });
});

describe("month selection", () => {
  it("picks the newest month that has real activity", async () => {
    const m = await latestTxnMonth(USER);
    expect(m.toISOString().slice(0, 7)).toBe("2026-07");
  });

  it("skips a near-empty newest month with fewer than five rows", async () => {
    db.$queryRaw.mockResolvedValue([
      { m: new Date(Date.UTC(2026, 7, 1)), n: BigInt(1) },
      { m: new Date(Date.UTC(2026, 6, 1)), n: BigInt(40) },
    ]);
    expect((await latestTxnMonth(USER)).toISOString().slice(0, 7)).toBe("2026-07");
  });

  it("falls back to the newest month when nothing is meaningful", async () => {
    db.$queryRaw.mockResolvedValue([{ m: new Date(Date.UTC(2026, 7, 1)), n: BigInt(1) }]);
    expect((await latestTxnMonth(USER)).toISOString().slice(0, 7)).toBe("2026-08");
  });

  it("falls back to the current month with no data at all", async () => {
    db.$queryRaw.mockResolvedValue([]);
    await expect(latestTxnMonth(USER)).resolves.toBeInstanceOf(Date);
  });

  it("returns a usable default dashboard month and a coverage verdict", async () => {
    await expect(defaultDashboardMonth(USER)).resolves.toBeInstanceOf(Date);
    const cov = await getMonthCoverage(USER, REF);
    expect(typeof cov.complete).toBe("boolean");
  });
});

describe("trends and merchants", () => {
  it("returns a point per month in the window", async () => {
    const t = await getMonthlyTrend(USER, 6, "all", REF);
    expect(t).toHaveLength(6);
    expect(t[0]).toHaveProperty("label");
    expect(t[0]).toHaveProperty("income");
    expect(t[0]).toHaveProperty("expense");
  });

  it("ranks merchants by spend and leaves transfers out", async () => {
    const m = await getTopMerchants(USER, REF);
    expect(m.map((x) => x.name)).not.toContain("Broker deposit");
    for (let i = 1; i < m.length; i++) {
      expect(m[i - 1].total).toBeGreaterThanOrEqual(m[i].total);
    }
  });
});

describe("getIncomeOverview", () => {
  it("projects the active income rules and honours their end dates", async () => {
    const o = await getIncomeOverview(USER, REF, "all");
    expect(o.streams.length).toBeGreaterThan(0);
    expect(o.byMonth.length).toBe(12);
    expect(o.projection).toBeDefined();
  });

  it("lists the recurring bills as fixed outgoings", async () => {
    const o = await getIncomeOverview(USER, REF, "all");
    expect(o.fixedOutgoings.some((f) => f.merchant === "Rent")).toBe(true);
    expect(o.fixedOutgoingsTotal).toBeGreaterThan(0);
  });

  it("does not forecast a rule that has already ended", async () => {
    db.recurringRule.findMany.mockResolvedValue([
      {
        id: "r-old-salary", merchant: "Old Employer GmbH", amount: 8000, currency: "EUR", type: "INCOME",
        cadence: "MONTHLY", nextDate: new Date(Date.UTC(2026, 6, 31)),
        endDate: new Date(Date.UTC(2026, 6, 31)),
        active: true, categoryId: "c-salary", accountId: "a-personal",
        category: CATEGORIES[2], account: ACCOUNTS[0],
      },
    ]);
    const o = await getIncomeOverview(USER, new Date(Date.UTC(2026, 10, 15)), "all");
    const future = o.byMonth.filter((m) => m.projected > 0);
    expect(future).toHaveLength(0);
  });
});

// F3: a split row is one reconciled bank row whose amount is spread across
// categories. Every grand total must stay put; only the per-category spread moves.
describe("split transactions (F3)", () => {
  // The 300 Freshmart row split 200 groceries + 100 dining. Parent keeps the largest part's category.
  const SPLIT_TXNS = TXNS.map((t, i) =>
    i === 0
      ? { ...t, splits: [{ amount: 200, categoryId: "c-groceries" }, { amount: 100, categoryId: "c-dining" }] }
      : t,
  );

  it("keeps the grand totals and moves the category spread (year summary)", async () => {
    const before = await getYearSummary(USER, REF);
    db.transaction.findMany.mockResolvedValue(SPLIT_TXNS);
    const after = await getYearSummary(USER, REF);
    expect(after.total).toBeCloseTo(before.total, 2);
    expect(after.income).toBeCloseTo(before.income, 2);
    const cat = (s: typeof before, n: string) => s.categories.find((c) => c.name === n)?.total ?? 0;
    expect(cat(after, "Groceries")).toBeCloseTo(cat(before, "Groceries") - 100, 2);
    expect(cat(after, "Dining")).toBeCloseTo(cat(before, "Dining") + 100, 2);
  });

  it("budgets see each part in its own category; the dashboard total is unchanged", async () => {
    const budBefore = await getBudgetStatus(USER, REF);
    const dashBefore = await getDashboard(USER, REF);
    db.transaction.findMany.mockResolvedValue(SPLIT_TXNS);
    const budAfter = await getBudgetStatus(USER, REF);
    const dashAfter = await getDashboard(USER, REF);
    const spent = (rows: typeof budBefore, id: string) => rows.find((r) => r.id === id)!.spent;
    expect(spent(budAfter, "c-groceries")).toBeCloseTo(spent(budBefore, "c-groceries") - 100, 2);
    expect(spent(budAfter, "c-dining")).toBeCloseTo(spent(budBefore, "c-dining") + 100, 2);
    expect(dashAfter.spent).toBeCloseTo(dashBefore.spent, 2);
    expect(dashAfter.income).toBeCloseTo(dashBefore.income, 2);
  });

  it("applies exclusion per part: a part moved to Transfers leaves the totals", async () => {
    const before = await getYearSummary(USER, REF);
    db.transaction.findMany.mockResolvedValue(
      TXNS.map((t, i) => (i === 0 ? { ...t, splits: [{ amount: 250, categoryId: "c-groceries" }, { amount: 50, categoryId: "c-transfers" }] } : t)),
    );
    const after = await getYearSummary(USER, REF);
    expect(after.total).toBeCloseTo(before.total - 50, 2);
  });

  it("counts a split charge once per merchant", async () => {
    db.transaction.findMany.mockResolvedValue(SPLIT_TXNS);
    const top = await getTopMerchants(USER, REF);
    const shop = top.find((m) => m.name.toLowerCase().includes("freshmart"))!;
    expect(shop.count).toBe(1);
  });
});
