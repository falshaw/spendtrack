/**
 * "Log now" (POST /api/recurring/[id]/post): the posted row must carry the rule's
 * account (scope + import dedup both key on it), an ended or inactive rule must
 * refuse, a second click must not post twice, and nextDate must roll by month
 * index with the day clamped.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => ({
  recurringRule: { findFirst: vi.fn(), update: vi.fn() },
  transaction: { findFirst: vi.fn(), create: vi.fn() },
  $transaction: vi.fn(),
}));
const auth = vi.hoisted(() => ({ requireUserId: vi.fn() }));

vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/auth", () => auth);

import { POST } from "@/app/api/recurring/[id]/post/route";

const req = () => new NextRequest("http://localhost/api/recurring/r1/post", { method: "POST" });
const ctx = { params: Promise.resolve({ id: "r1" }) };

const rule = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  userId: "u1",
  type: "INCOME",
  amount: 14760,
  currency: "EUR",
  merchant: "Example Ltd contract",
  categoryId: "seed-cat-salary",
  accountId: "acc-biz",
  cadence: "MONTHLY",
  nextDate: new Date("2026-10-31T00:00:00Z"),
  endDate: new Date("2026-12-31T00:00:00Z"),
  active: true,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireUserId.mockResolvedValue("u1");
  db.transaction.findFirst.mockResolvedValue(null);
  db.transaction.create.mockImplementation((args) => args);
  db.recurringRule.update.mockImplementation((args) => args);
  db.$transaction.mockResolvedValue([]);
});

describe("POST /api/recurring/[id]/post", () => {
  it("carries the rule's accountId onto the transaction", async () => {
    db.recurringRule.findFirst.mockResolvedValue(rule());
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    const created = db.transaction.create.mock.calls[0][0].data;
    expect(created.accountId).toBe("acc-biz");
    expect(created.recurringId).toBe("r1");
  });

  it("rolls 31 Oct to 30 Nov, not 1 Dec", async () => {
    db.recurringRule.findFirst.mockResolvedValue(rule());
    const res = await POST(req(), ctx);
    expect((await res.json()).nextDate.slice(0, 10)).toBe("2026-11-30");
  });

  it("rolls 31 Jan to 28 Feb instead of skipping February", async () => {
    db.recurringRule.findFirst.mockResolvedValue(
      rule({ nextDate: new Date("2026-01-31T00:00:00Z"), endDate: null }),
    );
    const res = await POST(req(), ctx);
    expect((await res.json()).nextDate.slice(0, 10)).toBe("2026-02-28");
  });

  it("refuses a rule that has ended", async () => {
    db.recurringRule.findFirst.mockResolvedValue(
      rule({ nextDate: new Date("2026-08-31T00:00:00Z"), endDate: new Date("2026-07-31T00:00:00Z") }),
    );
    const res = await POST(req(), ctx);
    expect(res.status).toBe(409);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("still posts on the end date itself", async () => {
    db.recurringRule.findFirst.mockResolvedValue(
      rule({ nextDate: new Date("2026-12-31T00:00:00Z") }),
    );
    expect((await POST(req(), ctx)).status).toBe(200);
  });

  it("refuses an inactive rule", async () => {
    db.recurringRule.findFirst.mockResolvedValue(rule({ active: false }));
    expect((await POST(req(), ctx)).status).toBe(409);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("refuses a second post for the same occurrence", async () => {
    db.recurringRule.findFirst.mockResolvedValue(rule());
    db.transaction.findFirst.mockResolvedValue({ id: "t-existing" });
    expect((await POST(req(), ctx)).status).toBe(409);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("404s a rule owned by someone else", async () => {
    db.recurringRule.findFirst.mockResolvedValue(null);
    expect((await POST(req(), ctx)).status).toBe(404);
  });
});
