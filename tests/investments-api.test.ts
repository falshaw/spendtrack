/**
 * Investments — sync, loaders and routes, Prisma and fetch mocked:
 *   - Trading 212: Basic auth from key + secret, a bare legacy key, demo base URL, a
 *     history list rate limited part-way keeps what it read and says so;
 *   - IBKR Flex: polls past "still generating", reports a throttle as rate limited;
 *   - syncBrokers: an unconfigured broker is skipped, one failure never fails the other;
 *   - the sync route: 401, multi-user guard, nothing configured, per-user rate limit;
 *   - net worth reads the broker value; dividend income drops imported duplicates.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => {
  const model = () => ({
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    createMany: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
    count: vi.fn(),
  });
  const m = {
    user: model(),
    account: model(),
    accountBalance: model(),
    netWorthItem: model(),
    reserveStep: model(),
    transaction: model(),
    brokerConnection: model(),
    investmentHolding: model(),
    investmentTrade: model(),
    investmentDividend: model(),
    investmentCashFlow: model(),
    portfolioValue: model(),
    $transaction: vi.fn(),
  };
  m.$transaction.mockImplementation(async (fn: unknown) => (typeof fn === "function" ? fn(m) : Promise.all(fn as Promise<unknown>[])));
  return m;
});
const auth = vi.hoisted(() => ({ requireUserId: vi.fn(), getSession: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/auth", () => ({ requireUserId: auth.requireUserId, getSession: auth.getSession }));
vi.mock("@/lib/fx", () => ({ ensureFxRates: vi.fn(async () => undefined) }));

import { fetchIbkrFlex, fetchT212, syncBrokers, t212Auth, t212Base } from "@/lib/broker-sync";
import { getDividendIncome } from "@/lib/investments-data";
import { computeNetWorthFor } from "@/lib/net-worth-data";
import * as syncRoute from "@/app/api/investments/sync/route";
import type { BrokerSnapshot } from "@/lib/broker-map";

const FLEX = readFileSync(path.join(import.meta.dirname, "fixtures", "ibkr-flex-activity.xml"), "utf-8");
const d = (s: string) => new Date(`${s}T00:00:00Z`);
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const post = (body: unknown) =>
  new NextRequest("http://x/api/investments/sync", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const T212_ENV = { TRADING212_API_KEY: "demo-key", TRADING212_API_SECRET: "demo-secret" } as unknown as NodeJS.ProcessEnv;

const emptySnap = (over: Partial<BrokerSnapshot> = {}): BrokerSnapshot => ({
  baseCurrency: "EUR",
  cash: 10,
  totalValue: 110,
  asOf: d("2026-06-30"),
  positions: [{ symbol: "DEMO", name: null, quantity: 1, avgCost: 90, currency: "EUR", price: 100, value: 100, unrealisedPnl: 10 }],
  trades: [],
  dividends: [],
  flows: [],
  values: [{ date: d("2026-06-30"), value: 110, cash: 10 }],
  notes: [],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  auth.requireUserId.mockResolvedValue("u1");
  db.brokerConnection.upsert.mockResolvedValue({ id: "c1" });
  db.brokerConnection.update.mockResolvedValue({});
  db.brokerConnection.findMany.mockResolvedValue([]);
  db.investmentHolding.count.mockResolvedValue(0);
  db.portfolioValue.findMany.mockResolvedValue([]);
  db.user.count.mockResolvedValue(1);
});

describe("Trading 212 fetch", () => {
  it("uses Basic auth for key + secret, the bare key for a legacy key, and the demo host on request", () => {
    expect(t212Auth(T212_ENV)).toBe("Basic " + Buffer.from("demo-key:demo-secret").toString("base64"));
    expect(t212Auth({ TRADING212_API_KEY: "legacy" } as unknown as NodeJS.ProcessEnv)).toBe("legacy");
    expect(() => t212Auth({} as unknown as NodeJS.ProcessEnv)).toThrow(/not configured/);
    expect(t212Base({ TRADING212_ENV: "demo" } as unknown as NodeJS.ProcessEnv)).toBe("https://demo.trading212.com/api/v0");
    expect(t212Base({} as unknown as NodeJS.ProcessEnv)).toBe("https://live.trading212.com/api/v0");
  });

  it("issues GETs only, follows pages, and keeps what it read when a list is rate limited", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, init });
      if (u.endsWith("/equity/account/summary")) return json({ currency: "EUR", totalValue: 110, cash: { availableToTrade: 10 } });
      if (u.endsWith("/equity/positions")) return json([{ instrument: { ticker: "DEMO_US_EQ", currency: "USD" }, quantity: 1, averagePricePaid: 90, walletImpact: { currentValue: 100 } }]);
      if (u.includes("/history/orders")) return json({ items: [], nextPagePath: null });
      if (u.includes("/history/dividends?limit=50&cursor=2")) return json({}, 429, { "x-ratelimit-reset": "1780000000" });
      if (u.includes("/history/dividends")) {
        return json({ items: [{ reference: "r1", ticker: "DEMO_US_EQ", amount: 1, paidOn: "2026-05-01T00:00:00Z" }], nextPagePath: "/api/v0/equity/history/dividends?limit=50&cursor=2" });
      }
      if (u.includes("/history/transactions")) return json({ items: [{ type: "DEPOSIT", amount: 100, reference: "f1", dateTime: "2026-01-01T00:00:00Z" }], nextPagePath: null });
      return json({}, 404);
    });
    const snap = await fetchT212(T212_ENV, fetchImpl as unknown as typeof fetch);
    expect(snap.positions).toHaveLength(1);
    expect(snap.dividends).toHaveLength(1);
    expect(snap.flows).toHaveLength(1);
    expect(snap.notes.join(" ")).toMatch(/dividends: Trading 212 rate limit reached.*kept 1/);
    expect(calls.every((c) => !c.init?.method || c.init.method === "GET")).toBe(true);
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
  });

  it("fails the sync on a rejected key", async () => {
    const fetchImpl = vi.fn(async () => json({}, 401));
    await expect(fetchT212(T212_ENV, fetchImpl as unknown as typeof fetch)).rejects.toThrow(/rejected the API key/);
  });
});

describe("IBKR Flex fetch", () => {
  const ENV = { IBKR_FLEX_TOKEN: "tok", IBKR_FLEX_QUERY_ID: "123" } as unknown as NodeJS.ProcessEnv;
  const noSleep = async () => undefined;

  it("requests the report, waits while it is generated, then parses it", async () => {
    let polls = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/SendRequest")) return new Response("<FlexStatementResponse><Status>Success</Status><ReferenceCode>555</ReferenceCode></FlexStatementResponse>");
      polls++;
      if (polls === 1) return new Response("<FlexStatementResponse><ErrorCode>1019</ErrorCode><ErrorMessage>Statement generation in progress</ErrorMessage></FlexStatementResponse>");
      return new Response(FLEX);
    });
    const snap = await fetchIbkrFlex(ENV, fetchImpl as unknown as typeof fetch, noSleep);
    expect(polls).toBe(2);
    expect(snap.baseCurrency).toBe("USD");
    expect(String(fetchImpl.mock.calls[1][0])).toContain("q=555");
  });

  it("reports a Flex throttle as rate limited", async () => {
    const fetchImpl = vi.fn(async () => new Response("<FlexStatementResponse><ErrorCode>1018</ErrorCode><ErrorMessage>Too many requests</ErrorMessage></FlexStatementResponse>"));
    await expect(fetchIbkrFlex(ENV, fetchImpl as unknown as typeof fetch, noSleep)).rejects.toMatchObject({ rateLimited: true });
  });
});

describe("syncBrokers", () => {
  it("skips an unconfigured broker and stores the configured one", async () => {
    const r = await syncBrokers("u1", undefined, { env: T212_ENV, fetchT212: async () => emptySnap() });
    expect(r.find((x) => x.broker === "IBKR")?.status).toBe("SKIPPED");
    expect(r.find((x) => x.broker === "TRADING212")).toMatchObject({ ok: true, status: "OK", positions: 1, totalValue: 110 });
    expect(db.investmentHolding.createMany).toHaveBeenCalledTimes(1);
    expect(db.portfolioValue.upsert).toHaveBeenCalledTimes(1);
    expect(db.brokerConnection.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "OK", totalValue: 110 }) }));
  });

  it("keeps stored holdings when a report has no positions, and marks it partial", async () => {
    db.investmentHolding.count.mockResolvedValue(3);
    const r = await syncBrokers("u1", "TRADING212", { env: T212_ENV, fetchT212: async () => emptySnap({ positions: [] }) });
    expect(r[0].status).toBe("PARTIAL");
    expect(db.investmentHolding.deleteMany).not.toHaveBeenCalled();
  });

  it("never lets one broker's failure fail the other", async () => {
    const env = { ...T212_ENV, IBKR_FLEX_TOKEN: "t", IBKR_FLEX_QUERY_ID: "q" } as unknown as NodeJS.ProcessEnv;
    const r = await syncBrokers("u1", undefined, {
      env,
      fetchT212: async () => emptySnap(),
      fetchIbkr: async () => {
        throw new Error("IBKR Flex HTTP 500");
      },
    });
    expect(r.map((x) => [x.broker, x.status])).toEqual([
      ["TRADING212", "OK"],
      ["IBKR", "ERROR"],
    ]);
    expect(db.brokerConnection.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "ERROR", lastSyncMessage: "IBKR Flex HTTP 500" }) }));
  });
});

describe("POST /api/investments/sync", () => {
  it("401 without a session", async () => {
    auth.requireUserId.mockResolvedValue(null);
    expect((await syncRoute.POST(post({}))).status).toBe(401);
  });

  it("400 with a hint when no broker is configured", async () => {
    vi.stubEnv("TRADING212_API_KEY", "");
    vi.stubEnv("IBKR_FLEX_TOKEN", "");
    auth.requireUserId.mockResolvedValue("u-none");
    const res = await syncRoute.POST(post({}));
    expect(res.status).toBe(400);
    expect((await res.json()).hint).toMatch(/TRADING212_API_KEY/);
  });

  it("403 on a multi-user install without BROKER_SYNC_USER_EMAIL", async () => {
    vi.stubEnv("TRADING212_API_KEY", "k");
    vi.stubEnv("BROKER_SYNC_USER_EMAIL", "");
    db.user.count.mockResolvedValue(2);
    auth.requireUserId.mockResolvedValue("u-multi");
    const res = await syncRoute.POST(post({}));
    expect(res.status).toBe(403);
  });

  it("400 on an unknown broker", async () => {
    auth.requireUserId.mockResolvedValue("u-bad");
    expect((await syncRoute.POST(post({ broker: "OTHER" }))).status).toBe(400);
  });

  it("rate limits a user to two syncs a minute", async () => {
    vi.stubEnv("TRADING212_API_KEY", "");
    vi.stubEnv("IBKR_FLEX_TOKEN", "");
    auth.requireUserId.mockResolvedValue("u-rl");
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await syncRoute.POST(post({}))).status);
    expect(codes).toEqual([400, 400, 429]);
  });
});

describe("net worth reads the broker value", () => {
  beforeEach(() => {
    db.account.findMany.mockResolvedValue([
      { id: "bank", name: "Bank", type: "BANK", isArchived: false },
      { id: "inv", name: "Broker account", type: "INVESTMENT", isArchived: false },
    ]);
    db.accountBalance.findMany.mockResolvedValue([
      { accountId: "bank", asOf: d("2026-06-30"), balance: "1000.00", currency: "EUR" },
      { accountId: "inv", asOf: d("2026-06-20"), balance: "5000.00", currency: "EUR" },
    ]);
    db.netWorthItem.findMany.mockResolvedValue([]);
    db.reserveStep.findMany.mockResolvedValue([]);
    db.transaction.findMany.mockResolvedValue([]);
  });

  it("adds an unlinked portfolio and replaces a linked account's balance", async () => {
    db.brokerConnection.findMany.mockResolvedValue([
      { id: "c1", label: "Trading 212", accountId: "inv", baseCurrency: "EUR", totalValue: "5200.00", asOf: d("2026-06-29") },
      { id: "c2", label: "Interactive Brokers", accountId: null, baseCurrency: "EUR", totalValue: null, asOf: null },
    ]);
    db.portfolioValue.findMany.mockResolvedValue([
      { connectionId: "c2", date: d("2026-06-28"), value: "2900.00", currency: "EUR" },
      { connectionId: "c2", date: d("2026-06-29"), value: "3000.00", currency: "EUR" },
    ]);
    const r = await computeNetWorthFor("u1", "2026-06-01", d("2026-07-05"));
    expect(r.trading).toBe(8200); // 5200 replaces the 5000 balance, + 3000
    expect(r.net).toBe(9200);
    expect(r.detail.trading.map((p) => p.name)).toEqual(["Broker account (Trading 212)", "Interactive Brokers"]);
  });
});

describe("getDividendIncome", () => {
  it("counts synced dividends in scope, minus those already imported", async () => {
    const conn = (biz: "PERSONAL" | "BUSINESS" | null) => ({ accountId: biz ? "inv" : null, account: biz ? { biz } : null });
    db.investmentDividend.findMany.mockResolvedValue([
      { id: "d1", symbol: "DEMO", paidOn: d("2026-05-15"), amount: "2.50", currency: "EUR", connection: conn(null) },
      { id: "d2", symbol: "DEMO", paidOn: d("2026-06-15"), amount: "3.00", currency: "EUR", connection: conn(null) },
      { id: "d3", symbol: "BIZ", paidOn: d("2026-06-20"), amount: "10.00", currency: "EUR", connection: conn("BUSINESS") },
    ]);
    db.transaction.findMany.mockResolvedValue([{ id: "t1", date: d("2026-05-16"), amount: "2.50", currency: "EUR", merchant: "Dividend DEMO", accountId: "x" }]);
    const personal = await getDividendIncome("u1", d("2026-01-01"), d("2027-01-01"), "personal");
    expect(personal.total).toBe(3);
    expect(personal.matched).toBe(1);
    expect([...personal.monthly.entries()]).toEqual([["2026-06", 3]]);
    const all = await getDividendIncome("u1", d("2026-01-01"), d("2027-01-01"), "all");
    expect(all.total).toBe(13);
  });
});
