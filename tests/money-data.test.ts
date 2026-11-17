/**
 * The money server loaders with Prisma mocked: what /balances lists and how the
 * dashboard's "safe to draw" tile is fed from `account_balances`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  account: { findMany: vi.fn() },
  accountBalance: { findMany: vi.fn() },
  recurringRule: { findMany: vi.fn() },
  transaction: { findMany: vi.fn() },
  reserveStep: { findMany: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/fx", () => ({ ensureFxRates: vi.fn(async () => {}) }));
vi.mock("@/lib/finance", () => ({ getDashboard: vi.fn(async () => ({ spent: 1000 })) }));

import { getBalanceRows, getReceiptRows, getSafeToDraw } from "../src/lib/money-data";

const d = (iso: string) => new Date(iso + "T00:00:00Z");
const ACCOUNTS = [
  { id: "acc-a", name: "Business current", institution: "Example Bank", type: "BANK", biz: "BUSINESS", currency: "EUR", earmark: null },
  { id: "acc-c", name: "Card A", institution: "Example Card", type: "CARD", biz: "PERSONAL", currency: "EUR", earmark: null },
  { id: "acc-v", name: "Business savings", institution: "Example Bank", type: "BANK", biz: "BUSINESS", currency: "EUR", earmark: "VAT reserve" },
];

beforeEach(() => {
  vi.clearAllMocks();
  db.account.findMany.mockResolvedValue(ACCOUNTS);
  db.recurringRule.findMany.mockResolvedValue([]);
  db.transaction.findMany.mockResolvedValue([]);
  db.reserveStep.findMany.mockResolvedValue([
    { payDate: d("2026-09-30"), label: "Invoice Aug", invoicesGross: "10000", reserveAfter: "4000" },
    { payDate: d("2026-10-31"), label: "Invoice Sep", invoicesGross: "15000", reserveAfter: "9000" },
  ]);
});

describe("getBalanceRows — what /balances lists", () => {
  it("every non-archived account, investment ones included (their balance is their value)", async () => {
    db.accountBalance.findMany.mockResolvedValue([]);
    await getBalanceRows("u1");
    expect(db.account.findMany.mock.calls[0][0].where).toEqual({ userId: "u1", isArchived: false });
  });

  it("the newest balance per account, with its source, origin and how many are stored; none = all null", async () => {
    db.accountBalance.findMany.mockResolvedValue([
      // ordered newest first, as the query asks
      { id: "b2", accountId: "acc-a", asOf: d("2026-09-30"), balance: "75.25", currency: "EUR", source: "sep.md", origin: "STATEMENT" },
      { id: "b3", accountId: "acc-c", asOf: d("2026-09-20"), balance: "-2400.00", currency: "EUR", source: "manual", origin: "MANUAL" },
      { id: "b1", accountId: "acc-a", asOf: d("2026-08-31"), balance: "450.75", currency: "EUR", source: "aug.md", origin: "STATEMENT" },
    ]);
    const rows = await getBalanceRows("u1");
    expect(rows.map((r) => r.name)).toEqual(["Business current", "Card A", "Business savings"]);
    expect(rows[0]).toMatchObject({ balanceId: "b2", balance: 75.25, asOf: "2026-09-30", source: "sep.md", origin: "STATEMENT", eur: 75.25, stored: 2 });
    expect(rows[1]).toMatchObject({ balance: -2400.00, origin: "MANUAL", stored: 1 });
    expect(rows[2]).toMatchObject({ earmark: "VAT reserve", balanceId: null, balance: null, asOf: null, source: null, origin: null, eur: null, stored: 0 });
  });
});

describe("getSafeToDraw — the tile reads balances, earmarks and the reserve plan", () => {
  const now = new Date("2026-10-01T09:00:00Z");

  it("a missing drawable balance → no number, the account named; a held-back account never blocks", async () => {
    db.accountBalance.findMany.mockResolvedValue([
      { accountId: "acc-a", asOf: d("2026-09-30"), balance: "60000", currency: "EUR" },
    ]);
    const r = await getSafeToDraw("u1", now);
    expect(r.safe).toBeNull();
    expect(r.cashMissing).toEqual(["Card A"]);
    expect(r.held).toEqual([{ name: "Business savings", amount: null, label: "VAT reserve" }]);
  });

  it("one number: held-back savings out of cash, reserve due per invoices received, rows after the as-of rolled forward", async () => {
    db.accountBalance.findMany.mockResolvedValue([
      { accountId: "acc-a", asOf: d("2026-09-30"), balance: "60000", currency: "EUR" },
      { accountId: "acc-c", asOf: d("2026-09-20"), balance: "-500", currency: "EUR" },
      { accountId: "acc-v", asOf: d("2026-09-30"), balance: "24000", currency: "EUR" },
    ]);
    // 1st transaction query: business invoice income; 2nd: the rows after each balance.
    db.transaction.findMany
      .mockResolvedValueOnce([{ accountId: "acc-a", amount: "10000", currency: "EUR", date: d("2026-09-30") }])
      .mockResolvedValueOnce([
        { accountId: "acc-c", amount: "100", currency: "EUR", type: "EXPENSE", date: d("2026-09-25") }, // after → counts
        { accountId: "acc-c", amount: "999", currency: "EUR", type: "EXPENSE", date: d("2026-09-10") }, // before → in the balance
        { accountId: "acc-a", amount: "50", currency: "EUR", type: "INCOME", date: d("2026-10-01") },
      ]);
    const r = await getSafeToDraw("u1", now);
    expect(r.cashLines.map((c) => c.amount)).toEqual([60050, -600, 24000]);
    expect(r.cashDrawable).toBe(59450);
    expect(r.held).toEqual([{ name: "Business savings", amount: 24000, label: "VAT reserve" }]);
    expect(r.invoicesReceived).toBe(10000);
    expect(r.reserve).toBe(4000);
    expect(r.reserveNext?.label).toBe("Invoice Sep");
    expect(r.taxSetAside).toBe(0);
    // 4,000 reserve + 1,000 budget left (2,000 default − 1,000 spent)
    expect(r.floor).toBe(5000);
    expect(r.safe).toBe(54450);
  });
});

describe("getReceiptRows — business costs that need a receipt", () => {
  it("asks for BUSINESS-account EXPENSE rows outside excluded categories", async () => {
    db.transaction.findMany.mockResolvedValue([]);
    await getReceiptRows("u1", d("2026-01-01"));
    const w = db.transaction.findMany.mock.calls[0][0].where;
    expect(w).toMatchObject({
      userId: "u1",
      type: "EXPENSE",
      date: { gte: d("2026-01-01") },
      account: { biz: "BUSINESS" },
      NOT: { category: { excludeFromTotals: true } },
    });
  });

  it("an attachment covers a row; a receipt reference wins over it", async () => {
    db.transaction.findMany.mockResolvedValue([
      { id: "t1", date: d("2026-09-10"), merchant: "Example Airlines", amount: "214.50", currency: "EUR", accountId: "acc-a", receiptRef: null,
        account: { name: "Business current" }, category: { name: "Business travel" }, _count: { attachments: 1 } },
      { id: "t2", date: d("2026-09-12"), merchant: "Online course", amount: "20.00", currency: "EUR", accountId: "acc-a", receiptRef: null,
        account: { name: "Business current" }, category: null, _count: { attachments: 0 } },
      { id: "t3", date: d("2026-09-13"), merchant: "Hotel", amount: "300", currency: "EUR", accountId: "acc-a", receiptRef: "receipts/2026-09/hotel.pdf",
        account: { name: "Business current" }, category: null, _count: { attachments: 2 } },
    ]);
    const r = await getReceiptRows("u1");
    const by = Object.fromEntries(r.rows.map((x) => [x.id, x]));
    expect(by.t1).toMatchObject({ receipt: "1 attachment", attachments: 1, reason: "Business account" });
    expect(by.t2).toMatchObject({ receipt: null });
    expect(by.t3).toMatchObject({ receipt: "receipts/2026-09/hotel.pdf", receiptRef: "receipts/2026-09/hotel.pdf" });
    expect(r.totals).toMatchObject({ missing: 1, covered: 2 });
  });
});
