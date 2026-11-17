/**
 * Recurring rule status — due / paid / missed — pure, so it is testable.
 *
 * For each active rule the LATEST expected occurrence on or before today is judged
 * (`ruleOccurrences` from forecast.ts walks the cadence from `nextDate`, stops at
 * `endDate`; `nextDate` itself only rolls on "log now", so a rule paid by statement
 * import keeps its old date and the walk is what finds the current occurrence):
 *
 *   - paid     — an imported row settles it: either a row LINKED to the rule
 *                (`recurringId`, within ±7 days — the amount may have moved, the
 *                price-change badge says so) or the Upcoming widget's own rule,
 *                `settlesOccurrence` (same type, ±7 days, ±10 %, same account);
 *   - due      — expected within the last `DUE_GRACE_DAYS`, nothing matched yet;
 *   - missed   — older than that, nothing matched, AND the rule's account has rows
 *                dated after expected + grace — the statement covering that date is
 *                in, so the absence is real (a salary that did not arrive);
 *   - unknown  — the account's imported data does not reach expected + grace yet
 *                (statements end mid-month) — never called missed;
 *   - upcoming — nothing expected yet: the first occurrence is still in the future.
 *
 * Null = nothing to judge: an inactive rule, a rule past its `endDate` with no
 * occurrence left, or a replacement bill that has not started (`recurringHasStarted`).
 * Income rules go through the same path. Nothing here reads or writes a database.
 */
import { ruleOccurrences, type ForecastRule } from "./forecast";
import { recurringHasStarted, SETTLE_WINDOW_MS, settlesOccurrence } from "./finance";

export type RuleStatusKind = "paid" | "due" | "missed" | "unknown" | "upcoming";

export type StatusRule = ForecastRule;

export interface StatusTxn {
  date: string; // YYYY-MM-DD
  amount: number; // native, positive
  currency: string;
  type: "EXPENSE" | "INCOME";
  accountId: string | null;
  recurringId: string | null;
}

export interface RuleStatus {
  ruleId: string;
  status: RuleStatusKind;
  expectedDate: string; // the occurrence judged (or the next one, for `upcoming`)
  matched: { date: string; amount: number; currency: string } | null;
}

export interface StatusSummary {
  paid: number;
  due: number;
  missed: number;
  unknown: number;
}

/** Days after the expected date a bill may still be "due" before it is judged. */
export const DUE_GRACE_DAYS = 2;

const DAY = 86_400_000;
const toMs = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const shift = (iso: string, days: number) => new Date(toMs(iso) + days * DAY).toISOString().slice(0, 10);

export function ruleStatus(rule: StatusRule, rows: StatusTxn[], today: string): RuleStatus | null {
  if (!rule.active) return null;
  if (!recurringHasStarted(new Date(toMs(rule.nextDate)), rule.cadence, new Date(toMs(today)))) return null;

  const past = ruleOccurrences(rule, shift(rule.nextDate, -1), today);
  if (past.length === 0) {
    if (rule.endDate && rule.nextDate > rule.endDate) return null; // ran out before it was ever due
    return { ruleId: rule.id, status: "upcoming", expectedDate: rule.nextDate, matched: null };
  }

  const expected = past[past.length - 1];
  const at = toMs(expected);
  // The closest row in the window wins — weekly windows overlap, and "first found"
  // would hand this week's row to a neighbouring occurrence.
  let hit: StatusTxn | null = null;
  let hitDist = Infinity;
  for (const t of rows) {
    if (t.type !== rule.type) continue;
    const dist = Math.abs(toMs(t.date) - at);
    if (dist > SETTLE_WINDOW_MS || dist >= hitDist) continue;
    if (t.recurringId === rule.id || settlesOccurrence(rule, t, at)) {
      hit = t;
      hitDist = dist;
    }
  }
  if (hit) {
    return {
      ruleId: rule.id,
      status: "paid",
      expectedDate: expected,
      matched: { date: hit.date, amount: hit.amount, currency: hit.currency },
    };
  }

  const settledBy = shift(expected, DUE_GRACE_DAYS);
  if (today <= settledBy) return { ruleId: rule.id, status: "due", expectedDate: expected, matched: null };

  // Is the statement covering the expected date in? Only rows on the rule's own
  // account say so; an unlinked rule reads the whole ledger's frontier.
  let frontier = "";
  for (const t of rows) {
    if (rule.accountId != null && t.accountId !== rule.accountId) continue;
    if (t.date > frontier) frontier = t.date;
  }
  return {
    ruleId: rule.id,
    status: frontier > settledBy ? "missed" : "unknown",
    expectedDate: expected,
    matched: null,
  };
}

/** Status per rule id; rules with nothing to judge are left out. */
export function ruleStatuses(rules: StatusRule[], rows: StatusTxn[], today: string): Record<string, RuleStatus> {
  const out: Record<string, RuleStatus> = {};
  for (const r of rules) {
    const s = ruleStatus(r, rows, today);
    if (s) out[r.id] = s;
  }
  return out;
}

/** "N paid · N due · N missed · N not yet importable" — `upcoming` is not counted. */
export function statusSummary(statuses: Iterable<RuleStatus | null | undefined>): StatusSummary {
  const s: StatusSummary = { paid: 0, due: 0, missed: 0, unknown: 0 };
  for (const st of statuses) {
    if (!st || st.status === "upcoming") continue;
    s[st.status] += 1;
  }
  return s;
}
