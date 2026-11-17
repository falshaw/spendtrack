/**
 * Investments maths, pure:
 *   - dividends: a synced dividend that is already an imported statement row is counted
 *     once (unmatchedDividends), and the rest folds into the income overview, the trend
 *     and the Sankey;
 *   - net worth: a broker connection adds its value as a portfolio, and one linked to an
 *     investment account replaces that account's balance instead of adding to it;
 *   - portfolio figures: allocation, the combined value history, last change, P/L.
 */
import { describe, expect, it } from "vitest";
import {
  addIncomeToTrend,
  allocation,
  brokerNavRows,
  byMonth,
  combineHistory,
  DIVIDEND_SOURCE,
  lastChange,
  unmatchedDividends,
  unrealised,
  withDividendIncome,
} from "@/lib/investments";
import { computeNetWorth, summariseNav } from "@/lib/net-worth";
import { buildSankey } from "@/lib/sankey";

const div = (id: string, paidOn: string, eur: number, symbol = "DEMO", accountId: string | null = null) => ({ id, paidOn, eur, symbol, accountId });
const txn = (id: string, date: string, eur: number, merchant = "Dividend DEMO", accountId: string | null = "broker") => ({ id, date, eur, merchant, accountId });

describe("unmatchedDividends — no double counting with imported statements", () => {
  it("drops a synced dividend that an imported dividend row already carries", () => {
    const r = unmatchedDividends([div("d1", "2026-05-15", 2.5), div("d2", "2026-06-15", 3)], [txn("t1", "2026-05-16", 2.5)]);
    expect(r.kept.map((d) => d.id)).toEqual(["d2"]);
    expect(r.matched).toEqual([{ dividendId: "d1", transactionId: "t1" }]);
  });

  it("matches within 3 days and a small FX tolerance only", () => {
    const synced = [div("near", "2026-05-15", 10), div("far", "2026-05-15", 10), div("off", "2026-05-15", 10)];
    expect(unmatchedDividends([synced[0]], [txn("t", "2026-05-18", 10.15)]).kept).toEqual([]);
    expect(unmatchedDividends([synced[1]], [txn("t", "2026-05-19", 10)]).kept).toHaveLength(1);
    expect(unmatchedDividends([synced[2]], [txn("t", "2026-05-15", 11)]).kept).toHaveLength(1);
  });

  it("only treats rows that say 'dividend' as dividends", () => {
    expect(unmatchedDividends([div("d", "2026-05-15", 5)], [txn("t", "2026-05-15", 5, "Salary")]).kept).toHaveLength(1);
    expect(unmatchedDividends([div("d", "2026-05-15", 5)], [txn("t", "2026-05-15", 5, "DIVIDEND PAYMENT")]).kept).toHaveLength(0);
  });

  it("never matches a statement row naming another ticker", () => {
    expect(unmatchedDividends([div("d", "2026-05-15", 5, "DEMO")], [txn("t", "2026-05-15", 5, "Dividend OTHER")]).kept).toHaveLength(1);
  });

  it("uses each imported row once, and respects the linked account", () => {
    const two = unmatchedDividends([div("a", "2026-05-15", 5), div("b", "2026-05-15", 5)], [txn("t", "2026-05-15", 5)]);
    expect(two.kept.map((d) => d.id)).toEqual(["b"]);
    const linked = unmatchedDividends([div("a", "2026-05-15", 5, "DEMO", "broker")], [txn("t", "2026-05-15", 5, "Dividend DEMO", "bank")]);
    expect(linked.kept).toHaveLength(1);
  });
});

describe("dividend income aggregation", () => {
  const overview = {
    year: 2026,
    totalYtd: 1000,
    monthsWithIncome: 1,
    bySource: [{ name: "Bank A", color: "#000", value: 1000 }],
    byMonth: Array.from({ length: 12 }, (_, i) => ({ monthIndex: i, label: String(i), actual: i === 0 ? 1000 : 0, projected: 0 })),
    projection: { receivedYtd: 1000, remainingSalary: 500, remainingPayments: 1, projectedTotal: 1500 },
    trend: [
      { monthRef: "2025-12", label: "Dec", income: 0, expense: 10 },
      { monthRef: "2026-01", label: "Jan", income: 1000, expense: 10 },
      { monthRef: "2026-02", label: "Feb", income: 0, expense: 10 },
    ],
  };

  it("folds deduplicated dividends into received, sources, months, projection and trend", () => {
    const monthly = byMonth([
      { date: "2025-12-15", eur: 4 },
      { date: "2026-01-20", eur: 5.5 },
      { date: "2026-02-10", eur: 2 },
      { date: "2026-02-20", eur: 2.5 },
    ]);
    const ov = withDividendIncome(overview, monthly);
    expect(ov.totalYtd).toBe(1010); // 5.5 + 4.5 this year; December belongs to last year
    expect(ov.bySource).toContainEqual({ ...DIVIDEND_SOURCE, value: 10 });
    expect(ov.byMonth[0].actual).toBe(1005.5);
    expect(ov.byMonth[1].actual).toBe(4.5);
    expect(ov.monthsWithIncome).toBe(2);
    expect(ov.projection).toMatchObject({ receivedYtd: 1010, projectedTotal: 1510 });
    expect(ov.trend.map((p) => p.income)).toEqual([4, 1006, 5]);
  });

  it("leaves the overview alone when there are no dividends", () => {
    expect(withDividendIncome(overview, new Map())).toEqual(overview);
  });

  it("adds investment income to trend points by month", () => {
    expect(addIncomeToTrend([{ monthRef: "2026-01", income: 10 }], new Map([["2026-01", 2.4]]))).toEqual([{ monthRef: "2026-01", income: 12 }]);
  });

  it("draws dividends as their own income source in the Sankey", () => {
    const s = buildSankey(
      [{ type: "INCOME", categoryId: "sal", eur: 100 }, { type: "EXPENSE", categoryId: "food", eur: 50 }],
      [
        { id: "sal", name: "Salary", color: "#1", group: "INCOME", excludeFromTotals: false },
        { id: "food", name: "Food", color: "#2", group: "NEEDS", excludeFromTotals: false },
      ],
      undefined,
      [{ name: "Dividends (broker sync)", color: "#3", eur: 20 }],
    );
    expect(s.income).toBe(120);
    expect(s.saved).toBe(70);
    expect(s.nodes.some((n) => n.kind === "source" && n.name === "Dividends (broker sync)")).toBe(true);
  });
});

