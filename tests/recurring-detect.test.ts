/**
 * F4 — the pure recurring detector: cadence from the lower-median gap, the 31st
 * clamp, a missed month, yearly bills, price changes, and the skip rules (linked,
 * covered by a rule, dismissed, stopped, too few rows, unstable amounts).
 */
import { describe, expect, it } from "vitest";
import {
  cadenceForGap,
  detectRecurring,
  groupKey,
  merchantKey,
  priceChangeOf,
  rulePriceChange,
  type DetectRow,
} from "@/lib/recurring-detect";

let n = 0;
const row = (date: string, amount: number, o: Partial<DetectRow> = {}): DetectRow => ({
  id: `t${++n}`,
  accountId: "acc-rev",
  merchant: "NETFLIX.COM 866-579 AMSTERDAM",
  type: "EXPENSE",
  amount,
  currency: "EUR",
  date,
  categoryId: "c-subs",
  recurringId: null,
  ...o,
});

describe("merchantKey / groupKey", () => {
  it("drops digit-bearing tokens and keeps three words", () => {
    expect(merchantKey("NETFLIX.COM 866-579 AMSTERDAM")).toBe("netflix com amsterdam");
    expect(merchantKey("Spotify P1A2B3 Stockholm SE extra words")).toBe("spotify stockholm se");
    expect(merchantKey("12345")).toBe("");
  });
  it("keys on account, type and currency as well", () => {
    const a = groupKey({ accountId: "a", type: "EXPENSE", currency: "eur", merchant: "Telco 0042" });
    expect(a).toBe("a|EXPENSE|EUR|telco");
    expect(groupKey({ accountId: null, type: "INCOME", currency: "EUR", merchant: "Telco" })).toBe("-|INCOME|EUR|telco");
  });
});

describe("cadenceForGap", () => {
  it("maps the windows W 5–9 / M 26–35 / Q 84–98 / Y 350–380", () => {
    expect(cadenceForGap(7)).toBe("WEEKLY");
    expect(cadenceForGap(31)).toBe("MONTHLY");
    expect(cadenceForGap(91)).toBe("QUARTERLY");
    expect(cadenceForGap(365)).toBe("YEARLY");
    expect(cadenceForGap(14)).toBeNull();
    expect(cadenceForGap(45)).toBeNull();
  });
});

