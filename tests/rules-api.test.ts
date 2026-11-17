/**
 * F2 — the /api/rules handlers and the apply planner, Prisma mocked. Holds:
 *   1. every handler refuses an unauthenticated caller;
 *   2. every write is scoped { id, userId };
 *   3. preview writes nothing; apply writes ONLY category / display name / note /
 *      tags (the reconciliation guarantee) and logs the batch; undo restores `before`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { planRuleApply, type ApplyRow } from "@/lib/rule-apply";
import type { TxnRuleLite } from "@/lib/rule-engine";

const db = vi.hoisted(() => {
  const model = () => ({
    create: vi.fn(),
    createMany: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  });
  return {
    txnRule: model(),
    transaction: model(),
    category: model(),
    account: model(),
    ruleApplyLog: model(),
    $transaction: vi.fn(async (ops: unknown[]) => ops),
  };
});
const auth = vi.hoisted(() => ({ requireUserId: vi.fn(), getSession: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/auth", () => ({ requireUserId: auth.requireUserId, getSession: auth.getSession }));

import * as rules from "@/app/api/rules/route";
import * as ruleId from "@/app/api/rules/[id]/route";
import * as reorder from "@/app/api/rules/reorder/route";
import * as preview from "@/app/api/rules/[id]/preview/route";
import * as apply from "@/app/api/rules/[id]/apply/route";
import * as undo from "@/app/api/rules/undo/[batch]/route";

const json = (url: string, body: unknown, method = "POST") =>
  new NextRequest(`http://x${url}`, { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const p = (id: string) => ({ params: Promise.resolve({ id }) });

const RULE = {
  id: "r1", tier: "USER", priority: 0, active: true, stopProcessing: true, matchText: null,
  conditions: { payee: { op: "contains", value: "spotify" } },
  actions: { categoryId: "cat-subs", displayMerchant: "Spotify", tags: ["sub"] },
};
const ROWS = [
  { id: "t1", merchant: "Spotify STOCKHOLM", amount: "5.62", type: "EXPENSE", accountId: "acc-a", currency: "EUR", categoryId: null, displayMerchant: null, note: null, tags: [] },
  { id: "t2", merchant: "Netflix", amount: "12.99", type: "EXPENSE", accountId: "acc-a", currency: "EUR", categoryId: "cat-x", displayMerchant: null, note: null, tags: [] },
];

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireUserId.mockResolvedValue("u1");
  db.category.findFirst.mockResolvedValue({ id: "cat-subs" });
  db.category.findMany.mockResolvedValue([{ id: "cat-subs", name: "Subscriptions" }, { id: "cat-x", name: "X" }]);
  db.txnRule.findFirst.mockResolvedValue(RULE);
  db.txnRule.findMany.mockResolvedValue([]);
  db.transaction.findMany.mockResolvedValue(ROWS);
  db.transaction.updateMany.mockResolvedValue({ count: 1 });
  db.txnRule.updateMany.mockResolvedValue({ count: 1 });
  db.txnRule.deleteMany.mockResolvedValue({ count: 1 });
  db.txnRule.create.mockResolvedValue({ id: "r-new" });
});

describe("auth", () => {
  it("every handler answers 401 without a session", async () => {
    auth.requireUserId.mockResolvedValue(null);
    const res = await Promise.all([
      rules.GET(new NextRequest("http://x/api/rules")),
      rules.POST(json("/api/rules", {})),
      ruleId.PATCH(json("/api/rules/r1", {}, "PATCH"), p("r1")),
      ruleId.DELETE(new NextRequest("http://x/api/rules/r1", { method: "DELETE" }), p("r1")),
      reorder.POST(json("/api/rules/reorder", { ids: ["r1"] })),
      preview.POST(json("/api/rules/r1/preview", { from: "2026-01-01", to: "2026-12-31" }), p("r1")),
      apply.POST(json("/api/rules/r1/apply", { from: "2026-01-01", to: "2026-12-31" }), p("r1")),
      undo.POST(new NextRequest("http://x/api/rules/undo/b1", { method: "POST" }), { params: Promise.resolve({ batch: "b1" }) }),
    ]);
    expect(res.map((r) => r.status)).toEqual([401, 401, 401, 401, 401, 401, 401, 401]);
  });
});

describe("POST /api/rules", () => {
  it("creates a USER rule at the end of the order, checking the category is the caller's", async () => {
    db.txnRule.findFirst.mockResolvedValue({ priority: 4 });
    const res = await rules.POST(json("/api/rules", { name: "Spotify", conditions: RULE.conditions, actions: RULE.actions }));
    expect(res.status).toBe(201);
    expect(db.category.findFirst.mock.calls[0][0].where).toEqual({ id: "cat-subs", userId: "u1" });
    expect(db.txnRule.create.mock.calls[0][0].data).toMatchObject({ userId: "u1", tier: "USER", priority: 5, name: "Spotify" });
  });
  it("refuses a rule with no condition, no action, a bad regex, or a foreign category", async () => {
    expect((await rules.POST(json("/api/rules", { conditions: {}, actions: RULE.actions }))).status).toBe(400);
    expect((await rules.POST(json("/api/rules", { conditions: RULE.conditions, actions: {} }))).status).toBe(400);
    expect((await rules.POST(json("/api/rules", { conditions: { payee: { op: "regex", value: "(" } }, actions: RULE.actions }))).status).toBe(400);
    db.category.findFirst.mockResolvedValue(null);
    expect((await rules.POST(json("/api/rules", { conditions: RULE.conditions, actions: RULE.actions }))).status).toBe(400);
    expect(db.txnRule.create).not.toHaveBeenCalled();
  });
});

describe("PATCH / DELETE /api/rules/[id]", () => {
  it("scopes the write by userId and refuses a malformed id", async () => {
    expect((await ruleId.PATCH(json("/api/rules/x", { active: false }, "PATCH"), p("not valid!"))).status).toBe(400);
    const res = await ruleId.PATCH(json("/api/rules/r1", { active: false }, "PATCH"), p("r1"));
    expect(res.status).toBe(200);
    expect(db.txnRule.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: "r1", userId: "u1" }, data: { active: false } });
    await ruleId.DELETE(new NextRequest("http://x/api/rules/r1", { method: "DELETE" }), p("r1"));
    expect(db.txnRule.deleteMany.mock.calls[0][0]).toEqual({ where: { id: "r1", userId: "u1" } });
  });
  it("a LEARNED rule's conditions cannot be edited", async () => {
    db.txnRule.findFirst.mockResolvedValue({ id: "l1", tier: "LEARNED" });
    const res = await ruleId.PATCH(json("/api/rules/l1", { conditions: RULE.conditions }, "PATCH"), p("l1"));
    expect(res.status).toBe(400);
    expect(db.txnRule.updateMany).not.toHaveBeenCalled();
  });
});

describe("POST /api/rules/reorder", () => {
  it("requires exactly the caller's USER rule ids and writes priority = position", async () => {
    db.txnRule.findMany.mockResolvedValue([{ id: "a" }, { id: "b" }]);
    expect((await reorder.POST(json("/api/rules/reorder", { ids: ["a"] }))).status).toBe(400);
    expect((await reorder.POST(json("/api/rules/reorder", { ids: ["a", "zzz"] }))).status).toBe(400);
    const res = await reorder.POST(json("/api/rules/reorder", { ids: ["b", "a"] }));
    expect(res.status).toBe(200);
    expect(db.txnRule.updateMany.mock.calls.map((c) => c[0])).toEqual([
      { where: { id: "b", userId: "u1" }, data: { priority: 0 } },
      { where: { id: "a", userId: "u1" }, data: { priority: 1 } },
    ]);
  });
});

describe("planRuleApply", () => {
  const rows: ApplyRow[] = ROWS.map((r) => ({ ...r, amount: Number(r.amount), type: r.type as "EXPENSE" }));
  it("lists only matching rows whose labels would change, and only the four label fields", () => {
    const changes = planRuleApply(rows, RULE as TxnRuleLite);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({
      id: "t1",
      before: { categoryId: null, displayMerchant: null, note: null, tags: [] },
      after: { categoryId: "cat-subs", displayMerchant: "Spotify", note: null, tags: ["sub"] },
    });
    expect(Object.keys(changes[0].after).sort()).toEqual(["categoryId", "displayMerchant", "note", "tags"]);
  });
  it("a row that already carries the rule's values is not a change; tags merge without duplicates", () => {
    const done = { ...rows[0], categoryId: "cat-subs", displayMerchant: "Spotify", tags: ["sub"] };
    expect(planRuleApply([done], RULE as TxnRuleLite)).toEqual([]);
    const partly = { ...done, tags: ["other"] };
    expect(planRuleApply([partly], RULE as TxnRuleLite)[0].after.tags).toEqual(["other", "sub"]);
  });
});

describe("preview / apply / undo", () => {
  it("preview returns the diff with category names and writes nothing", async () => {
    const res = await preview.POST(json("/api/rules/r1/preview", { from: "2026-01-01", to: "2026-12-31" }), p("r1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scanned).toBe(2);
    expect(body.changes).toHaveLength(1);
    expect(body.changes[0]).toMatchObject({ id: "t1", merchant: "Spotify STOCKHOLM", after: { categoryName: "Subscriptions", displayMerchant: "Spotify" } });
    expect(db.transaction.updateMany).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.transaction.findMany.mock.calls[0][0].where).toEqual({ userId: "u1", date: { gte: new Date("2026-01-01"), lte: new Date("2026-12-31") } });
  });
  it("preview rejects a window with from after to", async () => {
    expect((await preview.POST(json("/api/rules/r1/preview", { from: "2026-12-31", to: "2026-01-01" }), p("r1"))).status).toBe(400);
  });
  it("apply writes only the label fields, scoped by userId, in one transaction, and logs the batch", async () => {
    const res = await apply.POST(json("/api/rules/r1/apply", { from: "2026-01-01", to: "2026-12-31" }), p("r1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.changed).toBe(1);
    expect(typeof body.batch).toBe("string");
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    const upd = db.transaction.updateMany.mock.calls[0][0];
    expect(upd.where).toEqual({ id: "t1", userId: "u1" });
    expect(Object.keys(upd.data).sort()).toEqual(["categoryId", "displayMerchant", "note", "tags"]);
    for (const k of ["date", "amount", "type", "currency", "accountId", "merchant"]) expect(upd.data).not.toHaveProperty(k);
    const log = db.ruleApplyLog.createMany.mock.calls[0][0].data[0];
    expect(log).toMatchObject({ userId: "u1", ruleId: "r1", batch: body.batch, transactionId: "t1", before: { categoryId: null }, after: { categoryId: "cat-subs" } });
  });
  it("apply with nothing to change writes nothing", async () => {
    db.transaction.findMany.mockResolvedValue([ROWS[1]]);
    const res = await apply.POST(json("/api/rules/r1/apply", { from: "2026-01-01", to: "2026-12-31" }), p("r1"));
    expect((await res.json()).changed).toBe(0);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it("undo restores every logged `before` of the batch (scoped) and marks the batch undone; a second undo is 404", async () => {
    db.ruleApplyLog.findMany.mockResolvedValue([{ id: "l1", transactionId: "t1", before: { categoryId: null, displayMerchant: null, note: "n", tags: ["x"] } }]);
    const res = await undo.POST(new NextRequest("http://x/api/rules/undo/b1", { method: "POST" }), { params: Promise.resolve({ batch: "b1" }) });
    expect(res.status).toBe(200);
    expect(db.ruleApplyLog.findMany.mock.calls[0][0].where).toEqual({ userId: "u1", batch: "b1", undoneAt: null });
    expect(db.transaction.updateMany.mock.calls[0][0]).toEqual({
      where: { id: "t1", userId: "u1" },
      data: { categoryId: null, displayMerchant: null, note: "n", tags: ["x"] },
    });
    expect(db.ruleApplyLog.updateMany.mock.calls[0][0].where).toEqual({ userId: "u1", batch: "b1", undoneAt: null });
    db.ruleApplyLog.findMany.mockResolvedValue([]);
    expect((await undo.POST(new NextRequest("http://x/api/rules/undo/b1", { method: "POST" }), { params: Promise.resolve({ batch: "b1" }) })).status).toBe(404);
  });
});
