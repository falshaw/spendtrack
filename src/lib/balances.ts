/**
 * Account balances — pure, so it is testable without a database. Used by the
 * /balances page and the dashboard's "safe to draw" tile.
 *
 * A balance is the figure a bank PRINTED as the closing balance of a statement, or
 * one you typed in. It is never derived from summed transactions: imported rows
 * have no opening balance, so their net flow is not a balance (summed rows can
 * show a large negative figure for a card whose statement balance is small).
 */

/** An as-of older than this many days is shown as stale. */
export const STALE_DAYS = 35;

export type BalanceState = "missing" | "stale" | "fresh";

const DAY = 86_400_000;
const isoMs = (iso: string) => Date.parse(iso + "T00:00:00Z");

/** Whole days from `asOf` to `today` (both YYYY-MM-DD). */
export function ageDays(asOf: string, today: string): number {
  return Math.round((isoMs(today) - isoMs(asOf)) / DAY);
}

export function balanceState(asOf: string | null, today: string, staleDays: number = STALE_DAYS): BalanceState {
  if (!asOf) return "missing";
  return ageDays(asOf, today) > staleDays ? "stale" : "fresh";
}

/** The newest row per account (by as-of date). */
export function latestByAccount<T extends { accountId: string; asOf: string }>(rows: T[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const r of rows) {
    const cur = out.get(r.accountId);
    if (!cur || r.asOf > cur.asOf) out.set(r.accountId, r);
  }
  return out;
}
