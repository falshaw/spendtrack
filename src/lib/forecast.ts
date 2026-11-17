/**
 * Real balances + the 60-day cash forecast — pure, so it is testable.
 *
 * Starting point per account = the latest statement closing balance (AccountBalance)
 * + every imported row on that account dated AFTER it. That is a real balance,
 * unlike the account card's net flow (which has no opening balance).
 *
 * Then the recurring rules roll it forward day by day:
 *   - an occurrence after the account's data FRONTIER (the later of the balance date
 *     and its newest imported row) but on/before today has most likely happened and
 *     is just not imported yet → it is applied to today's starting figure and listed
 *     as "since the last statement", never silently;
 *   - occurrences in the next `days` days land on their own date;
 *   - a rule stops at its `endDate`; an inactive rule never runs.
 * An account with no statement balance cannot be forecast honestly, so it is left
 * out and listed. A rule with no account is PRIVATE money from somewhere unknown:
 * it moves the total but belongs to no card.
 *
 * Steps by month INDEX with the day clamped (advanceByCadence) — mutating a Date on
 * the 31st skips a month, the bug occurrenceMonths() was written to avoid.
 */
import { toEur } from "./currency";
import { advanceByCadence } from "./utils";

export type Biz = "PERSONAL" | "BUSINESS";
export type ForecastScope = "all" | "personal" | "business";

export interface ForecastAccount {
  id: string;
  name: string;
  biz: Biz;
  color: string;
  latest: { asOf: string; balance: number; currency: string } | null;
  /** ≈EUR of imported rows on this account dated after `latest.asOf` (+ in, − out). */
  flowSinceEur: number;
  /** Newest imported row on this account, YYYY-MM-DD, or null. */
  lastTxnDate: string | null;
}

export interface ForecastRule {
  id: string;
  merchant: string;
  amount: number; // native, positive
  currency: string;
  type: "EXPENSE" | "INCOME";
  cadence: "WEEKLY" | "MONTHLY" | "QUARTERLY" | "YEARLY";
  nextDate: string; // YYYY-MM-DD
  endDate: string | null;
  active: boolean;
  accountId: string | null;
}

export interface ForecastEvent {
  date: string;
  ruleId: string;
  merchant: string;
  amountEur: number; // signed: + in, − out
  accountName: string | null;
  catchUp: boolean; // due since the last statement, applied to today
}

export interface ForecastResult {
  today: string;
  startTotal: number;
  endTotal: number;
  lowest: { date: string; balance: number };
  points: { date: string; balance: number }[];
  events: ForecastEvent[];
  accounts: { id: string; name: string; color: string; start: number; frontier: string; asOf: string }[];
  withoutBalance: { id: string; name: string }[];
  /** Rules skipped because their account has no statement balance. */
  skippedRules: { merchant: string; accountName: string }[];
}

const MAX_STEPS = 600;

/** Occurrences of a rule strictly after `afterIso` and on/before `untilIso`. */
export function ruleOccurrences(rule: ForecastRule, afterIso: string, untilIso: string): string[] {
  if (!rule.active) return [];
  const anchor = +rule.nextDate.slice(8, 10);
  let d = new Date(rule.nextDate + "T00:00:00Z");
  const out: string[] = [];
  for (let i = 0; i < MAX_STEPS; i++) {
    const iso = d.toISOString().slice(0, 10);
    if (iso > untilIso) break;
    if (rule.endDate && iso > rule.endDate) break;
    if (iso > afterIso) out.push(iso);
    d = advanceByCadence(d, rule.cadence, anchor);
  }
  return out;
}

export function inScope(biz: Biz, scope: ForecastScope): boolean {
  if (scope === "all") return true;
  if (scope === "personal") return biz === "PERSONAL";
  return biz === "BUSINESS";
}

const addDays = (iso: string, n: number) =>
  new Date(Date.parse(iso + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);

export function projectForecast(opts: {
  accounts: ForecastAccount[];
  rules: ForecastRule[];
  todayIso: string;
  days?: number;
  scope?: ForecastScope;
}): ForecastResult {
  const { todayIso } = opts;
  const days = opts.days ?? 60;
  const scope = opts.scope ?? "all";
  const endIso = addDays(todayIso, days);

  const accounts = opts.accounts.filter((a) => inScope(a.biz, scope));
  const byId = new Map(opts.accounts.map((a) => [a.id, a]));
  const withBalance = accounts.filter((a) => a.latest);
  const withoutBalance = accounts.filter((a) => !a.latest).map((a) => ({ id: a.id, name: a.name }));

  const starts = withBalance.map((a) => {
    const l = a.latest!;
    const frontier = a.lastTxnDate && a.lastTxnDate > l.asOf ? a.lastTxnDate : l.asOf;
    return {
      id: a.id,
      name: a.name,
      color: a.color,
      asOf: l.asOf,
      frontier,
      start: toEur(l.balance, l.currency, l.asOf) + a.flowSinceEur,
    };
  });
  const startById = new Map(starts.map((s) => [s.id, s]));

  const events: ForecastEvent[] = [];
  const skippedRules: ForecastResult["skippedRules"] = [];
  for (const r of opts.rules) {
    if (!r.active) continue;
    const acct = r.accountId ? byId.get(r.accountId) : undefined;
    const biz: Biz = acct?.biz ?? "PERSONAL";
    if (!inScope(biz, scope)) continue;
    const sign = r.type === "INCOME" ? 1 : -1;
    let after = todayIso;
    if (acct) {
      const s = startById.get(acct.id);
      if (!s) {
        skippedRules.push({ merchant: r.merchant, accountName: acct.name });
        continue;
      }
      after = s.frontier < todayIso ? s.frontier : todayIso;
    }
    for (const iso of ruleOccurrences(r, after, endIso)) {
      events.push({
        date: iso <= todayIso ? todayIso : iso,
        ruleId: r.id,
        merchant: r.merchant,
        amountEur: sign * toEur(r.amount, r.currency, iso > todayIso ? null : iso),
        accountName: acct?.name ?? null,
        catchUp: iso <= todayIso,
      });
    }
  }
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.amountEur - b.amountEur));

  const startTotal = starts.reduce((s, a) => s + a.start, 0);
  const byDay = new Map<string, number>();
  for (const e of events) byDay.set(e.date, (byDay.get(e.date) ?? 0) + e.amountEur);

  const points: { date: string; balance: number }[] = [];
  let bal = startTotal;
  let lowest = { date: todayIso, balance: Number.POSITIVE_INFINITY };
  for (let i = 0; i <= days; i++) {
    const iso = addDays(todayIso, i);
    bal += byDay.get(iso) ?? 0;
    points.push({ date: iso, balance: bal });
    if (bal < lowest.balance) lowest = { date: iso, balance: bal };
  }

  return {
    today: todayIso,
    startTotal,
    endTotal: bal,
    lowest,
    points,
    events,
    accounts: starts,
    withoutBalance,
    skippedRules,
  };
}
