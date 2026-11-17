/**
 * Net worth — loader + routes, Prisma mocked:
 *   - investments = the latest balance of each INVESTMENT account; none → null, never 0;
 *   - the loader reads balances/items up to the cut-off, converts to EUR, and counts
 *     business invoice income since the plan date toward the reserve;
 *   - the snapshot upserts on (user, month) with trading null kept null;
 *   - routes: 401, future month refused, items scoped { id, userId }, CSV headers.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => {
  const model = () => ({
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    upsert: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  });
  return {
    account: model(),
    accountBalance: model(),
    netWorthItem: model(),
    netWorthSnapshot: model(),
    reserveStep: model(),
    transaction: model(),
    // Investments: no broker connection unless a test adds one.
    brokerConnection: model(),
    portfolioValue: model(),
  };
});
const auth = vi.hoisted(() => ({ requireUserId: vi.fn(), getSession: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/auth", () => ({ requireUserId: auth.requireUserId, getSession: auth.getSession }));
vi.mock("@/lib/fx", () => ({ ensureFxRates: vi.fn(async () => undefined) }));

import { computeNetWorthFor, ensureLastCompleteSnapshot, snapshotMonth } from "@/lib/net-worth-data";
import * as snapRoute from "@/app/api/net-worth/snapshot/route";
import * as exportRoute from "@/app/api/net-worth/export/route";
import * as items from "@/app/api/net-worth/items/route";
import * as itemId from "@/app/api/net-worth/items/[id]/route";

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const NOW = d("2026-10-19");
const req = (body: unknown, method = "POST") =>
  new NextRequest("http://x/api/net-worth", { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const p = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireUserId.mockResolvedValue("u1");
  db.account.findMany.mockResolvedValue([
    { id: "rev", name: "Bank A", type: "BANK", isArchived: false },
    { id: "amex", name: "Card A", type: "CARD", isArchived: false },
    { id: "old", name: "Old", type: "BANK", isArchived: true },
  ]);
  db.accountBalance.findMany.mockResolvedValue([
    { accountId: "rev", asOf: d("2026-09-30"), balance: "1000.00", currency: "EUR" },
    { accountId: "amex", asOf: d("2026-09-20"), balance: "-200.00", currency: "EUR" },
  ]);
  db.netWorthItem.findMany.mockResolvedValue([{ id: "car", kind: "CAR", name: "Car", amount: "20000.00", currency: "EUR", asOf: d("2026-09-01") }]);
  db.reserveStep.findMany.mockResolvedValue([
    { payDate: d("2026-10-01"), label: "Step 1", invoicesGross: "10000.00", reserveAfter: "3000.00" },
    { payDate: d("2026-11-01"), label: "Step 2", invoicesGross: "10000.00", reserveAfter: "8000.00" },
  ]);
  db.transaction.findMany.mockResolvedValue([{ amount: "10000.00", currency: "EUR", date: d("2026-09-28") }]);
  db.netWorthSnapshot.upsert.mockResolvedValue({});
  db.netWorthSnapshot.findMany.mockResolvedValue([]);
  db.brokerConnection.findMany.mockResolvedValue([]);
  db.portfolioValue.findMany.mockResolvedValue([]);
});

describe("investments", () => {
  it("is null — never 0 — when there is no investment account", async () => {
    const r = await computeNetWorthFor("u1", "2026-09-01", NOW);
    expect(r.trading).toBeNull();
    expect(r.estimated).toBe(true);
  });

  it("is the latest balance of each investment account up to the cut-off, kept out of cash", async () => {
    db.account.findMany.mockResolvedValue([
      { id: "rev", name: "Bank A", type: "BANK", isArchived: false },
      { id: "broker", name: "Broker", type: "INVESTMENT", isArchived: false },
    ]);
    db.accountBalance.findMany.mockResolvedValue([
      { accountId: "rev", asOf: d("2026-09-30"), balance: "1000.00", currency: "EUR" },
      { accountId: "broker", asOf: d("2026-09-10"), balance: "4000.00", currency: "EUR" },
      { accountId: "broker", asOf: d("2026-09-28"), balance: "4500.00", currency: "EUR" },
    ]);
    const r = await computeNetWorthFor("u1", "2026-09-01", NOW);
    expect(r.trading).toBe(4500);
    expect(r.cash).toBe(1000);
    expect(r.net).toBe(1000 + 4500 + 20000);
  });
});

describe("computeNetWorthFor", () => {
  it("reads up to the month end, keeps archived accounts only with a balance, counts the reserve", async () => {
    const r = await computeNetWorthFor("u1", "2026-09-01", NOW);
    expect(db.accountBalance.findMany.mock.calls[0][0].where).toEqual({ userId: "u1", asOf: { lte: d("2026-09-30") } });
    expect(r.detail.lines.map((l) => l.accountId)).toEqual(["rev", "amex"]);
    expect(r.cash).toBe(1000);
    expect(r.cards).toBe(200);
    expect(r.assets).toBe(20000);
    expect(r.trading).toBeNull();
    expect(r.net).toBe(20800);
    expect(r.reserve).toBe(3000); // 10k received ≥ 95 % of step 1
    const txWhere = db.transaction.findMany.mock.calls[0][0].where;
    expect(txWhere).toMatchObject({ userId: "u1", type: "INCOME", account: { biz: "BUSINESS" } });
    expect(txWhere.date).toEqual({ gte: d("2000-01-01"), lte: d("2026-09-30") });
  });
  it("the running month is cut off at today", async () => {
    await computeNetWorthFor("u1", "2026-10-19", NOW);
    expect(db.accountBalance.findMany.mock.calls[0][0].where).toEqual({ userId: "u1", asOf: { lte: d("2026-10-19") } });
  });
  it("no reserve schedule → reserve null", async () => {
    db.reserveStep.findMany.mockResolvedValue([]);
    expect((await computeNetWorthFor("u1", "2026-09-01", NOW)).reserve).toBeNull();
  });
});

describe("snapshots", () => {
  it("upserts on (user, month), trading null kept null", async () => {
    await snapshotMonth("u1", "2026-09-01", NOW);
    const call = db.netWorthSnapshot.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ userId_month: { userId: "u1", month: d("2026-09-01") } });
    expect(call.create).toMatchObject({ userId: "u1", trading: null, net: 20800, estimated: true });
    expect(call.update.trading).toBeNull();
  });
  it("ensureLastCompleteSnapshot only writes when the month is missing", async () => {
    db.netWorthSnapshot.findUnique.mockResolvedValueOnce({ id: "s" });
    expect(await ensureLastCompleteSnapshot("u1", NOW)).toBe(false);
    expect(db.netWorthSnapshot.upsert).not.toHaveBeenCalled();
    db.netWorthSnapshot.findUnique.mockResolvedValueOnce(null);
    expect(await ensureLastCompleteSnapshot("u1", NOW)).toBe(true);
    expect(db.netWorthSnapshot.upsert.mock.calls[0][0].where.userId_month.month).toEqual(d("2026-09-01"));
  });
});

describe("routes", () => {
  it("snapshot: 401, bad month 400, future month 400", async () => {
    auth.requireUserId.mockResolvedValueOnce(null);
    expect((await snapRoute.POST(req({}))).status).toBe(401);
    expect((await snapRoute.POST(req({ month: "2026-13" }))).status).toBe(400);
    expect((await snapRoute.POST(req({ month: "2999-01" }))).status).toBe(400);
    expect(db.netWorthSnapshot.upsert).not.toHaveBeenCalled();
  });
  it("export: CSV attachment with a BOM", async () => {
    db.netWorthSnapshot.findMany.mockResolvedValue([
      { month: d("2026-09-01"), cash: "1.00", cards: "0.00", trading: null, assets: "0.00", liabilities: "0.00", reserve: null, net: "1.00", estimated: true, updatedAt: NOW },
    ]);
    const res = await exportRoute.GET();
    expect(res.headers.get("content-type")).toMatch(/text\/csv/);
    expect(res.headers.get("content-disposition")).toMatch(/attachment/);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM, so Excel reads UTF-8
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("2026-09,1,0,,0,0,1,,,yes");
  });
  it("items: create validates, writes are scoped { id, userId }", async () => {
    db.netWorthItem.create.mockResolvedValue({ id: "i1" });
    expect((await items.POST(req({ kind: "LIABILITY", name: "Loan", amount: 5000, asOf: "2026-10-01" }))).status).toBe(201);
    expect(db.netWorthItem.create.mock.calls[0][0].data).toMatchObject({ userId: "u1", kind: "LIABILITY", amount: 5000, currency: "EUR" });
    expect((await items.POST(req({ kind: "ASSET", name: "x", amount: -1, asOf: "2026-10-01" }))).status).toBe(400);
    db.netWorthItem.updateMany.mockResolvedValue({ count: 1 });
    expect((await itemId.PATCH(req({ amount: 19000 }, "PATCH"), p("i1"))).status).toBe(200);
    expect(db.netWorthItem.updateMany.mock.calls[0][0]).toEqual({ where: { id: "i1", userId: "u1" }, data: { amount: 19000 } });
    db.netWorthItem.deleteMany.mockResolvedValue({ count: 0 });
    expect((await itemId.DELETE(req(null, "DELETE"), p("i1"))).status).toBe(404);
    expect(db.netWorthItem.deleteMany).toHaveBeenCalledWith({ where: { id: "i1", userId: "u1" } });
  });
});
