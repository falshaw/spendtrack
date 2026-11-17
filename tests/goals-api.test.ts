/**
 * F5 — /api/goals handlers, Prisma + loaders mocked:
 *   - 401 without a session; every write scoped { id, userId };
 *   - source-specific validation (ACCOUNT needs an EARMARKED own account, MANUAL an amount,
 *     ACCOUNT/MANUAL a target > 0, RESERVE may omit it);
 *   - only the field the source reads is stored;
 *   - PATCH re-validates the merged goal.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => {
  const model = () => ({ create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() });
  return { goal: model(), account: model() };
});
const auth = vi.hoisted(() => ({ requireUserId: vi.fn(), getSession: vi.fn() }));
const data = vi.hoisted(() => ({ getGoals: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/auth", () => ({ requireUserId: auth.requireUserId, getSession: auth.getSession }));
vi.mock("@/lib/goals-data", () => ({ getGoals: data.getGoals }));

import * as goals from "@/app/api/goals/route";
import * as goalId from "@/app/api/goals/[id]/route";

const req = (body: unknown, method = "POST") =>
  new NextRequest("http://x/api/goals", { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const p = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireUserId.mockResolvedValue("u1");
  db.goal.create.mockResolvedValue({ id: "g1" });
  db.goal.updateMany.mockResolvedValue({ count: 1 });
  db.goal.deleteMany.mockResolvedValue({ count: 1 });
  db.account.findFirst.mockResolvedValue({ earmark: "VAT reserve" });
  data.getGoals.mockResolvedValue([]);
});

describe("POST /api/goals", () => {
  it("401 without a session", async () => {
    auth.requireUserId.mockResolvedValueOnce(null);
    expect((await goals.POST(req({ name: "x", source: "MANUAL", target: 1, manualAmount: 0 }))).status).toBe(401);
    auth.requireUserId.mockResolvedValueOnce(null);
    expect((await goals.GET()).status).toBe(401);
  });

  it("MANUAL: needs an amount and a target; stores only manualAmount", async () => {
    expect((await goals.POST(req({ name: "Holiday fund", source: "MANUAL", target: 5000 }))).status).toBe(400);
    expect((await goals.POST(req({ name: "Holiday fund", source: "MANUAL", manualAmount: 10 }))).status).toBe(400);
    const res = await goals.POST(req({ name: "Holiday fund", source: "MANUAL", target: 5000, manualAmount: 1200, accountId: "a1", targetDate: "2027-06-01" }));
    expect(res.status).toBe(201);
    const d = db.goal.create.mock.calls[0][0].data;
    expect(d).toMatchObject({ userId: "u1", name: "Holiday fund", source: "MANUAL", target: 5000, manualAmount: 1200, accountId: null });
    expect(d.targetDate).toEqual(new Date("2027-06-01"));
  });

  it("ACCOUNT: the account must be the caller's and earmarked", async () => {
    db.account.findFirst.mockResolvedValueOnce(null);
    expect((await goals.POST(req({ name: "VAT", source: "ACCOUNT", target: 9000, accountId: "a1" }))).status).toBe(400);
    db.account.findFirst.mockResolvedValueOnce({ earmark: null });
    const notHeld = await goals.POST(req({ name: "VAT", source: "ACCOUNT", target: 9000, accountId: "a1" }));
    expect(notHeld.status).toBe(400);
    expect((await notHeld.json()).error).toMatch(/earmark/i);
    const ok = await goals.POST(req({ name: "VAT", source: "ACCOUNT", target: 9000, accountId: "a1", manualAmount: 5 }));
    expect(ok.status).toBe(201);
    expect(db.account.findFirst.mock.calls.at(-1)![0].where).toEqual({ id: "a1", userId: "u1" });
    expect(db.goal.create.mock.calls[0][0].data).toMatchObject({ accountId: "a1", manualAmount: null });
  });

  it("RESERVE: may leave the target out (= the schedule's)", async () => {
    const res = await goals.POST(req({ name: "Reserve", source: "RESERVE" }));
    expect(res.status).toBe(201);
    expect(db.goal.create.mock.calls[0][0].data).toMatchObject({ source: "RESERVE", target: null, accountId: null, manualAmount: null });
  });
});

describe("PATCH / DELETE /api/goals/[id]", () => {
  const existing = {
    id: "g1", userId: "u1", name: "Holiday fund", source: "MANUAL", target: "5000.00", targetDate: null,
    accountId: null, manualAmount: "1200.00", note: null, archived: false, sortOrder: 0,
  };
  it("404 for a goal that is not the caller's; 400 for a bad id", async () => {
    db.goal.findFirst.mockResolvedValueOnce(null);
    expect((await goalId.PATCH(req({ name: "y" }, "PATCH"), p("g1"))).status).toBe(404);
    expect(db.goal.findFirst.mock.calls[0][0].where).toEqual({ id: "g1", userId: "u1" });
    expect((await goalId.PATCH(req({}, "PATCH"), p("bad id"))).status).toBe(400);
  });
  it("re-validates the merged goal: switching to ACCOUNT without an account fails", async () => {
    db.goal.findFirst.mockResolvedValue(existing);
    expect((await goalId.PATCH(req({ source: "ACCOUNT" }, "PATCH"), p("g1"))).status).toBe(400);
    expect(db.goal.updateMany).not.toHaveBeenCalled();
  });
  it("updates scoped by { id, userId } and keeps untouched fields", async () => {
    db.goal.findFirst.mockResolvedValue(existing);
    const res = await goalId.PATCH(req({ manualAmount: 1500 }, "PATCH"), p("g1"));
    expect(res.status).toBe(200);
    const call = db.goal.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: "g1", userId: "u1" });
    expect(call.data).toMatchObject({ name: "Holiday fund", source: "MANUAL", target: 5000, manualAmount: 1500, accountId: null });
  });
  it("DELETE is scoped and 404s on a miss", async () => {
    expect((await goalId.DELETE(req(null, "DELETE"), p("g1"))).status).toBe(200);
    expect(db.goal.deleteMany).toHaveBeenCalledWith({ where: { id: "g1", userId: "u1" } });
    db.goal.deleteMany.mockResolvedValueOnce({ count: 0 });
    expect((await goalId.DELETE(req(null, "DELETE"), p("g1"))).status).toBe(404);
  });
});
