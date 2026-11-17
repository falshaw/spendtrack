/**
 * Recurring rule status — due / paid / missed / unknown / upcoming — on a fixed
 * `today`, with the rule's stale `nextDate` (it only rolls on "log now") walked
 * forward to the latest occurrence. The "statement not in yet" case is the one
 * that must never read as missed: an account whose rows stop before the expected
 * date has simply not been imported.
 */
import { describe, expect, it } from "vitest";
import { settlesOccurrence } from "@/lib/finance";
import {
  DUE_GRACE_DAYS,
  ruleStatus,
  ruleStatuses,
  statusSummary,
  type StatusRule,
  type StatusTxn,
} from "@/lib/recurring-status";

const TODAY = "2026-10-26";

const rule = (o: Partial<StatusRule> = {}): StatusRule => ({
  id: "r-rent",
  merchant: "Rent",
  amount: 1200,
  currency: "EUR",
  type: "EXPENSE",
  cadence: "MONTHLY",
  nextDate: "2026-05-01", // never rolled — paid by statement import since May
  endDate: null,
  active: true,
  accountId: "a-rev",
  ...o,
});

const txn = (date: string, amount: number, o: Partial<StatusTxn> = {}): StatusTxn => ({
  date,
  amount,
  currency: "EUR",
  type: "EXPENSE",
  accountId: "a-rev",
  recurringId: null,
  ...o,
});

describe("paid", () => {
  it("matches the latest occurrence to a row within ±7 days / ±10 % on the same account", () => {
    const s = ruleStatus(rule(), [txn("2026-10-02", 1200)], TODAY)!;
    expect(s.status).toBe("paid");
    expect(s.expectedDate).toBe("2026-10-01");
    expect(s.matched).toEqual({ date: "2026-10-02", amount: 1200, currency: "EUR" });
  });

  it("reports the ROW's amount, not the rule's", () => {
    const s = ruleStatus(rule(), [txn("2026-10-01", 1250)], TODAY)!;
    expect(s.status).toBe("paid");
    expect(s.matched!.amount).toBe(1250);
  });

  it("takes the closest row when two sit in the window", () => {
    const rows = [txn("2026-09-26", 1200), txn("2026-10-01", 1200)];
    expect(ruleStatus(rule(), rows, TODAY)!.matched!.date).toBe("2026-10-01");
  });

  it("a row LINKED to the rule settles it even when the amount moved past 10 %", () => {
    const linked = txn("2026-10-01", 1900, { recurringId: "r-rent" }); // +15 %
    expect(ruleStatus(rule(), [linked], TODAY)!.status).toBe("paid");
    // The same row unlinked is not a match — and the account's data reaches past the
    // expected date, so the rent is missed.
    expect(ruleStatus(rule(), [txn("2026-10-01", 1900), txn("2026-10-20", 7)], TODAY)!.status).toBe("missed");
  });

  it("a row on another account never settles a linked rule's occurrence", () => {
    const rows = [txn("2026-10-01", 1200, { accountId: "a-other" })];
    // Nothing on a-rev at all → its statement is not in either → unknown, not missed.
    expect(ruleStatus(rule(), rows, TODAY)!.status).toBe("unknown");
  });

  it("a row of the other type never settles it", () => {
    const rows = [txn("2026-10-01", 1200, { type: "INCOME" }), txn("2026-10-20", 12)];
    expect(ruleStatus(rule(), rows, TODAY)!.status).toBe("missed");
  });

  it("uses the Upcoming widget's own predicate", () => {
    const r = rule();
    expect(settlesOccurrence(r, txn("2026-10-07", 1150), Date.parse("2026-10-01T00:00:00Z"))).toBe(true);
    expect(settlesOccurrence(r, txn("2026-10-09", 1200), Date.parse("2026-10-01T00:00:00Z"))).toBe(false); // 8 days
    expect(settlesOccurrence(r, txn("2026-10-01", 1000), Date.parse("2026-10-01T00:00:00Z"))).toBe(false); // > 10 %
  });
});

describe("due", () => {
  it("is due on the expected day and for the grace days after it", () => {
    expect(ruleStatus(rule(), [], "2026-10-01")!.status).toBe("due");
    expect(ruleStatus(rule(), [], "2026-10-03")!.status).toBe("due");
    expect(DUE_GRACE_DAYS).toBe(2);
  });

  it("stops being due after the grace days — unknown with no data, never silently paid", () => {
    expect(ruleStatus(rule(), [], "2026-10-04")!.status).toBe("unknown");
  });
});

describe("missed vs unknown — is the statement in?", () => {
  it("is missed only once the account has rows dated after expected + grace", () => {
    expect(ruleStatus(rule(), [txn("2026-10-03", 20)], TODAY)!.status).toBe("unknown"); // frontier = grace day
    expect(ruleStatus(rule(), [txn("2026-10-04", 20)], TODAY)!.status).toBe("missed");
  });

  it("the statement not in yet: rows end before the expected date → unknown", () => {
    const rows = [txn("2026-09-01", 1200), txn("2026-09-30", 44)];
    const s = ruleStatus(rule(), rows, TODAY)!;
    expect(s.status).toBe("unknown");
    expect(s.expectedDate).toBe("2026-10-01");
  });

  it("another account's newer rows do not make a linked rule's absence real", () => {
    const rows = [txn("2026-10-20", 30, { accountId: "a-other" })];
    expect(ruleStatus(rule(), rows, TODAY)!.status).toBe("unknown");
  });

  it("an unlinked rule reads the whole ledger's frontier", () => {
    const rows = [txn("2026-10-20", 30, { accountId: "a-other" })];
    expect(ruleStatus(rule({ accountId: null }), rows, TODAY)!.status).toBe("missed");
  });
});

