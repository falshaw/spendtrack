/**
 * Investments — pure maths (no Prisma), so it is testable.
 *
 * Double counting, the two places it could happen:
 *
 *  1. Net worth. An INVESTMENT account's typed/statement balance is already counted under
 *     `trading`. A broker connection LINKED to that account (BrokerConnection.accountId)
 *     replaces the account's row with the synced value; an unlinked connection is its own
 *     row. So one portfolio is never counted twice — `brokerNavRows()`.
 *
 *  2. Income. A broker statement imported as transactions (the Trading 212 CSV reader
 *     files dividends as INCOME rows named "Dividend <ticker>") is already income. A
 *     synced dividend is only ADDED to income when no imported dividend row matches it —
 *     `unmatchedDividends()`. The imported row wins because it sits in the user's
 *     reviewed, statement-reconciled ledger; the sync only fills what was not imported.
 */
import { CATEGORICAL, CHART } from "@/components/charts/theme";

const DAY = 86_400_000;
const toDay = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
const r2 = (n: number) => Math.round(n * 100) / 100;

// ─── dividends vs imported statement rows ───────────────────────────────

export interface SyncedDividendIn {
  id: string;
  paidOn: string; // YYYY-MM-DD
  eur: number;
  symbol: string;
  /** The INVESTMENT account the connection is linked to, if any. */
  accountId: string | null;
}

export interface ImportedIncomeIn {
  id: string;
  date: string; // YYYY-MM-DD (the period date)
  eur: number;
  merchant: string;
  accountId: string | null;
}

/** Imported rows that can stand for a broker dividend. */
export const DIVIDEND_MERCHANT = /\bdividends?\b/i;
/** A booking and its statement line may be a few days apart (pay date vs value date). */
export const DIVIDEND_MATCH_DAYS = 3;

/** Amount tolerance: two conversions of the same payment can differ by FX rounding. */
function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(0.05, Math.abs(a) * 0.02);
}

/**
 * Synced dividends that are NOT already in the ledger as an imported transaction.
 * A match = an imported INCOME row whose merchant says "dividend", within
 * DIVIDEND_MATCH_DAYS days and the same ≈EUR amount — on the linked account when the
 * connection is linked, on any account otherwise. Each imported row matches at most
 * one dividend (the closest in time).
 */
export function unmatchedDividends<T extends SyncedDividendIn>(
  synced: T[],
  imported: ImportedIncomeIn[],
): { kept: T[]; matched: { dividendId: string; transactionId: string }[] } {
  const pool = imported.filter((t) => DIVIDEND_MERCHANT.test(t.merchant));
  const used = new Set<string>();
  const kept: T[] = [];
  const matched: { dividendId: string; transactionId: string }[] = [];
  const ordered = [...synced].sort((a, b) => (a.paidOn < b.paidOn ? -1 : a.paidOn > b.paidOn ? 1 : 0));
  for (const d of ordered) {
    let best: ImportedIncomeIn | null = null;
    let bestGap = Infinity;
    for (const t of pool) {
      if (used.has(t.id)) continue;
      if (d.accountId && t.accountId !== d.accountId) continue;
      const gap = Math.abs(toDay(t.date) - toDay(d.paidOn)) / DAY;
      if (gap > DIVIDEND_MATCH_DAYS || !close(d.eur, t.eur)) continue;
      // The statement reader names the row "Dividend <TICKER>": a ticker that is
      // ANOTHER symbol is not this payment. Free text ("Dividend payment") still matches.
      const ticker = /^Dividend ([A-Z0-9.-]{1,12})$/.exec(t.merchant.trim())?.[1];
      if (ticker && d.symbol && ticker !== d.symbol.toUpperCase()) continue;
      if (gap < bestGap) {
        best = t;
        bestGap = gap;
      }
    }
    if (best) {
      used.add(best.id);
      matched.push({ dividendId: d.id, transactionId: best.id });
    } else kept.push(d);
  }
  return { kept, matched };
}

