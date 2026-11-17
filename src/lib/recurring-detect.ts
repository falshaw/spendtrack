/**
 * F4 recurring detect — pure (no Prisma), so the route and the tests share one copy.
 *
 * Finds charges that repeat on a cadence and are not yet a RecurringRule:
 *   - group by account + type + currency + a normalised merchant key, 3 or more rows;
 *   - the cadence comes from the LOWER median gap (one missed month must not turn a
 *     monthly bill into "every 45 days"): W 5–9, M 26–35, Q 84–98, Y 350–380 days;
 *   - every amount but the last within 10 % of their median; the last may move up to
 *     50 % and is then flagged as a price change when it differs from the earlier
 *     median by more than 5 % AND more than €1 (same-currency units);
 *   - groups with a row already linked to a rule, or covered by an active rule
 *     (same type, same account or an account-less rule, same merchant key), are skipped,
 *     and so are dismissed keys and groups that stopped (last charge older than two
 *     periods past the cadence's upper bound — a cancelled subscription is not a bill).
 *
 * Nothing here writes; confirming a suggestion creates a rule and LINKS past rows
 * (`recurringId`) — no amount, date, type, currency, account or merchant changes.
 */
import { normalizeMerchant } from "./categorise";
import { advanceByCadence } from "./utils";

export type DetectCadence = "WEEKLY" | "MONTHLY" | "QUARTERLY" | "YEARLY";

export interface DetectRow {
  id: string;
  accountId: string | null;
  merchant: string;
  displayMerchant?: string | null;
  type: "EXPENSE" | "INCOME";
  amount: number; // native, positive
  currency: string;
  date: string; // YYYY-MM-DD (charge date)
  categoryId: string | null;
  recurringId: string | null;
}

export interface DetectRule {
  id: string;
  merchant: string;
  accountId: string | null;
  type: "EXPENSE" | "INCOME";
  active: boolean;
  endDate: string | null; // YYYY-MM-DD
}

export interface PriceChange {
  from: number; // median of the earlier charges
  to: number; // the last charge
  pct: number; // signed, e.g. 0.125 = +12.5 %
}

export interface Suggestion {
  key: string;
  merchant: string; // what the rule would be called: latest display name, else raw merchant
  accountId: string | null;
  type: "EXPENSE" | "INCOME";
  currency: string;
  cadence: DetectCadence;
  count: number;
  gapDays: number; // the lower-median gap the cadence was read from
  amount: number; // last charge — what the rule would post
  typicalAmount: number; // median of the earlier charges
  priceChange: PriceChange | null;
  firstDate: string;
  lastDate: string;
  nextDate: string; // first occurrence after `today`
  anchorDay: number; // the day of month the bill keeps (31 → month-end)
  categoryId: string | null; // most common category of the group
  txnIds: string[]; // oldest first
}

export const CADENCE_GAPS: Record<DetectCadence, [number, number]> = {
  WEEKLY: [5, 9],
  MONTHLY: [26, 35],
  QUARTERLY: [84, 98],
  YEARLY: [350, 380],
};

const AMOUNT_TOLERANCE = 0.1;
const LAST_AMOUNT_MAX_MOVE = 0.5;
const PRICE_CHANGE_PCT = 0.05;
const PRICE_CHANGE_ABS = 1;
const MIN_ROWS = 3;

const DAY = 86_400_000;
const toDay = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
const isoOf = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The merchant part of the group key: normalised, with every token that carries a
 * digit dropped (card refs, order numbers, dates) and cut to three words — so
 * "NETFLIX.COM 866-579 AMSTERDAM" and "Netflix.com Amsterdam" land together.
 */
export function merchantKey(merchant: string): string {
  return normalizeMerchant(merchant)
    .split(" ")
    .filter((t) => t && !/\d/.test(t))
    .slice(0, 3)
    .join(" ");
}

