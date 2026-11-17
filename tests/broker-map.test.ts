/**
 * Broker mapping, pure — fictional inputs only:
 *   - Trading 212: ticker symbols, the account snapshot, multi-fill orders merged into one
 *     trade, dividends and cash flows, and the next-page guard;
 *   - IBKR Flex: the Activity report fixture (positions in base, trades, deposits,
 *     dividends net of withholding tax, the value history) and the request answer.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  flexDate,
  flexDateTime,
  flexElements,
  flexReference,
  mapT212Dividends,
  mapT212Flows,
  mapT212Orders,
  mapT212Snapshot,
  parseFlexStatement,
  t212NextPath,
  t212Symbol,
} from "@/lib/broker-map";

const FLEX = readFileSync(path.join(import.meta.dirname, "fixtures", "ibkr-flex-activity.xml"), "utf-8");
const day = (s: string) => new Date(`${s}T00:00:00Z`);

describe("Trading 212 — symbols", () => {
  it("drops the market suffix and the lower-case exchange code", () => {
    expect(t212Symbol("AAPL_US_EQ")).toBe("AAPL");
    expect(t212Symbol("VUSAl_EQ")).toBe("VUSA");
    expect(t212Symbol("DEMOd_EQ")).toBe("DEMO");
    expect(t212Symbol("BRK.B_US_EQ")).toBe("BRK.B");
  });
});

describe("Trading 212 — account snapshot", () => {
  const snap = mapT212Snapshot(
    { currency: "EUR", totalValue: 3250, cash: { availableToTrade: 250 }, investments: { currentValue: 3000 } },
    [
      {
        instrument: { ticker: "DEMO_US_EQ", name: "Demo Corp", currency: "USD" },
        quantity: 10,
        averagePricePaid: 150,
        currentPrice: 200,
        walletImpact: { currentValue: 1800, unrealizedProfitLoss: 400 },
      },
      { instrument: { ticker: "EUFUNDd_EQ", currency: "EUR" }, quantity: 30, averagePricePaid: 40, currentPrice: 40, walletImpact: { currentValue: 1200, unrealizedProfitLoss: 0 } },
      { instrument: { ticker: "GONE_US_EQ", currency: "USD" }, quantity: 0, averagePricePaid: 10 },
    ],
    new Date("2026-06-30T15:30:00Z"),
  );

  it("maps cash, value, base currency and the as-of day", () => {
    expect(snap).toMatchObject({ baseCurrency: "EUR", cash: 250, totalValue: 3250, asOf: day("2026-06-30") });
    expect(snap.values).toEqual([{ date: day("2026-06-30"), value: 3250, cash: 250 }]);
  });

  it("keeps open positions only, price in instrument currency, value + P/L in base", () => {
    expect(snap.positions).toHaveLength(2);
    expect(snap.positions[0]).toEqual({
      symbol: "DEMO",
      name: "Demo Corp",
      quantity: 10,
      avgCost: 150,
      currency: "USD",
      price: 200,
      value: 1800,
      unrealisedPnl: 400,
    });
    expect(snap.positions[1]).toMatchObject({ symbol: "EUFUND", name: null, currency: "EUR" });
  });

  it("derives the total from cash + holdings when the summary has none", () => {
    const s = mapT212Snapshot({ currency: "GBP", cash: { availableToTrade: 100 } }, [{ ticker: "X_EQ", quantity: 1, walletImpact: { currentValue: 50 } }], new Date());
    expect(s.totalValue).toBe(150);
    expect(s.baseCurrency).toBe("GBP");
    expect(s.positions[0].currency).toBe("GBP"); // no instrument currency → the account's
  });
});

describe("Trading 212 — orders", () => {
  const fill = (id: number, side: string, quantity: number, price: number, filledAt: string, extra: Record<string, unknown> = {}) => ({
    order: { id, side, status: "FILLED", instrument: { ticker: "DEMO_US_EQ", currency: "USD" } },
    fill: { quantity, price, type: "TRADE", filledAt, walletImpact: { currency: "EUR", fxRate: 1.1, taxes: [{ quantity: -1 }] }, ...extra },
  });

  it("merges the fills of one order: quantity summed, price volume-weighted, fees summed, last time", () => {
    const [t] = mapT212Orders([fill(7, "SELL", -6, 100, "2026-03-01T10:00:00Z"), fill(7, "SELL", -4, 110, "2026-03-01T10:05:00Z")]);
    expect(t).toEqual({
      externalId: "t212:7",
      symbol: "DEMO",
      side: "SELL",
      quantity: 10,
      price: 104,
      fees: 2.2, // €1 + €1 at 1.1 USD per EUR
      currency: "USD",
      executedAt: new Date("2026-03-01T10:05:00Z"),
    });
  });

  it("skips unfilled orders, non-trade fills and rows with no usable numbers", () => {
    const rows = [
      { order: { id: 1, side: "BUY", status: "CANCELLED" }, fill: { quantity: 1, price: 1, filledAt: "2026-01-01T00:00:00Z" } },
      { order: { id: 2, side: "BUY", status: "FILLED" }, fill: { quantity: 1, price: 1, type: "STOCK_SPLIT", filledAt: "2026-01-01T00:00:00Z" } },
      { order: { id: 3, side: "BUY", status: "FILLED" }, fill: { quantity: 0, price: 1, filledAt: "2026-01-01T00:00:00Z" } },
      { order: { id: 4, side: "BUY", status: "FILLED" }, fill: { quantity: 1, price: 1, filledAt: "not a date" } },
      { order: { side: "BUY", status: "FILLED" }, fill: { quantity: 1, price: 1, filledAt: "2026-01-01T00:00:00Z" } },
    ];
    expect(mapT212Orders(rows)).toEqual([]);
  });

  it("keeps fees as-is when the wallet currency is the instrument currency", () => {
    const [t] = mapT212Orders([fill(9, "BUY", 2, 50, "2026-02-02T09:00:00Z", { walletImpact: { currency: "USD", taxes: [{ quantity: -0.5 }] } })]);
    expect(t.fees).toBe(0.5);
    expect(t.side).toBe("BUY");
  });
});

describe("Trading 212 — dividends and cash flows", () => {
  it("maps paid dividends in the account currency, amountInEuro as fallback", () => {
    const rows = mapT212Dividends(
      [
        { reference: "d1", ticker: "DEMO_US_EQ", quantity: 10, amount: 2.5, paidOn: "2026-05-15T08:00:00Z" },
        { reference: "d2", ticker: "EUFUNDd_EQ", quantity: 30, amountInEuro: 6, paidOn: "2026-06-15T08:00:00Z" },
        { reference: "d3", ticker: "X_EQ", amount: 0, paidOn: "2026-06-15T08:00:00Z" },
        { ticker: "X_EQ", amount: 1, paidOn: "2026-06-15T08:00:00Z" },
      ],
      "GBP",
    );
    expect(rows).toEqual([
      { externalId: "t212div:d1", symbol: "DEMO", paidOn: day("2026-05-15"), quantity: 10, amount: 2.5, withholdingTax: null, currency: "GBP" },
      { externalId: "t212div:d2", symbol: "EUFUND", paidOn: day("2026-06-15"), quantity: 30, amount: 6, withholdingTax: null, currency: "EUR" },
    ]);
  });

  it("maps deposits and withdrawals only, amounts positive with a kind", () => {
    const rows = mapT212Flows(
      [
        { type: "DEPOSIT", amount: 500, reference: "a", dateTime: "2026-01-02T12:00:00Z" },
        { type: "WITHDRAW", amount: -200, reference: "b", dateTime: "2026-02-03T12:00:00Z", currency: "USD" },
        { type: "FEE", amount: -1, reference: "c", dateTime: "2026-02-03T12:00:00Z" },
        { type: "TRANSFER", amount: 50, reference: "d", dateTime: "2026-02-03T12:00:00Z" },
      ],
      "EUR",
    );
    expect(rows).toEqual([
      { externalId: "t212:a", date: day("2026-01-02"), kind: "DEPOSIT", amount: 500, currency: "EUR", note: "Deposit" },
      { externalId: "t212:b", date: day("2026-02-03"), kind: "WITHDRAWAL", amount: 200, currency: "USD", note: "Withdrawal" },
    ]);
  });

  it("follows only a relative next-page path on the same list", () => {
    expect(t212NextPath("/api/v0/equity/history/dividends?limit=50&cursor=123", "dividends")).toBe("/equity/history/dividends?limit=50&cursor=123");
    expect(t212NextPath("https://elsewhere.example/api/v0/equity/history/dividends?cursor=1", "dividends")).toBeNull();
    expect(t212NextPath("/api/v0/equity/history/orders?cursor=1", "dividends")).toBeNull();
    expect(t212NextPath("/api/v0/equity/history/orders?cursor=1/../../x", "orders")).toBeNull();
    expect(t212NextPath(null, "orders")).toBeNull();
  });
});

describe("IBKR Flex — helpers", () => {
  it("reads attributes and decodes entities", () => {
    const [p] = flexElements('<OpenPosition symbol="A&amp;B" description="x &quot;y&quot;" />', "OpenPosition");
    expect(p).toEqual({ symbol: "A&B", description: 'x "y"' });
  });

  it("parses Flex dates and date-times as UTC", () => {
    expect(flexDate("20260115")).toEqual(day("2026-01-15"));
    expect(flexDate("2026-01-15")).toEqual(day("2026-01-15"));
    expect(flexDate("junk")).toBeNull();
    expect(flexDateTime("20260115;143000")).toEqual(new Date("2026-01-15T14:30:00Z"));
  });

  it("reads a request's reference code or its error", () => {
    expect(flexReference("<FlexStatementResponse><Status>Success</Status><ReferenceCode>1234567890</ReferenceCode></FlexStatementResponse>").ref).toBe("1234567890");
    expect(flexReference("<FlexStatementResponse><ErrorCode>1018</ErrorCode><ErrorMessage>Too many requests</ErrorMessage></FlexStatementResponse>")).toEqual({
      ref: null,
      code: "1018",
      message: "Too many requests",
    });
  });
});

describe("IBKR Flex — Activity report", () => {
  const snap = parseFlexStatement(FLEX);

  it("reads the base currency, cash, as-of day and total", () => {
    expect(snap.baseCurrency).toBe("USD");
    expect(snap.cash).toBe(1000);
    expect(snap.asOf).toEqual(day("2026-06-30"));
    expect(snap.totalValue).toBe(4200); // 1000 cash + 2000 + 1000 × 1.2
    expect(snap.notes).toEqual([]);
  });

  it("maps stock positions in base currency and skips cash positions", () => {
    expect(snap.positions).toEqual([
      { symbol: "DEMO", name: "DEMO CORP & CO", quantity: 10, avgCost: 150, currency: "USD", price: 200, value: 2000, unrealisedPnl: 500 },
      { symbol: "EUFUND", name: "EURO FUND ETF", quantity: 25, avgCost: 36, currency: "EUR", price: 40, value: 1200, unrealisedPnl: 120 },
    ]);
  });

  it("maps stock executions only (no options, no order-level rows)", () => {
    expect(snap.trades).toEqual([
      { externalId: "ibkr:1001", symbol: "DEMO", side: "BUY", quantity: 12, price: 150, fees: 1, currency: "USD", executedAt: new Date("2026-01-15T14:30:00Z") },
      { externalId: "ibkr:1002", symbol: "DEMO", side: "SELL", quantity: 2, price: 180, fees: 1, currency: "USD", executedAt: new Date("2026-03-10T10:05:00Z") },
    ]);
  });

  it("maps deposits and withdrawals, not interest or summary rows", () => {
    expect(snap.flows.map((f) => [f.externalId, f.kind, f.amount, f.currency])).toEqual([
      ["ibkr:2001", "DEPOSIT", 5000, "USD"],
      ["ibkr:2002", "WITHDRAWAL", 500, "USD"],
    ]);
  });

  it("nets withholding tax into the dividend and keeps payments in lieu", () => {
    expect(snap.dividends).toEqual([
      { externalId: "ibkrdiv:2003", symbol: "DEMO", paidOn: day("2026-04-15"), quantity: null, amount: 4.25, withholdingTax: 0.75, currency: "USD" },
      { externalId: "ibkrdiv:2005", symbol: "EUFUND", paidOn: day("2026-05-20"), quantity: null, amount: 10, withholdingTax: null, currency: "EUR" },
    ]);
  });

  it("keeps the daily value history and adds the report day", () => {
    expect(snap.values).toEqual([
      { date: day("2026-06-28"), value: 4900, cash: 900 },
      { date: day("2026-06-29"), value: 4950, cash: 950 },
      { date: day("2026-06-30"), value: 4200, cash: 1000 },
    ]);
  });

  it("refuses a body without a statement and notes a missing base currency", () => {
    expect(() => parseFlexStatement("<FlexQueryResponse></FlexQueryResponse>")).toThrow(/no statement/);
    const s = parseFlexStatement('<FlexStatement accountId="U1" toDate="20260101" />');
    expect(s.baseCurrency).toBe("EUR");
    expect(s.notes[0]).toMatch(/base currency assumed EUR/);
  });
});
