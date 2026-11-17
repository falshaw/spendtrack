/**
 * F3 — PUT/GET /api/transactions/[id]/splits and the PATCH guard, Prisma mocked.
 *   1. unauthenticated → 401; another user's row → 404;
 *   2. parts must sum to the row amount to the cent (400 otherwise), unknown category → 400;
 *   3. the write only replaces parts and moves the parent's categoryId to the largest part —
 *      never amount/date/type/currency/account/merchant (the reconciliation keys);
 *   4. [] unsplits and keeps the parent's category;
 *   5. PATCH refuses to change the amount or category of a split row (409).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => {
  const model = () => ({
    count: vi.fn(),
    create: vi.fn(),
    createMany: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  });
  return {
    transaction: model(),
    transactionSplit: model(),
    category: model(),
    account: model(),
    trip: model(),
    vehicle: model(),
    $transaction: vi.fn(async (ops: unknown[]) => ops),
  };
});
const auth = vi.hoisted(() => ({ requireUserId: vi.fn(), getSession: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/auth", () => ({ requireUserId: auth.requireUserId, getSession: auth.getSession }));
vi.mock("@/lib/rules", () => ({ learnMerchantRule: vi.fn(async () => undefined) }));

import * as splits from "@/app/api/transactions/[id]/splits/route";
import * as txnId from "@/app/api/transactions/[id]/route";

const json = (body: unknown, method = "PUT") =>
  new NextRequest("http://x/api/transactions/t1/splits", {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
const p = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireUserId.mockResolvedValue("u1");
  db.transaction.findFirst.mockResolvedValue({ id: "t1", amount: "100.00", categoryId: "c-old", merchant: "Freshmart" });
  db.category.findMany.mockImplementation(async (args: { where: { id: { in: string[] } } }) =>
    args.where.id.in.filter((id) => id.startsWith("c-")).map((id) => ({ id })),
  );
  db.transactionSplit.findMany.mockResolvedValue([]);
  db.transactionSplit.count.mockResolvedValue(0);
  db.transaction.updateMany.mockResolvedValue({ count: 1 });
});

describe("PUT /api/transactions/[id]/splits", () => {
  it("401 without a session, 404 for a row that is not the caller's, 400 for a bad id", async () => {
    auth.requireUserId.mockResolvedValueOnce(null);
    expect((await splits.PUT(json({ parts: [] }), p("t1"))).status).toBe(401);
    db.transaction.findFirst.mockResolvedValueOnce(null);
    expect((await splits.PUT(json({ parts: [] }), p("t1"))).status).toBe(404);
    expect(db.transaction.findFirst.mock.calls[0][0].where).toEqual({ id: "t1", userId: "u1" });
    expect((await splits.PUT(json({ parts: [] }), p("bad id!"))).status).toBe(400);
  });

  it("rejects parts that do not sum to the amount to the cent, and a foreign category", async () => {
    const off = await splits.PUT(json({ parts: [{ amount: 60, categoryId: "c-a" }, { amount: 39.99, categoryId: "c-b" }] }), p("t1"));
    expect(off.status).toBe(400);
    expect((await off.json()).error).toMatch(/sum/i);
    const foreign = await splits.PUT(json({ parts: [{ amount: 60, categoryId: "c-a" }, { amount: 40, categoryId: "x-theirs" }] }), p("t1"));
    expect(foreign.status).toBe(400);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("replaces the parts and moves ONLY the parent's category to the largest part", async () => {
    const res = await splits.PUT(
      json({ parts: [{ amount: 30, categoryId: "c-a", note: " milk " }, { amount: 70, categoryId: "c-b" }] }),
      p("t1"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, parts: 2, categoryId: "c-b" });
    expect(db.transactionSplit.deleteMany).toHaveBeenCalledWith({ where: { transactionId: "t1", userId: "u1" } });
    const created = db.transactionSplit.createMany.mock.calls[0][0].data;
    expect(created).toEqual([
      { userId: "u1", transactionId: "t1", amount: 30, categoryId: "c-a", note: "milk", sortOrder: 0 },
      { userId: "u1", transactionId: "t1", amount: 70, categoryId: "c-b", note: null, sortOrder: 1 },
    ]);
    const upd = db.transaction.updateMany.mock.calls[0][0];
    expect(upd.where).toEqual({ id: "t1", userId: "u1" });
    expect(Object.keys(upd.data)).toEqual(["categoryId"]);
  });

  it("an empty list unsplits and keeps the parent's category", async () => {
    const res = await splits.PUT(json({ parts: [] }), p("t1"));
    expect(await res.json()).toEqual({ ok: true, parts: 0, categoryId: "c-old" });
    expect(db.transactionSplit.createMany).not.toHaveBeenCalled();
  });

  it("GET returns the parts as numbers", async () => {
    db.transactionSplit.findMany.mockResolvedValueOnce([{ id: "s1", amount: "40.00", categoryId: "c-a", note: null, sortOrder: 0 }]);
    const res = await splits.GET(new NextRequest("http://x/api/transactions/t1/splits"), p("t1"));
    expect(await res.json()).toEqual({ amount: 100, parts: [{ id: "s1", amount: 40, categoryId: "c-a", note: null, sortOrder: 0 }] });
  });
});

describe("PATCH /api/transactions/[id] on a split row", () => {
  const patch = (body: unknown) => json(body, "PATCH");
  it("409 when the amount or category of a split row would change", async () => {
    db.transactionSplit.count.mockResolvedValue(2);
    expect((await txnId.PATCH(patch({ amount: 101 }), p("t1"))).status).toBe(409);
    expect((await txnId.PATCH(patch({ categoryId: "c-new" }), p("t1"))).status).toBe(409);
    expect(db.transaction.updateMany).not.toHaveBeenCalled();
  });
  it("lets the same amount and other fields through", async () => {
    db.transactionSplit.count.mockResolvedValue(2);
    const res = await txnId.PATCH(patch({ amount: 100, note: "x" }), p("t1"));
    expect(res.status).toBe(200);
    expect(db.transactionSplit.count).not.toHaveBeenCalled();
  });
});