describe("net worth — broker portfolios", () => {
  const accounts = [{ accountId: "inv", name: "Broker account", date: "2026-06-20", value: 5000 }];

  it("adds an unlinked connection as its own portfolio", () => {
    const rows = brokerNavRows(accounts, [{ label: "Trading 212", accountId: null, date: "2026-06-29", value: 3000 }]);
    expect(rows).toEqual([
      { name: "Broker account", date: "2026-06-20", value: 5000 },
      { name: "Trading 212", date: "2026-06-29", value: 3000 },
    ]);
  });

  it("replaces the linked account's balance instead of adding to it", () => {
    const rows = brokerNavRows(accounts, [{ label: "Trading 212", accountId: "inv", date: "2026-06-29", value: 5200 }]);
    expect(rows).toEqual([{ name: "Broker account (Trading 212)", date: "2026-06-29", value: 5200 }]);
  });

  it("ignores a connection without a value", () => {
    expect(brokerNavRows(accounts, [{ label: "Interactive Brokers", accountId: "inv", date: null, value: null }])).toEqual([
      { name: "Broker account", date: "2026-06-20", value: 5000 },
    ]);
  });

  it("counts the portfolio as an investment asset in net worth, per broker", () => {
    const nav = summariseNav(
      brokerNavRows([], [
        { label: "Trading 212", accountId: null, date: "2026-06-29", value: 3000 },
        { label: "Interactive Brokers", accountId: null, date: "2026-06-29", value: 4000 },
      ]),
      "2026-06-30",
      "2026-07-05",
    );
    const r = computeNetWorth({
      month: "2026-06-01",
      accounts: [{ id: "bank", name: "Bank", type: "BANK" }],
      balances: [{ accountId: "bank", asOf: "2026-06-30", eur: 1000 }],
      items: [],
      nav,
      reserve: null,
    });
    expect(r.trading).toBe(7000);
    expect(r.net).toBe(8000);
    expect(r.detail.trading.map((p) => p.name)).toEqual(["Trading 212", "Interactive Brokers"]);
    expect(r.estimated).toBe(false);
  });
});

describe("portfolio figures", () => {
  const holdings = [
    { symbol: "A", name: null, eur: 500, pnlEur: 100 },
    { symbol: "B", name: null, eur: 300, pnlEur: -50 },
    { symbol: "C", name: null, eur: null, pnlEur: null },
  ];

  it("allocates by value, largest first, folding the tail and adding cash", () => {
    const a = allocation([...holdings, { symbol: "D", name: null, eur: 100, pnlEur: 0 }], 50, 2);
    expect(a.map((s) => [s.name, s.value])).toEqual([
      ["A", 500],
      ["B", 300],
      ["Other (1)", 100],
      ["Cash", 50],
    ]);
  });

  it("sums unrealised P/L against the cost it is measured on", () => {
    expect(unrealised(holdings)).toEqual({ pnl: 50, cost: 750, pct: 6.67 });
    expect(unrealised([])).toEqual({ pnl: null, cost: null, pct: null });
  });

  it("combines histories, carrying each account's last value forward", () => {
    const h = combineHistory([
      [
        { date: "2026-06-01", eur: 100 },
        { date: "2026-06-03", eur: 110 },
      ],
      [{ date: "2026-06-02", eur: 50 }],
    ]);
    expect(h).toEqual([
      { date: "2026-06-01", eur: 100 },
      { date: "2026-06-02", eur: 150 },
      { date: "2026-06-03", eur: 160 },
    ]);
    expect(lastChange(h)).toEqual({ abs: 10, pct: 6.67, since: "2026-06-02" });
    expect(lastChange(h.slice(0, 1))).toBeNull();
  });
});