/** ≈EUR per YYYY-MM. */
export function byMonth(rows: { date: string; eur: number }[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.date.slice(0, 7), r2((out.get(r.date.slice(0, 7)) ?? 0) + r.eur));
  return out;
}

/** Add investment income per month to trend points (keyed by `monthRef` YYYY-MM). */
export function addIncomeToTrend<P extends { monthRef: string; income: number }>(trend: P[], monthly: Map<string, number>): P[] {
  return trend.map((p) => {
    const add = monthly.get(p.monthRef) ?? 0;
    return add ? { ...p, income: Math.round(p.income + add) } : p;
  });
}

// ─── net worth ──────────────────────────────────────────────────────────

export interface NavRowIn {
  /** Set on a row that comes from an INVESTMENT account. */
  accountId?: string;
  name: string;
  date: string | null;
  value: number | null;
}

export interface BrokerNavIn {
  label: string;
  /** Linked INVESTMENT account — its balance row is replaced, not added to. */
  accountId: string | null;
  date: string | null;
  /** ≈EUR at `date`; null = no value on or before the cut-off. */
  value: number | null;
}

/**
 * The portfolio rows net worth sums: every INVESTMENT account, except that an account a
 * broker connection is linked to shows the broker's synced value instead (when it has
 * one). A connection with no value yet adds nothing and replaces nothing.
 */
export function brokerNavRows(accounts: NavRowIn[], brokers: BrokerNavIn[]): { name: string; date: string | null; value: number | null }[] {
  const withValue = brokers.filter((b) => b.value != null && b.date != null);
  const byAccount = new Map(withValue.filter((b) => b.accountId).map((b) => [b.accountId as string, b]));
  const rows = accounts.map((a) => {
    const b = a.accountId ? byAccount.get(a.accountId) : undefined;
    return b ? { name: `${a.name} (${b.label})`, date: b.date, value: b.value } : { name: a.name, date: a.date, value: a.value };
  });
  const linkedHere = new Set(accounts.map((a) => a.accountId).filter(Boolean));
  for (const b of withValue) {
    if (b.accountId && linkedHere.has(b.accountId)) continue;
    rows.push({ name: b.label, date: b.date, value: b.value });
  }
  return rows;
}

// ─── portfolio figures ──────────────────────────────────────────────────

export interface HoldingEur {
  symbol: string;
  name: string | null;
  eur: number | null;
  pnlEur: number | null;
}

export interface AllocationSlice {
  name: string;
  value: number;
  color: string;
}

/** Holdings by ≈EUR value, largest first, palette in order; the tail folds into "Other". */
export function allocation(holdings: HoldingEur[], cashEur = 0, maxSlices = 6): AllocationSlice[] {
  const by = new Map<string, number>();
  for (const h of holdings) if (h.eur != null && h.eur > 0) by.set(h.symbol, (by.get(h.symbol) ?? 0) + h.eur);
  const sorted = [...by.entries()].map(([name, value]) => ({ name, value: r2(value) })).sort((a, b) => b.value - a.value);
  const head = sorted.slice(0, maxSlices).map((s, i) => ({ ...s, color: CATEGORICAL[i % CATEGORICAL.length] }));
  const tail = sorted.slice(maxSlices).reduce((s, x) => s + x.value, 0);
  const out: AllocationSlice[] = [...head];
  if (tail > 0) out.push({ name: `Other (${sorted.length - maxSlices})`, value: r2(tail), color: CHART.neutral });
  if (cashEur > 0.005) out.push({ name: "Cash", value: r2(cashEur), color: "#7a6467" });
  return out;
}

export interface ValuePoint {
  date: string; // YYYY-MM-DD
  eur: number;
}

/**
 * One total line from several connections' histories. On each date that any connection
 * reports, every connection contributes its latest value on or before that date (an
 * account that did not report that day has not gone to zero).
 */
