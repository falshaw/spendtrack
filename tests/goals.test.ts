/**
 * F5 — goal maths: percent (uncapped), remaining, per month needed, the straight
 * on-track line, reached, overdue, no date, no data, and the reserve's
 * schedule-driven status.
 */
import { describe, expect, it } from "vitest";
import { computeGoal, monthsBetween } from "@/lib/goals";

const base = { target: 12000, startDate: "2026-01-01", today: "2026-07-02", targetDate: "2027-01-01" };

describe("monthsBetween", () => {
  it("counts calendar months by days", () => {
    expect(monthsBetween("2026-01-01", "2027-01-01")).toBeCloseTo(12, 1);
    expect(monthsBetween("2026-10-19", "2026-10-19")).toBe(0);
  });
});

describe("computeGoal", () => {
  it("percent, remaining and per month needed", () => {
    const g = computeGoal({ ...base, current: 6000 });
    expect(g.pct).toBe(0.5);
    expect(g.remaining).toBe(6000);
    expect(g.monthsLeft).toBeCloseTo(6, 0);
    expect(g.perMonthNeeded).toBeCloseTo(1000, -1);
    expect(g.status).toBe("on-track");
  });

  it("behind when under the straight line from start to date", () => {
    const g = computeGoal({ ...base, current: 3000 });
    expect(g.expectedNow).toBeGreaterThan(5900);
    expect(g.status).toBe("behind");
  });

  it("reached at or over target; percent is not capped", () => {
    const g = computeGoal({ ...base, current: 14400 });
    expect(g.status).toBe("reached");
    expect(g.pct).toBeCloseTo(1.2, 5);
    expect(g.remaining).toBe(0);
    expect(g.perMonthNeeded).toBeNull();
  });

  it("overdue: everything left is needed now", () => {
    const g = computeGoal({ ...base, today: "2027-02-01", current: 10000 });
    expect(g.monthsLeft).toBe(0);
    expect(g.perMonthNeeded).toBe(2000);
    expect(g.status).toBe("behind");
  });

  it("no date: no per-month figure and status no-date", () => {
    const g = computeGoal({ ...base, targetDate: null, current: 100 });
    expect(g.perMonthNeeded).toBeNull();
    expect(g.monthsLeft).toBeNull();
    expect(g.status).toBe("no-date");
  });

  it("no figure from the source stays null, never 0", () => {
    const g = computeGoal({ ...base, current: null });
    expect(g).toMatchObject({ current: null, pct: null, remaining: null, status: "no-data" });
  });

  it("reserve: the schedule decides on-track vs behind, not the straight line", () => {
    expect(computeGoal({ ...base, current: 1000, behindSchedule: false }).status).toBe("on-track");
    expect(computeGoal({ ...base, current: 11000, behindSchedule: true }).status).toBe("behind");
    expect(computeGoal({ ...base, current: 12000, behindSchedule: true }).status).toBe("reached");
  });

  it("a zero target has no percent", () => {
    expect(computeGoal({ ...base, target: 0, current: 5 }).pct).toBeNull();
  });
});
