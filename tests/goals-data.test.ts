/**
 * F5 — getGoals: ACCOUNT reads the rolled-forward balance (same as safe to draw),
 * RESERVE the reserve level due now + the schedule's target, a missing balance
 * stays null (never 0), and the loaders are skipped when no goal needs them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ goal: { findMany: vi.fn() } }));
const md = vi.hoisted(() => ({ getForecastAccounts: vi.fn(), getSafeToDraw: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/money-data", () => md);

import { getGoals } from "@/lib/goals-data";

const NOW = new Date(Date.UTC(2026, 9, 19));
const goal = (o: Record<string, unknown>) => ({
  id: "g", userId: "u1", name: "G", source: "MANUAL", target: "1000.00", targetDate: null, accountId: null,
  manualAmount: null, note: null, archived: false, sortOrder: 0, createdAt: new Date(Date.UTC(2026, 8, 1)), account: null, ...o,
});

beforeEach(() => {
  vi.clearAllMocks();
  md.getForecastAccounts.mockResolvedValue([
    { id: "a-vat", name: "Business savings", biz: "BUSINESS", color: "#000", latest: { asOf: "2026-09-30", balance: 4000, currency: "EUR" }, flowSinceEur: 250, lastTxnDate: null },
    { id: "a-none", name: "Cash", biz: "PERSONAL", color: "#000", latest: null, flowSinceEur: 0, lastTxnDate: null },
  ]);
  md.getSafeToDraw.mockResolvedValue({
    reserveMissing: false, reserve: 9000, reserveTarget: 40000,
    reserveNext: { label: "Oct invoice", payDate: "2026-10-30", invoicesGross: 14000, reserveAfter: 19648 },
  });
});

describe("getGoals", () => {
  it("no goals → no loaders run", async () => {
    db.goal.findMany.mockResolvedValue([]);
    expect(await getGoals("u1", NOW)).toEqual([]);
    expect(md.getForecastAccounts).not.toHaveBeenCalled();
    expect(md.getSafeToDraw).not.toHaveBeenCalled();
  });

  it("ACCOUNT = latest balance + imports since; a missing balance is null with a reason", async () => {
    db.goal.findMany.mockResolvedValue([
      goal({ id: "g1", source: "ACCOUNT", accountId: "a-vat", target: "8000.00", account: { id: "a-vat", name: "Business savings", earmark: "VAT reserve" } }),
      goal({ id: "g2", source: "ACCOUNT", accountId: "a-none", account: { id: "a-none", name: "Cash", earmark: "x" } }),
    ]);
    const [a, b] = await getGoals("u1", NOW);
    expect(a.current).toBe(4250);
    expect(a.pct).toBeCloseTo(4250 / 8000, 5);
    expect(a.asOf).toBe("2026-09-30");
    expect(a.earmark).toBe("VAT reserve");
    expect(b.current).toBeNull();
    expect(b.status).toBe("no-data");
    expect(b.missing).toMatch(/No balance/);
    expect(md.getSafeToDraw).not.toHaveBeenCalled();
  });

  it("RESERVE = level due now, target = schedule's final level unless set; next step shown", async () => {
    db.goal.findMany.mockResolvedValue([goal({ id: "g3", source: "RESERVE", target: null })]);
    const [r] = await getGoals("u1", NOW);
    expect(r).toMatchObject({ current: 9000, target: 40000, ownTarget: null, status: "on-track" });
    expect(r.nextStep).toEqual({ label: "Oct invoice", payDate: "2026-10-30", reserveAfter: 19648 });
  });

  it("RESERVE is behind when the next step's date has passed without the money", async () => {
    md.getSafeToDraw.mockResolvedValue({
      reserveMissing: false, reserve: 9000, reserveTarget: 40000,
      reserveNext: { label: "Sep invoice", payDate: "2026-10-01", invoicesGross: 14000, reserveAfter: 19648 },
    });
    db.goal.findMany.mockResolvedValue([goal({ source: "RESERVE", target: null })]);
    expect((await getGoals("u1", NOW))[0].status).toBe("behind");
  });

  it("MANUAL reads the typed amount", async () => {
    db.goal.findMany.mockResolvedValue([goal({ manualAmount: "250.00" })]);
    const [m] = await getGoals("u1", NOW);
    expect(m.current).toBe(250);
    expect(m.remaining).toBe(750);
  });
});
