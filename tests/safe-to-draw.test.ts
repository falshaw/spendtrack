import { describe, expect, it } from "vitest";
import {
  computeSafeToDraw,
  isEarned,
  isSettled,
  MONEY_RULES,
  RESERVE_MATCH,
  reserveDue,
  type ReserveStepInput,
} from "../src/lib/safe-to-draw";

// A fictional reserve plan: one step per invoice payment.
const PLAN: ReserveStepInput[] = [
  { payDate: "2026-09-30", label: "Invoice Aug", invoicesGross: 10000, reserveAfter: 4000 },
  { payDate: "2026-10-31", label: "Invoice Sep", invoicesGross: 15000, reserveAfter: 9000 },
  { payDate: "2026-11-30", label: "Invoice Oct", invoicesGross: 20000, reserveAfter: 20000 },
  { payDate: "2026-12-31", label: "Invoice Nov", invoicesGross: 20000, reserveAfter: 32000 },
  { payDate: "2027-01-31", label: "Invoice Dec", invoicesGross: 15000, reserveAfter: 40000 },
];

const owed = [
  { label: "Invoice Aug", date: "2026-09-30", amount: 10000 },
  { label: "Invoice Sep", date: "2026-10-31", amount: 15000 },
];
// Explicit rules, so the numbers below do not depend on the environment.
const RULES = { taxRate: 0.25, monthlyBudget: 2000 };
const base = { receivables: [], invoicesReceived: 0, reserveSteps: PLAN, spentThisMonth: 0, rules: RULES };

describe("MONEY_RULES — defaults without environment overrides", () => {
  it("uses the documented defaults; the reserve is NOT a constant", () => {
    expect(MONEY_RULES.taxRate).toBe(0.25);
    expect(MONEY_RULES.monthlyBudget).toBe(2000);
    expect(MONEY_RULES.since).toBe("2000-01-01");
    expect("reserve" in MONEY_RULES).toBe(false);
  });
});

describe("reserveDue — the reserve is built invoice by invoice", () => {
  it("nothing received yet → €0 due today, next step is the first invoice, target = last level", () => {
    const r = reserveDue(PLAN, 0);
    expect(r.level).toBe(0);
    expect(r.reached).toBeNull();
    expect(r.next?.label).toBe("Invoice Aug");
    expect(r.target).toBe(40000);
  });

  it("each step is reached by the cumulative invoice money received", () => {
    expect(reserveDue(PLAN, 10000).level).toBe(4000);
    expect(reserveDue(PLAN, 25000).level).toBe(9000);
    expect(reserveDue(PLAN, 45000).level).toBe(20000);
    expect(reserveDue(PLAN, 65000).level).toBe(32000);
    const all = reserveDue(PLAN, 80000);
    expect(all.level).toBe(40000);
    expect(all.next).toBeNull();
  });

  it(`an invoice a little under the plan (≥ ${RESERVE_MATCH * 100} %) still reaches its step; half of it does not`, () => {
    expect(reserveDue(PLAN, 9500).level).toBe(4000);
    expect(reserveDue(PLAN, 5000).level).toBe(0);
  });

  it("order of the stored rows does not matter", () => {
    expect(reserveDue([...PLAN].reverse(), 25000).level).toBe(9000);
  });

  it("no schedule → level 0, target 0", () => {
    expect(reserveDue([], 50000)).toEqual({ level: 0, reached: null, next: null, target: 0 });
  });
});