describe("detectRecurring", () => {
  const TODAY = "2026-10-19";

  it("finds a monthly bill and projects the next date after today", () => {
    const rows = [row("2026-07-05", 12.99), row("2026-08-05", 12.99), row("2026-09-05", 12.99), row("2026-10-05", 12.99)];
    const [s] = detectRecurring(rows, [], [], TODAY);
    expect(s).toMatchObject({ cadence: "MONTHLY", count: 4, amount: 12.99, nextDate: "2026-11-05", priceChange: null, categoryId: "c-subs" });
    expect(s.txnIds).toEqual(rows.map((r) => r.id));
  });

  it("keeps the 31st: month-end charges clamp in short months and come back to the 31st", () => {
    const rows = [row("2026-05-31", 50), row("2026-06-30", 50), row("2026-07-31", 50), row("2026-08-31", 50), row("2026-09-30", 50)];
    const [s] = detectRecurring(rows, [], [], TODAY);
    expect(s.cadence).toBe("MONTHLY");
    expect(s.anchorDay).toBe(31);
    expect(s.nextDate).toBe("2026-10-31");
    const [feb] = detectRecurring(
      [row("2026-11-30", 50), row("2026-12-31", 50), row("2027-01-31", 50)],
      [], [], "2027-02-01",
    );
    expect(feb.nextDate).toBe("2027-02-28");
  });

  it("survives a missed month (lower median gap)", () => {
    const rows = [row("2026-06-10", 20), row("2026-07-10", 20), row("2026-09-10", 20)];
    const [s] = detectRecurring(rows, [], [], TODAY);
    expect(s.cadence).toBe("MONTHLY");
    expect(s.gapDays).toBe(30);
    expect(s.nextDate).toBe("2026-11-10");
  });

  it("finds a yearly bill", () => {
    const rows = [row("2024-03-01", 99, { merchant: "Domain renew" }), row("2025-03-01", 99, { merchant: "Domain renew" }), row("2026-03-02", 99, { merchant: "Domain renew" })];
    const [s] = detectRecurring(rows, [], [], TODAY);
    expect(s.cadence).toBe("YEARLY");
    expect(s.nextDate).toBe("2027-03-01"); // anchored on the usual day (1st), not the late one
  });

  it("flags a price rise on the last charge (> 5 % and > €1)", () => {
    const rows = [row("2026-07-05", 12.99), row("2026-08-05", 12.99), row("2026-09-05", 12.99), row("2026-10-05", 15.99)];
    const [s] = detectRecurring(rows, [], [], TODAY);
    expect(s.priceChange).toEqual({ from: 12.99, to: 15.99, pct: 0.2309 });
    expect(s.amount).toBe(15.99);
  });

  it("does not flag a small move (under €1 or under 5 %)", () => {
    expect(priceChangeOf(10, 10.9)).toBeNull(); // 9 % but under €1
    expect(priceChangeOf(100, 104)).toBeNull(); // €4 but 4 %
    expect(priceChangeOf(100, 94)).toEqual({ from: 100, to: 94, pct: -0.06 });
  });

  it("skips unstable amounts, too few rows, same-day doubles and irregular gaps", () => {
    expect(detectRecurring([row("2026-07-05", 10), row("2026-08-05", 30), row("2026-09-05", 10)], [], [], TODAY)).toEqual([]);
    expect(detectRecurring([row("2026-08-05", 10), row("2026-09-05", 10)], [], [], TODAY)).toEqual([]);
    expect(detectRecurring([row("2026-08-05", 10), row("2026-08-05", 10), row("2026-09-05", 10)], [], [], TODAY)).toEqual([]);
    expect(detectRecurring([row("2026-06-01", 10), row("2026-06-20", 10), row("2026-08-15", 10)], [], [], TODAY)).toEqual([]);
  });

  it("skips groups already linked, covered by an active rule, dismissed, or stopped", () => {
    const base = () => [row("2026-07-05", 12.99), row("2026-08-05", 12.99), row("2026-09-05", 12.99)];
    const linked = base();
    linked[1].recurringId = "rule-1";
    expect(detectRecurring(linked, [], [], TODAY)).toEqual([]);

    const rule = { id: "r", merchant: "Netflix.com", accountId: null, type: "EXPENSE" as const, active: true, endDate: null };
    expect(detectRecurring(base(), [rule], [], TODAY)).toEqual([]);
    // an inactive / ended / other-account rule does not cover it
    expect(detectRecurring(base(), [{ ...rule, active: false }], [], TODAY)).toHaveLength(1);
    expect(detectRecurring(base(), [{ ...rule, endDate: "2026-01-01" }], [], TODAY)).toHaveLength(1);
    expect(detectRecurring(base(), [{ ...rule, accountId: "acc-other" }], [], TODAY)).toHaveLength(1);

    const [s] = detectRecurring(base(), [], [], TODAY);
    expect(detectRecurring(base(), [], [s.key], TODAY)).toEqual([]);

    // last charge in March, monthly → stopped by October
    expect(detectRecurring([row("2026-01-05", 9), row("2026-02-05", 9), row("2026-03-05", 9)], [], [], TODAY)).toEqual([]);
  });

  it("keeps different accounts and currencies apart", () => {
    const rows = [
      row("2026-07-05", 10), row("2026-08-05", 10),
      row("2026-09-05", 10, { accountId: "acc-bank-c" }),
      row("2026-10-05", 10, { currency: "GBP" }),
    ];
    expect(detectRecurring(rows, [], [], TODAY)).toEqual([]);
  });
});

describe("rulePriceChange", () => {
  it("compares the latest same-currency linked charge with the rule amount", () => {
    const linked = [
      { amount: 12.99, date: "2026-08-05", currency: "EUR" },
      { amount: 15.99, date: "2026-10-05", currency: "EUR" },
      { amount: 99, date: "2026-10-10", currency: "GBP" },
    ];
    expect(rulePriceChange(12.99, linked, "EUR")).toEqual({ from: 12.99, to: 15.99, pct: 0.2309 });
    expect(rulePriceChange(15.99, linked, "EUR")).toBeNull();
    expect(rulePriceChange(12.99, [], "EUR")).toBeNull();
  });
});
