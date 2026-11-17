import { describe, expect, it } from "vitest";
import {
  addMonthsUTC,
  advanceByCadence,
  daysInMonth,
  dec,
  monthStart,
  nextMonthStart,
} from "@/lib/utils";

describe("month boundary helpers (UTC)", () => {
  const midJune = new Date("2026-06-15T13:45:00Z");

  it("monthStart returns the first UTC instant of the month", () => {
    expect(monthStart(midJune).toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });

  it("nextMonthStart is the exclusive end of the month", () => {
    expect(nextMonthStart(midJune).toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("rolls across year boundaries", () => {
    const dec15 = new Date("2025-12-15T00:00:00Z");
    expect(nextMonthStart(dec15).toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(addMonthsUTC(dec15, 2).toISOString()).toBe("2026-02-01T00:00:00.000Z");
    expect(addMonthsUTC(dec15, -12).toISOString()).toBe("2024-12-01T00:00:00.000Z");
  });

  it("daysInMonth handles leap years", () => {
    expect(daysInMonth(new Date("2026-02-10T00:00:00Z"))).toBe(28);
    expect(daysInMonth(new Date("2028-02-10T00:00:00Z"))).toBe(29);
    expect(daysInMonth(new Date("2026-06-10T00:00:00Z"))).toBe(30);
  });
});

describe("advanceByCadence", () => {
  const d = new Date("2026-06-30T00:00:00Z");

  it("advances by the cadence step", () => {
    expect(advanceByCadence(d, "WEEKLY").toISOString().slice(0, 10)).toBe("2026-07-07");
    expect(advanceByCadence(d, "MONTHLY").toISOString().slice(0, 10)).toBe("2026-07-30");
    expect(advanceByCadence(d, "QUARTERLY").toISOString().slice(0, 10)).toBe("2026-09-30");
    expect(advanceByCadence(d, "YEARLY").toISOString().slice(0, 10)).toBe("2027-06-30");
  });

  // setUTCMonth(+1) on the 31st overflowed: 31 Jan → 3 Mar (February skipped),
  // 31 Aug → 1 Oct. The day must clamp to the target month instead.
  const step = (iso: string, c: Parameters<typeof advanceByCadence>[1], anchor?: number) =>
    advanceByCadence(new Date(`${iso}T00:00:00Z`), c, anchor).toISOString().slice(0, 10);

  it("clamps the 31st to the end of a shorter month", () => {
    expect(step("2026-01-31", "MONTHLY")).toBe("2026-02-28");
    expect(step("2028-01-31", "MONTHLY")).toBe("2028-02-29"); // leap year
    expect(step("2026-08-31", "MONTHLY")).toBe("2026-09-30");
    expect(step("2026-11-30", "QUARTERLY")).toBe("2027-02-28");
    expect(step("2028-02-29", "YEARLY")).toBe("2029-02-28");
  });

  it("rolls December into January of the next year", () => {
    expect(step("2026-12-31", "MONTHLY")).toBe("2027-01-31");
    expect(step("2026-11-15", "QUARTERLY")).toBe("2027-02-15");
  });

  it("restores the intended day-of-month when an anchor is given", () => {
    expect(step("2026-02-28", "MONTHLY")).toBe("2026-03-28");
    expect(step("2026-02-28", "MONTHLY", 31)).toBe("2026-03-31");
  });

  it("never mutates its input", () => {
    const input = new Date("2026-01-31T00:00:00Z");
    advanceByCadence(input, "MONTHLY");
    expect(input.toISOString().slice(0, 10)).toBe("2026-01-31");
  });
});

describe("dec", () => {
  it("converts Prisma Decimal-like values to numbers", () => {
    expect(dec({ toString: () => "1234.56" })).toBe(1234.56);
    expect(dec(null)).toBe(0);
    expect(dec(undefined)).toBe(0);
  });
});
