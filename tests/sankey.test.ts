/**
 * F6 — the Sankey builder: every node balances (inflow = outflow) and the totals
 * equal getYearSummary's on the same rows (same exclusions, refunds, reversals).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  transaction: { findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn() },
  category: { findMany: vi.fn() },
  account: { findMany: vi.fn(), findFirst: vi.fn() },
  $queryRaw: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));

import { buildSankey, type SankeyCategory, type SankeyData } from "@/lib/sankey";
import { getYearSummary } from "@/lib/finance";

const CATS: SankeyCategory[] = [
  { id: "c-salary", name: "Salary", color: "#5e6b4f", group: "INCOME", excludeFromTotals: false },
  { id: "c-groc", name: "Groceries", color: "#2a9d8f", group: "NEEDS", excludeFromTotals: false },
  { id: "c-rent", name: "Rent", color: "#2a6fb0", group: "NEEDS", excludeFromTotals: false },
  { id: "c-dining", name: "Dining Out", color: "#bf5a36", group: "WANTS", excludeFromTotals: false },
  { id: "c-shop", name: "Shopping", color: "#c7658e", group: "WANTS", excludeFromTotals: false },
  { id: "c-transfers", name: "Transfers", color: "#a59c8e", group: "SAVINGS", excludeFromTotals: true },
];

const T = (type: string, categoryId: string | null, eur: number) => ({ type, categoryId, eur });
const ROWS = [
  T("INCOME", "c-salary", 5000),
  T("INCOME", null, 300), // uncategorised income = real income
  T("EXPENSE", "c-salary", 200), // pay handed back
  T("EXPENSE", "c-rent", 1200),
  T("EXPENSE", "c-groc", 400),
  T("INCOME", "c-groc", 50), // refund nets against groceries
  T("EXPENSE", "c-dining", 250),
  T("EXPENSE", "c-shop", 120),
  T("EXPENSE", null, 30),
  T("EXPENSE", "c-transfers", 33000), // excluded
  T("INCOME", "c-transfers", 10000), // excluded
];

function balance(d: SankeyData) {
  const inflow = new Map<number, number>();
  const outflow = new Map<number, number>();
  for (const l of d.links) {
    outflow.set(l.source, (outflow.get(l.source) ?? 0) + l.value);
    inflow.set(l.target, (inflow.get(l.target) ?? 0) + l.value);
  }
  return { inflow, outflow };
}

describe("buildSankey", () => {
  it("leaves excluded categories out and nets refunds and reversals", () => {
    const d = buildSankey(ROWS, CATS);
    expect(d.income).toBe(5100); // 5000 - 200 + 300
    expect(d.spend).toBe(1950); // 1200 + 350 + 250 + 120 + 30
    expect(d.saved).toBe(3150);
    expect(d.fromSavings).toBe(0);
    expect(d.nodes.some((n) => n.name === "Transfers")).toBe(false);
  });

  it("every intermediate node passes on exactly what it receives", () => {
    const d = buildSankey(ROWS, CATS);
    const { inflow, outflow } = balance(d);
    d.nodes.forEach((n, i) => {
      if (n.kind === "hub" || n.kind === "group") {
        expect(Math.abs((inflow.get(i) ?? 0) - (outflow.get(i) ?? 0))).toBeLessThan(0.011);
      }
    });
  });

  it("adds a From savings node when spend exceeds income", () => {
    const d = buildSankey([T("INCOME", "c-salary", 1000), T("EXPENSE", "c-rent", 1200)], CATS);
    expect(d.fromSavings).toBe(200);
    expect(d.saved).toBe(0);
    const i = d.nodes.findIndex((n) => n.kind === "savings");
    expect(d.links.find((l) => l.source === i)?.value).toBe(200);
    expect(d.nodes.some((n) => n.kind === "saved")).toBe(false);
  });

  it("folds categories beyond the top N into Other <group>", () => {
    const d = buildSankey(ROWS, CATS, 2);
    const names = d.nodes.filter((n) => n.kind === "category").map((n) => n.name);
    expect(names).toContain("Rent");
    expect(names).toContain("Groceries");
    expect(names).toContain("Other wants");
    expect(names).not.toContain("Shopping");
  });

  it("leaves a net-negative category out and reports it as netted", () => {
    const d = buildSankey([T("INCOME", "c-salary", 1000), T("EXPENSE", "c-shop", 20), T("INCOME", "c-shop", 120)], CATS);
    expect(d.spend).toBe(0);
    expect(d.netted).toBe(100);
  });

  it("an empty window draws nothing", () => {
    expect(buildSankey([], CATS).links).toEqual([]);
  });
});

describe("buildSankey vs getYearSummary — the same totals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const date = new Date(Date.UTC(2026, 6, 10));
    db.transaction.findMany.mockResolvedValue(
      ROWS.map((r, i) => ({
        id: `t${i}`, amount: r.eur, currency: "EUR", type: r.type, date, accrualDate: null,
        categoryId: r.categoryId, accountId: "a1",
      })),
    );
    db.transaction.count.mockResolvedValue(0);
    db.transaction.groupBy.mockResolvedValue([]);
    db.$queryRaw.mockResolvedValue([]);
    db.category.findMany.mockImplementation((args: { where?: { excludeFromTotals?: boolean } }) =>
      Promise.resolve(args?.where?.excludeFromTotals === true ? CATS.filter((c) => c.excludeFromTotals) : CATS),
    );
    db.account.findMany.mockResolvedValue([{ id: "a1", name: "A", biz: "PERSONAL", currency: "EUR", type: "BANK" }]);
  });

  it("spend = year total and income = year income", async () => {
    const y = await getYearSummary("u1", new Date(Date.UTC(2026, 6, 15)), "all");
    const d = buildSankey(ROWS, CATS);
    expect(d.spend).toBeCloseTo(y.total, 2);
    expect(d.income).toBeCloseTo(y.income, 2);
  });
});