export function combineHistory(series: ValuePoint[][]): ValuePoint[] {
  const dates = [...new Set(series.flat().map((p) => p.date))].sort();
  const sorted = series.map((s) => [...s].sort((a, b) => (a.date < b.date ? -1 : 1)));
  const idx = sorted.map(() => -1);
  const out: ValuePoint[] = [];
  for (const d of dates) {
    let total = 0;
    sorted.forEach((s, i) => {
      while (idx[i] + 1 < s.length && s[idx[i] + 1].date <= d) idx[i]++;
      if (idx[i] >= 0) total += s[idx[i]].eur;
    });
    out.push({ date: d, eur: r2(total) });
  }
  return out;
}

/** Change from the previous recorded value to the latest; null with fewer than two points. */
export function lastChange(history: ValuePoint[]): { abs: number; pct: number | null; since: string } | null {
  if (history.length < 2) return null;
  const last = history[history.length - 1];
  const prev = history[history.length - 2];
  const abs = r2(last.eur - prev.eur);
  return { abs, pct: prev.eur ? Math.round((abs / prev.eur) * 10_000) / 100 : null, since: prev.date };
}

/** Sum of unrealised P/L and the cost it is measured against (value − P/L). */
export function unrealised(holdings: HoldingEur[]): { pnl: number | null; cost: number | null; pct: number | null } {
  const known = holdings.filter((h) => h.pnlEur != null && h.eur != null);
  if (!known.length) return { pnl: null, cost: null, pct: null };
  const pnl = r2(known.reduce((s, h) => s + (h.pnlEur as number), 0));
  const cost = r2(known.reduce((s, h) => s + (h.eur as number) - (h.pnlEur as number), 0));
  return { pnl, cost, pct: cost > 0 ? Math.round((pnl / cost) * 10_000) / 100 : null };
}

// ─── income page ────────────────────────────────────────────────────────

export const DIVIDEND_SOURCE = { name: "Dividends (broker sync)", color: "#5a9a2c" } as const;

interface IncomeOverviewLike {
  year: number;
  totalYtd: number;
  monthsWithIncome: number;
  bySource: { name: string; color: string; value: number }[];
  byMonth: { monthIndex: number; actual: number; projected: number; label: string }[];
  projection: { receivedYtd: number; remainingSalary: number; remainingPayments: number; projectedTotal: number } | null;
  trend: { monthRef: string; income: number; expense: number; label: string }[];
}

/**
 * The income overview with synced dividends (already de-duplicated against imported
 * rows, `monthly` = YYYY-MM → ≈EUR) folded in: received this year, its own source line,
 * the month bars, the projection's received part and the 12-month trend.
 */
export function withDividendIncome<O extends IncomeOverviewLike>(ov: O, monthly: Map<string, number>): O {
  const yearKey = String(ov.year);
  let ytd = 0;
  const months = new Set<number>();
  const byMonth = ov.byMonth.map((m) => {
    const add = monthly.get(`${yearKey}-${String(m.monthIndex + 1).padStart(2, "0")}`) ?? 0;
    if (!add) return m;
    ytd += add;
    months.add(m.monthIndex);
    return { ...m, actual: r2(m.actual + add) };
  });
  ytd = r2(ytd);
  if (!ytd) return { ...ov, trend: addIncomeToTrend(ov.trend, monthly) };
  const hadIncome = new Set(ov.byMonth.filter((m) => m.actual > 0).map((m) => m.monthIndex));
  const newMonths = [...months].filter((i) => !hadIncome.has(i)).length;
  return {
    ...ov,
    totalYtd: r2(ov.totalYtd + ytd),
    monthsWithIncome: ov.monthsWithIncome + newMonths,
    bySource: [...ov.bySource, { ...DIVIDEND_SOURCE, value: ytd }].sort((a, b) => b.value - a.value),
    byMonth,
    projection: ov.projection
      ? { ...ov.projection, receivedYtd: r2(ov.projection.receivedYtd + ytd), projectedTotal: r2(ov.projection.projectedTotal + ytd) }
      : null,
    trend: addIncomeToTrend(ov.trend, monthly),
  };
}
