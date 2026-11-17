/**
 * F1 — net-worth maths: as-of selection (latest balance ≤ month end, later ones
 * ignored), card sign (a negative balance is a liability), the broker account
 * skipped, trading null stays null (never 0) and marks the figure estimated, the
 * reserve shown beside net (not subtracted), items by as-of, NAV staleness, CSV.
 */
import { describe, expect, it } from "vitest";
import {
  balancesAsOf,
  computeNetWorth,
  lastCompleteMonth,
  monthEndOf,
  netWorthCsvRows,
  summariseNav,
  type NavResult,
} from "@/lib/net-worth";
import { csvCell, toCsv } from "@/lib/csv";

const ACCOUNTS = [
  { id: "bank", name: "Bank A", type: "BANK" },
  { id: "card", name: "Card A", type: "CARD" },
  { id: "broker", name: "Broker A", type: "INVESTMENT" },
  { id: "sav", name: "Business savings", type: "BANK" },
];
const BALANCES = [
  { accountId: "bank", asOf: "2026-08-31", eur: 1000 },
  { accountId: "bank", asOf: "2026-09-30", eur: 1500 },
  { accountId: "bank", asOf: "2026-10-10", eur: 9999 }, // after the September month end
  { accountId: "card", asOf: "2026-09-20", eur: -2400 },
  { accountId: "broker", asOf: "2026-09-30", eur: 50000 }, // must be skipped
  { accountId: "sav", asOf: "2026-09-30", eur: 12500 },
];
const NAV: NavResult = { total: 30000, portfolios: [{ name: "Broker A", value: 30000, date: "2026-09-29", stale: false }], problem: null };

describe("helpers", () => {
  it("month end, last complete month", () => {
    expect(monthEndOf("2026-02-10")).toBe("2026-02-28");
    expect(monthEndOf("2028-02-01")).toBe("2028-02-29");
    expect(lastCompleteMonth("2026-10-19")).toBe("2026-09-01");
    expect(lastCompleteMonth("2026-01-03")).toBe("2025-12-01");
  });
  it("balancesAsOf takes the latest on or before the cut-off", () => {
    const m = balancesAsOf(BALANCES, "2026-09-30");
    expect(m.get("bank")?.eur).toBe(1500);
    expect(balancesAsOf(BALANCES, "2026-09-15").get("bank")?.eur).toBe(1000);
    expect(balancesAsOf(BALANCES, "2026-08-01").has("bank")).toBe(false);
  });
});

describe("computeNetWorth", () => {
  const base = { month: "2026-09-01", accounts: ACCOUNTS, balances: BALANCES, items: [], nav: NAV, reserve: 8000 };

  it("cash, card sign, broker skipped, net, reserve beside it", () => {
    const r = computeNetWorth(base);
    expect(r.month).toBe("2026-09-01");
    expect(r.cash).toBe(14000);
    expect(r.cards).toBe(2400);
    expect(r.liabilities).toBe(2400);
    expect(r.trading).toBe(30000);
    expect(r.net).toBe(Math.round((14000 + 30000 - 2400) * 100) / 100);
    expect(r.reserve).toBe(8000);
    expect(r.netAfterReserve).toBe(Math.round((r.net - 8000) * 100) / 100);
    expect(r.detail.lines.map((l) => l.accountId)).toEqual(["bank", "card", "sav"]);
    expect(r.estimated).toBe(false);
  });

  it("trading null stays null, net leaves it out, and the figure is estimated", () => {
    const r = computeNetWorth({ ...base, nav: { total: null, portfolios: [], problem: "not configured" } });
    expect(r.trading).toBeNull();
    expect(r.net).toBe(Math.round((14000 - 2400) * 100) / 100);
    expect(r.estimated).toBe(true);
    expect(r.detail.tradingProblem).toBe("not configured");
  });

  it("a missing or stale balance is listed and marks the figure estimated, never guessed", () => {
    const r = computeNetWorth({ ...base, month: "2026-11-01" });
    // bank's latest is 2026-10-10 (51 days before 30.11 → stale); card 20.09 stale too
    expect(r.detail.lines.find((l) => l.accountId === "bank")).toMatchObject({ eur: 9999, state: "stale" });
    expect(r.estimated).toBe(true);
    const early = computeNetWorth({ ...base, month: "2026-07-01" });
    expect(early.detail.lines.every((l) => l.state === "missing")).toBe(true);
    expect(early.cash).toBe(0);
  });

  it("items count from their as-of: assets add, a liability subtracts", () => {
    const items = [
      { id: "car", kind: "CAR" as const, name: "Car", eur: 20000, asOf: "2026-09-01" },
      { id: "loan", kind: "LIABILITY" as const, name: "Loan", eur: 5000, asOf: "2026-09-15" },
      { id: "later", kind: "ASSET" as const, name: "Later", eur: 999, asOf: "2026-10-05" },
    ];
    const r = computeNetWorth({ ...base, items });
    expect(r.assets).toBe(20000);
    expect(r.liabilities).toBe(Math.round((2400 + 5000) * 100) / 100);
    expect(r.detail.items.map((i) => i.id)).toEqual(["car", "loan"]);
  });

  it("no reserve schedule: reserve and after-reserve are null", () => {
    const r = computeNetWorth({ ...base, reserve: null });
    expect(r.reserve).toBeNull();
    expect(r.netAfterReserve).toBeNull();
  });
});

describe("summariseNav", () => {
  it("sums known investment accounts, flags stale (> NAV_STALE_DAYS) and missing values", () => {
    const r = summariseNav(
      [
        { name: "Invest", date: "2026-09-01", value: 12000.333 },
        { name: "CFD", date: "2026-10-18", value: 500 },
        { name: "Broker B", date: null, value: null },
      ],
      "2026-10-19",
      "2026-10-19",
    );
    expect(r.total).toBe(12500.33);
    expect(r.portfolios.find((p) => p.name === "Invest")?.stale).toBe(true);
    expect(r.portfolios.find((p) => p.name === "CFD")?.stale).toBe(false);
    expect(r.problem).toMatch(/Broker B/);
  });
  it("judges staleness against the month end for a past month", () => {
    const r = summariseNav([{ name: "Invest", date: "2026-09-28", value: 1 }], "2026-09-30", "2026-10-19");
    expect(r.portfolios[0].stale).toBe(false);
  });
  it("nothing readable → null, never 0", () => {
    expect(summariseNav([{ name: "Broker B", date: null, value: null }], "2026-10-19", "2026-10-19").total).toBeNull();
    expect(summariseNav([], "2026-10-19", "2026-10-19").total).toBeNull();
  });
});

describe("CSV", () => {
  it("writes trading null as an empty cell and the after-reserve column", () => {
    const rows = netWorthCsvRows([
      { month: "2026-09-01", cash: 100, cards: 10, trading: null, assets: 0, liabilities: 10, reserve: 50, net: 90, estimated: true },
    ]);
    const csv = toCsv(rows);
    const line = csv.split("\r\n")[1];
    expect(line).toBe("2026-09,100,10,,0,10,90,50,40,yes");
    expect(csv.split("\r\n")[0]).toMatch(/^Month,Cash/);
  });
  it("quotes delimiters and defuses formula-looking text", () => {
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell(-5)).toBe("-5");
    expect(csvCell(null)).toBe("");
  });
});