export function groupKey(r: { accountId: string | null; type: string; currency: string; merchant: string }): string {
  return `${r.accountId ?? "-"}|${r.type}|${r.currency.toUpperCase()}|${merchantKey(r.merchant)}`;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return 0;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/** Lower median: for an even count, the smaller middle value. */
function lowerMedian(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
}

export function cadenceForGap(gap: number): DetectCadence | null {
  for (const c of Object.keys(CADENCE_GAPS) as DetectCadence[]) {
    const [lo, hi] = CADENCE_GAPS[c];
    if (gap >= lo && gap <= hi) return c;
  }
  return null;
}

/** Signed price change of `last` against `typical`, or null when it is within 5 % or €1. */
export function priceChangeOf(typical: number, last: number): PriceChange | null {
  if (typical <= 0) return null;
  const diff = last - typical;
  if (Math.abs(diff) <= PRICE_CHANGE_ABS || Math.abs(diff) / typical <= PRICE_CHANGE_PCT) return null;
  return { from: round2(typical), to: round2(last), pct: Math.round((diff / typical) * 10000) / 10000 };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The day of month a monthly-ish bill keeps: the most common day, ties to the later one. */
function anchorDayOf(dates: string[]): number {
  const counts = new Map<number, number>();
  for (const d of dates) {
    const day = new Date(toDay(d)).getUTCDate();
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  let best = 1;
  let bestN = -1;
  for (const [day, n] of counts) if (n > bestN || (n === bestN && day > best)) [best, bestN] = [day, n];
  return best;
}

function coveredByRule(key: string, accountId: string | null, type: string, rules: DetectRule[], today: string): boolean {
  const mk = key.split("|").slice(3).join("|");
  return rules.some((r) => {
    if (!r.active || r.type !== type) return false;
    if (r.endDate && r.endDate < today) return false;
    if (r.accountId && r.accountId !== accountId) return false;
    const rk = merchantKey(r.merchant);
    if (!rk || !mk) return false;
    return rk === mk || mk.startsWith(`${rk} `) || rk.startsWith(`${mk} `);
  });
}

export function detectRecurring(
  rows: DetectRow[],
  rules: DetectRule[],
  dismissed: Iterable<string>,
  today: string,
): Suggestion[] {
  const gone = new Set(dismissed);
  const groups = new Map<string, DetectRow[]>();
  for (const r of rows) {
    if (!(r.amount > 0) || !merchantKey(r.merchant)) continue;
    const k = groupKey(r);
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }

  const out: Suggestion[] = [];
  for (const [key, g] of groups) {
    if (g.length < MIN_ROWS || gone.has(key)) continue;
    if (g.some((r) => r.recurringId)) continue;
    const first = g[0];
    if (coveredByRule(key, first.accountId, first.type, rules, today)) continue;

    const sorted = [...g].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) gaps.push(Math.round((toDay(sorted[i].date) - toDay(sorted[i - 1].date)) / DAY));
    // Two charges on one day are not a cadence (a double charge, or two items).
    if (gaps.some((d) => d === 0)) continue;
    const gap = lowerMedian(gaps);
    const cadence = cadenceForGap(gap);
    if (!cadence) continue;

    const earlier = sorted.slice(0, -1).map((r) => r.amount);
    const typical = median(earlier);
    if (earlier.some((a) => Math.abs(a - typical) > typical * AMOUNT_TOLERANCE)) continue;
    const last = sorted[sorted.length - 1];
    if (Math.abs(last.amount - typical) > typical * LAST_AMOUNT_MAX_MOVE) continue;

    // A bill that stopped is not a bill: last charge more than two periods ago.
    const hi = CADENCE_GAPS[cadence][1];
    if (toDay(today) - toDay(last.date) > 2 * hi * DAY) continue;

    const anchorDay = cadence === "WEEKLY" ? new Date(toDay(last.date)).getUTCDate() : anchorDayOf(sorted.map((r) => r.date));
    let next = new Date(toDay(last.date));
    for (let i = 0; i < 1000 && isoOf(next) <= today; i++) {
      next = advanceByCadence(next, cadence, cadence === "WEEKLY" ? undefined : anchorDay);
    }
    if (isoOf(next) <= today) continue; // safety: never suggest a past next date

    const catCount = new Map<string, number>();
    for (const r of sorted) if (r.categoryId) catCount.set(r.categoryId, (catCount.get(r.categoryId) ?? 0) + 1);
    let categoryId: string | null = null;
    let catN = 0;
    for (const [c, n] of catCount) if (n > catN) [categoryId, catN] = [c, n];

    out.push({
      key,
      merchant: (last.displayMerchant?.trim() || last.merchant).slice(0, 200),
      accountId: first.accountId,
      type: first.type,
      currency: first.currency.toUpperCase(),
      cadence,
      count: sorted.length,
      gapDays: gap,
      amount: round2(last.amount),
      typicalAmount: round2(typical),
      priceChange: priceChangeOf(typical, last.amount),
      firstDate: sorted[0].date.slice(0, 10),
      lastDate: last.date.slice(0, 10),
      nextDate: isoOf(next),
      anchorDay,
      categoryId,
      txnIds: sorted.map((r) => r.id),
    });
  }
  // Soonest bill first, then the biggest.
  return out.sort((a, b) => a.nextDate.localeCompare(b.nextDate) || b.amount - a.amount);
}

/**
 * Price-change badge for an existing rule: the latest linked charge against the
 * rule's own amount (same currency). Null when within 5 % or €1, or nothing linked.
 */
export function rulePriceChange(ruleAmount: number, linked: { amount: number; date: string; currency: string }[], ruleCurrency: string): PriceChange | null {
  const same = linked.filter((l) => l.currency.toUpperCase() === ruleCurrency.toUpperCase());
  if (!same.length) return null;
  const last = [...same].sort((a, b) => b.date.localeCompare(a.date))[0];
  return priceChangeOf(ruleAmount, last.amount);
}