describe("computeSafeToDraw", () => {
  it("never invents a balance: a missing drawable one gives safe = null and the floor instead", () => {
    const r = computeSafeToDraw({ ...base, cash: [{ name: "Main", amount: null, asOf: null }], receivables: owed });
    expect(r.safe).toBeNull();
    expect(r.cashMissing).toEqual(["Main"]);
    expect(r.receivables).toBe(25000);
    // 25 % on the UNPAID invoices only
    expect(r.taxSetAside).toBe(6250);
    // 6,250 tax + 0 reserve due (nothing received) + 2,000 budget − 25,000 owed
    expect(r.floor).toBe(-16750);
  });

  it("one missing drawable balance among known ones still blocks the number", () => {
    const r = computeSafeToDraw({
      ...base,
      cash: [
        { name: "A", amount: 90000, asOf: "2026-09-30" },
        { name: "B", amount: null, asOf: null },
      ],
    });
    expect(r.safe).toBeNull();
    expect(r.cashKnown).toBe(90000);
  });

  it("drawable cash − floor, with the reserve due per the invoices received", () => {
    const r = computeSafeToDraw({
      ...base,
      cash: [
        { name: "Main", amount: 40000, asOf: "2026-09-30" },
        { name: "Card", amount: -2000, asOf: "2026-09-20" },
      ],
      receivables: [owed[1]],
      invoicesReceived: 10000, // first invoice in → reserve €4,000
      spentThisMonth: 1500,
    });
    expect(r.reserve).toBe(4000);
    expect(r.reserveReached?.label).toBe("Invoice Aug");
    expect(r.reserveNext?.label).toBe("Invoice Sep");
    expect(r.taxSetAside).toBe(3750); // 25 % of the unpaid €15,000 only
    // floor 3,750 + 4,000 + 500 budget left − 15,000 = −6,750; cash 38,000 → headroom 44,750, capped at cash − budget left
    expect(r.floor).toBe(-6750);
    expect(r.safe).toBe(37500);
  });

  it("an invoice already received carries no extra tax — the reserve level is net of it", () => {
    const r = computeSafeToDraw({ ...base, cash: [{ name: "X", amount: 60000, asOf: "2026-10-31" }], invoicesReceived: 10000 });
    expect(r.taxSetAside).toBe(0);
    expect(r.floor).toBe(4000 + 2000);
  });

  it("an earmarked account is held back: shown, not drawable, and its missing balance does not block", () => {
    const r = computeSafeToDraw({
      ...base,
      cash: [
        { name: "Business current", amount: 10000, asOf: "2026-09-30" },
        { name: "Business savings", amount: 24000, asOf: "2026-09-30", earmark: "VAT reserve" },
        { name: "Old pot", amount: null, asOf: null, earmark: "closing" },
      ],
    });
    expect(r.cashDrawable).toBe(10000);
    expect(r.cashKnown).toBe(34000);
    expect(r.held).toEqual([
      { name: "Business savings", amount: 24000, label: "VAT reserve" },
      { name: "Old pot", amount: null, label: "closing" },
    ]);
    expect(r.cashMissing).toEqual([]);
    expect(r.safe).toBe(8000); // 10,000 − 0 reserve − 2,000 budget
  });

  it("a blank earmark is not a hold", () => {
    const r = computeSafeToDraw({ ...base, cash: [{ name: "A", amount: 5000, asOf: "2026-09-30", earmark: "  " }] });
    expect(r.held).toEqual([]);
    expect(r.cashDrawable).toBe(5000);
  });

  it("no reserve schedule → no reserve held back, the number is still computed", () => {
    const r = computeSafeToDraw({ ...base, reserveSteps: [], cash: [{ name: "A", amount: 90000, asOf: "2026-09-30" }] });
    expect(r.reserveMissing).toBe(true);
    expect(r.reserve).toBe(0);
    expect(r.safe).toBe(88000); // 90,000 − 2,000 budget
  });

  it("clamps at zero and at drawable cash less this month's budget", () => {
    const poor = computeSafeToDraw({ ...base, invoicesReceived: 25000, cash: [{ name: "X", amount: 10000, asOf: "2026-09-30" }] });
    expect(poor.safe).toBe(0); // 10,000 < 9,000 reserve + 2,000 budget
    const negative = computeSafeToDraw({ ...base, cash: [{ name: "Cards", amount: -7000, asOf: "2026-09-30" }], receivables: owed });
    expect(negative.safe).toBe(0);
    const owedRich = computeSafeToDraw({
      ...base,
      cash: [{ name: "X", amount: 5000, asOf: "2026-09-30" }],
      receivables: [{ label: "big", date: "2026-10-31", amount: 100000 }],
    });
    expect(owedRich.safe).toBe(3000);
  });
});

describe("computeSafeToDraw — stale balances (as-of over 35 days)", () => {
  it("a stale balance is still counted: one number, with the stale account named", () => {
    const r = computeSafeToDraw({
      ...base,
      today: "2026-10-01",
      cash: [
        { name: "Main", amount: 80000, asOf: "2026-09-30" },
        { name: "Card A", amount: 0, asOf: "2026-02-19" },
        { name: "Card B", amount: -250, asOf: "2026-04-30" },
      ],
    });
    expect(r.safe).not.toBeNull();
    expect(r.cashKnown).toBe(79750);
    expect(r.cashStale).toEqual([
      { name: "Card A", asOf: "2026-02-19" },
      { name: "Card B", asOf: "2026-04-30" },
    ]);
  });

  it("35 days old is not stale; without `today` nothing is flagged", () => {
    expect(computeSafeToDraw({ ...base, cash: [{ name: "A", amount: 1, asOf: "2026-08-27" }], today: "2026-10-01" }).cashStale).toEqual([]);
    expect(computeSafeToDraw({ ...base, cash: [{ name: "A", amount: 1, asOf: "2020-01-01" }] }).cashStale).toEqual([]);
  });

  it("a missing balance is reported as missing, not as stale", () => {
    const r = computeSafeToDraw({ ...base, today: "2026-10-01", cash: [{ name: "B", amount: null, asOf: null }] });
    expect(r.cashMissing).toEqual(["B"]);
    expect(r.cashStale).toEqual([]);
    expect(r.safe).toBeNull();
  });
});

describe("isEarned / isSettled", () => {
  it("a payment due within 30 days bills a finished month", () => {
    expect(isEarned("2026-10-31", "2026-10-01")).toBe(true);
    expect(isEarned("2026-09-30", "2026-10-01")).toBe(true);
    expect(isEarned("2026-11-30", "2026-10-01")).toBe(false);
  });

  it("an imported row ±7 days / ±10 % on the same account settles it", () => {
    const r = { date: "2026-09-30", amount: 10000, accountId: "acc-biz" };
    expect(isSettled(r, [{ date: "2026-10-03", amount: 10000, accountId: "acc-biz" }])).toBe(true);
    expect(isSettled(r, [{ date: "2026-10-03", amount: 10000, accountId: "acc-personal" }])).toBe(false);
    expect(isSettled(r, [{ date: "2026-10-12", amount: 10000, accountId: "acc-biz" }])).toBe(false);
    expect(isSettled(r, [{ date: "2026-10-01", amount: 50, accountId: "acc-biz" }])).toBe(false);
  });
});
