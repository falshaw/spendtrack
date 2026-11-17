/**
 * F4 — /api/recurring/suggestions{,/confirm,/dismiss}, Prisma mocked.
 *   - unauthenticated → 401;
 *   - money-movement categories are excluded from detection;
 *   - confirm re-detects server-side, creates the rule from the detected values and
 *     ONLY sets recurringId on the group's unlinked rows (scoped to the user);
 *   - an unknown / stale key → 404; dismiss upserts on (user, key).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => {
  const model = () => ({
    create: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn(),
  });
  const m = {
    transaction: model(),
    recurringRule: model(),
    recurringDismissal: model(),
    category: model(),
    $transaction: vi.fn(),
  };
  m.$transaction.mockImplementation(async (fn: (tx: typeof m) => unknown) => fn(m));
  return m;
});
const auth = vi.hoisted(() => ({ requireUserId: vi.fn(), getSession: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/auth", () => ({ requireUserId: auth.requireUserId, getSession: auth.getSession }));

import * as list from "@/app/api/recurring/suggestions/route";
import * as confirm from "@/app/api/recurring/suggestions/confirm/route";
import * as dismiss from "@/app/api/recurring/suggestions/dismiss/route";

const post = (body: unknown) =>
  new NextRequest("http://x/api/recurring/suggestions/confirm", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

// Three monthly Netflix charges ending last month, relative to the real clock.
const now = new Date();
const monthsAgo = (k: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k, 5));
const ROWS = [3, 2, 1].map((k, i) => ({
  id: `t${i + 1}`,
  accountId: "acc-rev",
  merchant: "NETFLIX.COM AMSTERDAM",
  displayMerchant: null,
  type: "EXPENSE",
  amount: "12.99",
  currency: "EUR",
  date: monthsAgo(k),
  categoryId: "c-subs",
  recurringId: null,
}));
const KEY = "acc-rev|EXPENSE|EUR|netflix com amsterdam";

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireUserId.mockResolvedValue("u1");
  db.transaction.findMany.mockResolvedValue(ROWS);
  db.recurringRule.findMany.mockResolvedValue([]);
  db.recurringDismissal.findMany.mockResolvedValue([]);
  db.category.findFirst.mockResolvedValue({ id: "c-subs" });
  db.recurringRule.create.mockResolvedValue({ id: "rule-new" });
  db.transaction.updateMany.mockResolvedValue({ count: 3 });
  db.recurringDismissal.upsert.mockResolvedValue({});
});

describe("GET /api/recurring/suggestions", () => {
  it("401 without a session", async () => {
    auth.requireUserId.mockResolvedValueOnce(null);
    expect((await list.GET()).status).toBe(401);
  });
  it("detects over the user's non-excluded rows", async () => {
    const res = await list.GET();
    const { suggestions } = await res.json();
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ key: KEY, cadence: "MONTHLY", amount: 12.99, count: 3 });
    const where = db.transaction.findMany.mock.calls[0][0].where;
    expect(where.userId).toBe("u1");
    expect(where.NOT).toEqual({ category: { excludeFromTotals: true } });
  });
});

describe("POST /api/recurring/suggestions/confirm", () => {
  it("creates the rule from the detected values and links only recurringId", async () => {
    const res = await confirm.POST(post({ key: KEY, merchant: "Netflix" }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "rule-new", linked: 3 });
    const data = db.recurringRule.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ userId: "u1", merchant: "Netflix", amount: 12.99, currency: "EUR", type: "EXPENSE", cadence: "MONTHLY", accountId: "acc-rev", categoryId: "c-subs", active: true });
    expect(data.nextDate.getTime()).toBeGreaterThan(Date.now() - 86_400_000);
    const upd = db.transaction.updateMany.mock.calls[0][0];
    expect(upd.where).toEqual({ userId: "u1", id: { in: ["t1", "t2", "t3"] }, recurringId: null });
    expect(upd.data).toEqual({ recurringId: "rule-new" });
  });
  it("404 for a key that is not (or no longer) suggested; 400 for a foreign category", async () => {
    expect((await confirm.POST(post({ key: "acc-x|EXPENSE|EUR|nothing" }))).status).toBe(404);
    db.category.findFirst.mockResolvedValueOnce(null);
    expect((await confirm.POST(post({ key: KEY, categoryId: "c-theirs" }))).status).toBe(400);
    expect(db.recurringRule.create).not.toHaveBeenCalled();
  });
  it("a dismissed key is not confirmable", async () => {
    db.recurringDismissal.findMany.mockResolvedValue([{ key: KEY }]);
    expect((await confirm.POST(post({ key: KEY }))).status).toBe(404);
  });
});

describe("POST /api/recurring/suggestions/dismiss", () => {
  it("upserts on (user, key) and validates the body", async () => {
    const res = await dismiss.POST(post({ key: KEY }));
    expect(res.status).toBe(200);
    expect(db.recurringDismissal.upsert).toHaveBeenCalledWith({
      where: { userId_key: { userId: "u1", key: KEY } },
      create: { userId: "u1", key: KEY },
      update: {},
    });
    expect((await dismiss.POST(post({}))).status).toBe(400);
  });
});
