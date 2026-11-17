/**
 * Account balances (/balances, the safe-to-draw tile): staleness,
 * newest-per-account, and the two API routes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  ageDays,
  balanceState,
  latestByAccount,
  STALE_DAYS,
} from "../src/lib/balances";

const db = vi.hoisted(() => ({
  account: { findFirst: vi.fn(), updateMany: vi.fn() },
  accountBalance: { upsert: vi.fn(), deleteMany: vi.fn() },
}));
const auth = vi.hoisted(() => ({ getSession: vi.fn(), requireUserId: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/auth", () => auth);

import { POST } from "@/app/api/account-balances/route";
import { DELETE } from "@/app/api/account-balances/[id]/route";
import { PATCH as PATCH_ACCOUNT } from "@/app/api/accounts/[id]/route";
import { AccountUpdateSchema } from "../src/lib/validators";

describe("staleness — the 35-day rule", () => {
  it("is 35 days", () => expect(STALE_DAYS).toBe(35));

  it("counts whole days across a month end", () => {
    expect(ageDays("2026-09-30", "2026-10-01")).toBe(1);
    expect(ageDays("2026-02-19", "2026-10-01")).toBe(224);
  });

  it("35 days old is still fresh, 36 is stale", () => {
    expect(balanceState("2026-08-27", "2026-10-01")).toBe("fresh"); // 35
    expect(balanceState("2026-08-26", "2026-10-01")).toBe("stale"); // 36
  });

  it("no balance is missing, never stale or fresh", () => {
    expect(balanceState(null, "2026-10-01")).toBe("missing");
  });
});

describe("latestByAccount", () => {
  it("keeps the newest as-of per account, whatever the input order", () => {
    const m = latestByAccount([
      { accountId: "a", asOf: "2026-08-31", v: 1 },
      { accountId: "b", asOf: "2026-09-07", v: 2 },
      { accountId: "a", asOf: "2026-09-30", v: 3 },
      { accountId: "a", asOf: "2026-07-31", v: 4 },
    ]);
    expect(m.get("a")?.v).toBe(3);
    expect(m.get("b")?.v).toBe(2);
    expect(m.size).toBe(2);
  });
});

const req = (body: unknown) =>
  new NextRequest("http://localhost/api/account-balances", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("POST /api/account-balances — a typed balance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    auth.requireUserId.mockResolvedValue("u1");
    db.account.findFirst.mockResolvedValue({ id: "acc-biz" });
    db.accountBalance.upsert.mockResolvedValue({ id: "b1" });
  });

  it("refuses an unauthenticated caller", async () => {
    auth.requireUserId.mockResolvedValue(null);
    const res = await POST(req({ accountId: "acc-biz", asOf: "2026-09-30", balance: 75.25 }));
    expect(res.status).toBe(401);
    expect(db.accountBalance.upsert).not.toHaveBeenCalled();
  });

  it("upserts on account + date and always records MANUAL / 'manual'", async () => {
    const res = await POST(req({ accountId: "acc-biz", asOf: "2026-09-30", balance: 75.25, source: "statement.pdf" }));
    expect(res.status).toBe(201);
    expect(db.account.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "acc-biz", userId: "u1" } }));
    const call = db.accountBalance.upsert.mock.calls[0][0];
    expect(call.where.accountId_asOf.accountId).toBe("acc-biz");
    expect(call.where.accountId_asOf.asOf.toISOString()).toBe("2026-09-30T00:00:00.000Z");
    expect(call.create).toMatchObject({ userId: "u1", balance: "75.25", currency: "EUR", source: "manual", origin: "MANUAL" });
    expect(call.update).toMatchObject({ balance: "75.25", source: "manual", origin: "MANUAL" });
  });

  it("accepts a negative card balance", async () => {
    const res = await POST(req({ accountId: "acc-card-a", asOf: "2026-09-20", balance: -2400.00 }));
    expect(res.status).toBe(201);
    expect(db.accountBalance.upsert.mock.calls[0][0].create.balance).toBe("-2400.00");
  });

  it("404s an account that is not the caller's", async () => {
    db.account.findFirst.mockResolvedValue(null);
    const res = await POST(req({ accountId: "acc-other", asOf: "2026-09-30", balance: 1 }));
    expect(res.status).toBe(404);
    expect(db.accountBalance.upsert).not.toHaveBeenCalled();
  });

  it("rejects a bad date, a non-number and an unknown currency", async () => {
    for (const bad of [
      { accountId: "a", asOf: "30.09.2026", balance: 1 },
      { accountId: "a", asOf: "2026-09-30", balance: "1" },
      { accountId: "a", asOf: "2026-09-30", balance: 1, currency: "XYZ" },
    ]) {
      expect((await POST(req(bad))).status).toBe(400);
    }
    expect(db.accountBalance.upsert).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/account-balances/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.requireUserId.mockResolvedValue("u1");
  });

  it("scopes the delete by userId AND id", async () => {
    db.accountBalance.deleteMany.mockResolvedValue({ count: 1 });
    const res = await DELETE(new Request("http://localhost"), ctx("b1"));
    expect(res.status).toBe(200);
    expect(db.accountBalance.deleteMany).toHaveBeenCalledWith({ where: { id: "b1", userId: "u1" } });
  });

  it("404s someone else's row", async () => {
    db.accountBalance.deleteMany.mockResolvedValue({ count: 0 });
    expect((await DELETE(new Request("http://localhost"), ctx("b2"))).status).toBe(404);
  });

  it("refuses an unauthenticated caller", async () => {
    auth.requireUserId.mockResolvedValue(null);
    expect((await DELETE(new Request("http://localhost"), ctx("b1"))).status).toBe(401);
    expect(db.accountBalance.deleteMany).not.toHaveBeenCalled();
  });
});

describe("earmark — an account held back from safe to draw", () => {
  it("the schema trims it, turns blank into null and caps the length", () => {
    expect(AccountUpdateSchema.parse({ earmark: "  VAT reserve " }).earmark).toBe("VAT reserve");
    expect(AccountUpdateSchema.parse({ earmark: "" }).earmark).toBeNull();
    expect(AccountUpdateSchema.parse({ earmark: null }).earmark).toBeNull();
    expect(AccountUpdateSchema.parse({}).earmark).toBeUndefined();
    expect(AccountUpdateSchema.safeParse({ earmark: "x".repeat(61) }).success).toBe(false);
  });

  it("PATCH /api/accounts/[id] writes it, scoped by userId AND id", async () => {
    vi.clearAllMocks();
    auth.requireUserId.mockResolvedValue("u1");
    db.account.findFirst.mockResolvedValue({ id: "acc-biz-savings", name: "Business savings" });
    db.account.updateMany.mockResolvedValue({ count: 1 });
    const res = await PATCH_ACCOUNT(
      new NextRequest("http://localhost/api/accounts/acc-biz-savings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ earmark: "VAT reserve" }),
      }),
      ctx("acc-biz-savings"),
    );
    expect(res.status).toBeLessThan(300);
    expect(db.account.updateMany).toHaveBeenCalledWith({ where: { id: "acc-biz-savings", userId: "u1" }, data: { earmark: "VAT reserve" } });
  });
});