describe("upcoming and nothing-to-judge", () => {
  it("a first occurrence still ahead is upcoming", () => {
    const s = ruleStatus(rule({ nextDate: "2026-11-01" }), [], TODAY)!;
    expect(s.status).toBe("upcoming");
    expect(s.expectedDate).toBe("2026-11-01");
    expect(s.matched).toBeNull();
  });

  it("a replacement bill that has not started (recurringHasStarted) is left out", () => {
    expect(ruleStatus(rule({ id: "rec-rent-next", nextDate: "2027-01-15", amount: 1800 }), [], TODAY)).toBeNull();
  });

  it("an inactive rule is left out", () => {
    expect(ruleStatus(rule({ active: false }), [], TODAY)).toBeNull();
  });
});

describe("endDate", () => {
  const ended = rule({ nextDate: "2026-05-15", endDate: "2026-09-15" });

  it("expects nothing after the end date — the last occurrence paid means paid, not an October miss", () => {
    const s = ruleStatus(ended, [txn("2026-09-15", 1200), txn("2026-10-20", 5)], TODAY)!;
    expect(s.status).toBe("paid");
    expect(s.expectedDate).toBe("2026-09-15");
  });

  it("still catches the last payment before the end being missed", () => {
    const s = ruleStatus(ended, [txn("2026-10-20", 5)], TODAY)!;
    expect(s.status).toBe("missed");
    expect(s.expectedDate).toBe("2026-09-15");
  });

  it("a rule whose nextDate is already past its endDate has nothing to judge", () => {
    expect(ruleStatus(rule({ nextDate: "2026-10-15", endDate: "2026-09-30" }), [], TODAY)).toBeNull();
  });
});

describe("income rules", () => {
  const salary = rule({ id: "r-invoice", merchant: "Example Ltd", amount: 14000, type: "INCOME", nextDate: "2026-09-28", accountId: "a-1" });

  it("a salary that did not arrive, with the account's statement in, is missed", () => {
    const rows = [txn("2026-10-10", 120, { accountId: "a-1" })]; // an EXPENSE: the data reaches past 28.09
    const s = ruleStatus(salary, rows, TODAY)!;
    expect(s.status).toBe("missed");
    expect(s.expectedDate).toBe("2026-09-28");
  });

  it("an INCOME row within the window settles it", () => {
    const rows = [txn("2026-09-30", 14000, { type: "INCOME", accountId: "a-1" })];
    const s = ruleStatus(salary, rows, TODAY)!;
    expect(s.status).toBe("paid");
    expect(s.matched!.date).toBe("2026-09-30");
  });

  it("an EXPENSE of the same amount is not the salary", () => {
    const rows = [txn("2026-09-28", 14000, { accountId: "a-1" }), txn("2026-10-10", 1, { accountId: "a-1" })];
    expect(ruleStatus(salary, rows, TODAY)!.status).toBe("missed");
  });
});

describe("cadences", () => {
  it("weekly: judges this week's occurrence", () => {
    const weekly = rule({ cadence: "WEEKLY", nextDate: "2026-10-05", amount: 20 });
    const s = ruleStatus(weekly, [txn("2026-10-26", 20)], TODAY)!;
    expect(s.expectedDate).toBe("2026-10-26");
    expect(s.status).toBe("paid");
  });

  it("quarterly: the latest occurrence on/before today, day clamped", () => {
    const q = rule({ cadence: "QUARTERLY", nextDate: "2026-01-31" });
    // 31 Jan → 30 Apr → 31 Jul → 31 Oct (future) — latest ≤ today is 31 Jul.
    expect(ruleStatus(q, [txn("2026-07-31", 1200)], TODAY)!.expectedDate).toBe("2026-07-31");
  });
});

describe("ruleStatuses + statusSummary", () => {
  const rules = [
    rule(), // paid
    rule({ id: "r-due", nextDate: "2026-10-25", amount: 9.99 }), // due (yesterday, no row)
    rule({ id: "r-missed", nextDate: "2026-10-05", amount: 300 }), // missed (rows reach 20.10)
    rule({ id: "r-unknown", nextDate: "2026-10-15", amount: 50, accountId: "a-card" }), // no a-card rows
    rule({ id: "r-up", nextDate: "2026-11-10", amount: 12 }), // upcoming
    rule({ id: "r-off", active: false }),
  ];
  const rows = [txn("2026-10-01", 1200), txn("2026-10-20", 7)];

  it("keys by rule id and leaves out rules with nothing to judge", () => {
    const st = ruleStatuses(rules, rows, TODAY);
    expect(Object.keys(st).sort()).toEqual(["r-due", "r-missed", "r-rent", "r-unknown", "r-up"]);
    expect(st["r-rent"].status).toBe("paid");
    expect(st["r-due"].status).toBe("due");
    expect(st["r-missed"].status).toBe("missed");
    expect(st["r-unknown"].status).toBe("unknown");
    expect(st["r-up"].status).toBe("upcoming");
  });

  it("counts paid / due / missed / unknown — upcoming and null are not counted", () => {
    const st = ruleStatuses(rules, rows, TODAY);
    expect(statusSummary([...Object.values(st), null])).toEqual({ paid: 1, due: 1, missed: 1, unknown: 1 });
  });

  it("changes nothing in the money data: rules and rows are byte-identical after the run", () => {
    const before = JSON.stringify({ rules, rows });
    ruleStatuses(rules, rows, TODAY);
    ruleStatus(rules[0], rows, "2026-10-02");
    expect(JSON.stringify({ rules, rows })).toBe(before);
  });
});
