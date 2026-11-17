/**
 * F8 — the ECB auto-refresh the (app) layout fires without awaiting it: refreshes
 * only when the table is > 3 business days behind, one attempt per 6 hours, and a
 * failed fetch only records an error (the dashboard chip reads it), never throws.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  fxRate: { aggregate: vi.fn(), findMany: vi.fn(), upsert: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));

import { ECB_REFRESH_COOLDOWN_MS, ecbRefreshState, maybeRefreshEcb, resetEcbRefreshForTests } from "@/lib/fx";

const XML = `<Cube><Cube time='2026-10-16'><Cube currency='USD' rate='1.17'/></Cube></Cube>`;
const fetchMock = vi.fn();

beforeEach(() => {
  resetEcbRefreshForTests();
  vi.clearAllMocks();
  db.fxRate.findMany.mockResolvedValue([]);
  db.$transaction.mockResolvedValue([]);
  db.fxRate.upsert.mockReturnValue({});
  fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => XML });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const MON = new Date("2026-10-19T10:00:00Z");

describe("maybeRefreshEcb", () => {
  it("does not fetch while the rates are fresh", async () => {
    db.fxRate.aggregate.mockResolvedValue({ _max: { date: new Date("2026-10-16T00:00:00Z") } });
    await maybeRefreshEcb(MON);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ecbRefreshState().gapDays).toBe(1);
  });

  it("fetches the daily feed for a 4-day gap and the 90-day history for a longer one", async () => {
    db.fxRate.aggregate.mockResolvedValue({ _max: { date: new Date("2026-10-13T00:00:00Z") } }); // Tue → Mon = 4
    await maybeRefreshEcb(MON);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("eurofxref-daily.xml");

    resetEcbRefreshForTests();
    fetchMock.mockClear();
    db.fxRate.aggregate.mockResolvedValue({ _max: { date: new Date("2026-09-30T00:00:00Z") } });
    await maybeRefreshEcb(MON);
    expect(String(fetchMock.mock.calls[0][0])).toContain("hist-90d");
  });

  it("backfills an empty table from the 90-day history", async () => {
    db.fxRate.aggregate.mockResolvedValue({ _max: { date: null } });
    await maybeRefreshEcb(MON);
    expect(String(fetchMock.mock.calls[0][0])).toContain("hist-90d");
  });

  it("records a failure instead of throwing, and waits out the 6 h cooldown", async () => {
    db.fxRate.aggregate.mockResolvedValue({ _max: { date: new Date("2026-09-30T00:00:00Z") } });
    fetchMock.mockRejectedValue(new Error("getaddrinfo ENOTFOUND www.ecb.europa.eu"));
    await expect(maybeRefreshEcb(MON)).resolves.toBeUndefined();
    expect(ecbRefreshState().lastError).toContain("ENOTFOUND");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await maybeRefreshEcb(new Date(MON.getTime() + 60 * 60_000)); // 1 h later: still cooling down
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await maybeRefreshEcb(new Date(MON.getTime() + ECB_REFRESH_COOLDOWN_MS + 1));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("is single-flight: concurrent page views share one check", async () => {
    db.fxRate.aggregate.mockResolvedValue({ _max: { date: new Date("2026-09-30T00:00:00Z") } });
    await Promise.all([maybeRefreshEcb(MON), maybeRefreshEcb(MON), maybeRefreshEcb(MON)]);
    expect(db.fxRate.aggregate).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("clears the error after a successful fetch", async () => {
    db.fxRate.aggregate.mockResolvedValue({ _max: { date: new Date("2026-09-30T00:00:00Z") } });
    await maybeRefreshEcb(MON);
    expect(ecbRefreshState().lastError).toBeNull();
    expect(ecbRefreshState().latest).toBe("2026-10-16");
  });
});
