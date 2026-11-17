/**
 * Contract tests for the CRUD API handlers.
 *
 * These exist mainly to hold three invariants that a refactor can quietly break
 * and that nothing else in the app would notice:
 *
 *   1. every handler refuses an unauthenticated caller,
 *   2. every handler scopes its lookup by `userId` — otherwise one account's id
 *      reaches another's row (there is one user today; that is not a reason to
 *      let the query be wrong),
 *   3. a foreign-key body field (categoryId, accountId) is
 *      checked against the caller's own rows before it is written.
 *
 * Prisma is mocked: these test the handler's decisions, not the database.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => {
  const model = () => ({
    create: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    count: vi.fn(),
  });
  return {
    transaction: model(),
    account: model(),
    category: model(),
    recurringRule: model(),
    merchantRule: model(),
    txnRule: model(),
    ruleApplyLog: model(),
    transactionSplit: model(),
    user: model(),
    session: model(),
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  };
});

const auth = vi.hoisted(() => ({
  requireUserId: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/auth", () => ({
  requireUserId: auth.requireUserId,
  getSession: auth.getSession,
}));

import * as txns from "@/app/api/transactions/route";
import * as txnById from "@/app/api/transactions/[id]/route";
import * as accounts from "@/app/api/accounts/route";
import * as accountById from "@/app/api/accounts/[id]/route";
import * as categories from "@/app/api/categories/route";
import * as categoryById from "@/app/api/categories/[id]/route";
import * as recurring from "@/app/api/recurring/route";
import * as recurringById from "@/app/api/recurring/[id]/route";
import * as health from "@/app/api/health/route";

const USER = "user-1";

function post(url: string, body: unknown) {
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
function patch(url: string, body: unknown) {
  return new NextRequest(`http://localhost${url}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
function get(url: string) {
  return new NextRequest(`http://localhost${url}`);
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireUserId.mockResolvedValue(USER);
  auth.getSession.mockResolvedValue({ userId: USER, email: "user@example.com" });
  for (const key of Object.keys(db) as (keyof typeof db)[]) {
    const m = db[key];
    if (typeof m === "object" && m !== null) {
      const model = m as Record<string, ReturnType<typeof vi.fn>>;
      model.create?.mockResolvedValue({ id: "new-id" });
      model.findFirst?.mockResolvedValue({ id: "row-1" });
      model.findMany?.mockResolvedValue([]);
      model.findUnique?.mockResolvedValue(null);
      model.update?.mockResolvedValue({ id: "row-1" });
      model.updateMany?.mockResolvedValue({ count: 1 });
      model.delete?.mockResolvedValue({ id: "row-1" });
      model.deleteMany?.mockResolvedValue({ count: 1 });
      model.count?.mockResolvedValue(0);
    }
  }
  db.$queryRaw.mockResolvedValue([{ "?column?": 1 }]);
});

// Accounts and categories run a duplicate-NAME check through the same
// `findFirst` the ownership lookup uses, so the blanket "a row exists" default
// reads as a name clash. These prime the sequence the handler actually makes.
const noDupe = (m: { findFirst: ReturnType<typeof vi.fn> }) => () =>
  m.findFirst.mockResolvedValue(null);
const ownedNoDupe = (m: { findFirst: ReturnType<typeof vi.fn> }) => () =>
  m.findFirst.mockResolvedValueOnce({ id: "row-1" }).mockResolvedValueOnce(null);

// Every authenticated handler, paired with a request that would otherwise work.
const AUTHED: [string, () => Promise<Response>, (() => void)?][] = [
  ["POST /transactions", () => txns.POST(post("/api/transactions", { amount: 1, date: "2026-08-30", merchant: "m" }))],
  ["PATCH /transactions/[id]", () => txnById.PATCH(patch("/api/transactions/1", { merchant: "m" }), ctx("1"))],
  ["DELETE /transactions/[id]", () => txnById.DELETE(get("/api/transactions/1"), ctx("1"))],
  ["POST /accounts", () => accounts.POST(post("/api/accounts", { name: "Revolut" })), noDupe(db.account)],
  ["PATCH /accounts/[id]", () => accountById.PATCH(patch("/api/accounts/1", { name: "R" }), ctx("1")), ownedNoDupe(db.account)],
  ["DELETE /accounts/[id]", () => accountById.DELETE(get("/api/accounts/1"), ctx("1"))],
  ["POST /categories", () => categories.POST(post("/api/categories", { name: "Food" })), noDupe(db.category)],
  ["PATCH /categories/[id]", () => categoryById.PATCH(patch("/api/categories/1", { name: "F" }), ctx("1")), ownedNoDupe(db.category)],
  ["DELETE /categories/[id]", () => categoryById.DELETE(get("/api/categories/1"), ctx("1"))],
  ["POST /recurring", () => recurring.POST(post("/api/recurring", { merchant: "Rent", amount: 1, nextDate: "2026-09-01" }))],
  ["PATCH /recurring/[id]", () => recurringById.PATCH(patch("/api/recurring/1", { merchant: "R" }), ctx("1"))],
  ["DELETE /recurring/[id]", () => recurringById.DELETE(get("/api/recurring/1"), ctx("1"))],
];

describe("authentication", () => {
  it.each(AUTHED)("%s returns 401 with no session", async (_name, call) => {
    auth.requireUserId.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(401);
  });

  it.each(AUTHED)("%s succeeds when authenticated", async (_name, call, setup) => {
    setup?.();
    const res = await call();
    expect(res.status).toBeLessThan(400);
  });
});

describe("duplicate names", () => {
  it("409s a second account with the same name", async () => {
    db.account.findFirst.mockResolvedValue({ id: "existing" });
    const res = await accounts.POST(post("/api/accounts", { name: "Revolut" }));
    expect(res.status).toBe(409);
    expect(db.account.create).not.toHaveBeenCalled();
  });

  it("409s a second category with the same name", async () => {
    db.category.findFirst.mockResolvedValue({ id: "existing" });
    const res = await categories.POST(post("/api/categories", { name: "Food" }));
    expect(res.status).toBe(409);
    expect(db.category.create).not.toHaveBeenCalled();
  });
});

describe("ownership scoping", () => {
  it("scopes an account update by userId, not id alone", async () => {
    db.account.findFirst.mockResolvedValueOnce({ id: "a1" }).mockResolvedValueOnce(null);
    await accountById.PATCH(patch("/api/accounts/a1", { name: "Savings" }), ctx("a1"));
    expect(db.account.findFirst.mock.calls[0][0]).toMatchObject({ where: { id: "a1", userId: USER } });
  });

  it("404s a transaction that belongs to somebody else", async () => {
    db.transaction.findFirst.mockResolvedValue(null);
    const res = await txnById.PATCH(patch("/api/transactions/x1", { merchant: "x" }), ctx("x1"));
    expect(res.status).toBe(404);
    expect(db.transaction.updateMany).not.toHaveBeenCalled();
  });

  it("scopes a transaction delete by userId", async () => {
    await txnById.DELETE(get("/api/transactions/x1"), ctx("x1"));
    expect(db.transaction.deleteMany).toHaveBeenCalledWith({
      where: { id: "x1", userId: USER },
    });
  });

  it("404s a delete that matched nothing", async () => {
    db.transaction.deleteMany.mockResolvedValue({ count: 0 });
    const res = await txnById.DELETE(get("/api/transactions/x1"), ctx("x1"));
    expect(res.status).toBe(404);
  });
});

describe("foreign keys are checked against the caller's own rows", () => {
  it("rejects moving a charge to an account the user does not own", async () => {
    db.transaction.findFirst.mockResolvedValue({ id: "x1", merchant: "Hotel" });
    db.account.findFirst.mockResolvedValue(null);
    const res = await txnById.PATCH(
      patch("/api/transactions/x1", { accountId: "not-mine" }),
      ctx("x1"),
    );
    expect(res.status).toBe(400);
    expect(db.transaction.updateMany).not.toHaveBeenCalled();
  });

  it("rejects an unknown category on a transaction", async () => {
    db.transaction.findFirst.mockResolvedValue({ id: "x1", merchant: "Hotel" });
    db.category.findFirst.mockResolvedValue(null);
    const res = await txnById.PATCH(
      patch("/api/transactions/x1", { categoryId: "nope" }),
      ctx("x1"),
    );
    expect(res.status).toBe(400);
  });
});

describe("validation", () => {
  it("rejects a transaction with no merchant", async () => {
    const res = await txns.POST(post("/api/transactions", { amount: 1, date: "2026-08-30" }));
    expect(res.status).toBe(400);
  });

  it("rejects a non-numeric or out-of-range amount", async () => {
    expect((await txns.POST(post("/api/transactions", { amount: "12", date: "2026-08-30", merchant: "m" }))).status).toBe(400);
    expect((await txns.POST(post("/api/transactions", { amount: 1e11, date: "2026-08-30", merchant: "m" }))).status).toBe(400);
  });

  it("rejects a malformed JSON body", async () => {
    const req = new NextRequest("http://localhost/api/transactions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect((await txns.POST(req)).status).toBe(400);
  });

  it("stores an accrual date for a charge that belongs to another month", async () => {
    db.transaction.findFirst.mockResolvedValue({ id: "x1", merchant: "Airline", amount: 100, categoryId: null });
    const res = await txnById.PATCH(patch("/api/transactions/x1", { accrualDate: "2026-10-01" }), ctx("x1"));
    expect(res.status).toBe(200);
    const data = db.transaction.updateMany.mock.calls[0][0].data;
    expect(data.accrualDate).toEqual(new Date("2026-10-01"));
    expect(data.date).toBeUndefined();
  });
});

describe("health", () => {
  it("is ok while the database answers", async () => {
    const res = await health.GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      status: "ok",
      database: "up",
    });
  });

  it("is 503 degraded when the database does not — a check that cannot fail is not a check", async () => {
    db.$queryRaw.mockRejectedValue(new Error("connection refused"));
    const res = await health.GET();
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      status: "degraded",
      database: "down",
    });
  });

  it("never leaks why the database is down", async () => {
    db.$queryRaw.mockRejectedValue(new Error("password authentication failed for user"));
    const body = JSON.stringify(await (await health.GET()).json());
    expect(body).not.toContain("password");
  });
});
