/**
 * F1 net worth — pure maths (no Prisma, no pg), so it is testable.
 *
 * For a month M (its last day = `monthEnd`):
 *   cash        sum of each non-INVESTMENT account's latest balance with as-of ≤ month-end
 *               (≈EUR at its as-of). Never a sum of imported rows; no balance = missing.
 *   cards       what is OWED: every negative balance (a card is stored negative; an
 *               overdrawn account too) moves here as a positive amount — a liability.
 *   trading     the investment value: sum of the INVESTMENT accounts' latest balances, or
 *               NULL when none is known. Null stays null — it is never 0, and a net
 *               worth without it is marked estimated. INVESTMENT accounts are kept out
 *               of `cash`: this figure covers them.
 *   assets      sum of CAR + ASSET items with as-of ≤ month-end.
 *   liabilities cards + sum of LIABILITY items with as-of ≤ month-end.
 *   net         cash + (trading ?? 0) + assets − liabilities.
 *   reserve     the tax / no-income reserve due at month-end (`reserveDue()`). It is
 *               cash ALREADY in the balances, so it is NOT added or subtracted from
 *               `net`; `netAfterReserve` = net − reserve is shown beside it.
 */
import { STALE_DAYS } from "./balances";

export type NetWorthItemKind = "CAR" | "ASSET" | "LIABILITY";

export interface NwAccount {
  id: string;
  name: string;
  type: string; // AccountType
}

export interface NwBalance {
  accountId: string;
  asOf: string; // YYYY-MM-DD
  /** ≈EUR at its as-of. Negative = owed (cards). */
  eur: number;
}

export interface NwItem {
  id: string;
  kind: NetWorthItemKind;
  name: string;
  /** ≈EUR, positive. */
  eur: number;
  asOf: string;
}

export interface NavPortfolio {
  name: string;
  value: number | null; // EUR
  date: string | null;
  stale: boolean;
}

export interface NavResult {
  /** sum of the portfolios that have a snapshot; null when none could be read. */
  total: number | null;
  portfolios: NavPortfolio[];
  /** Why it is null / partial: "not configured", a connection error, "no snapshot". */
  problem: string | null;
}

export interface NetWorthLine {
  accountId: string;
  name: string;
  eur: number | null;
  asOf: string | null;
  state: "ok" | "stale" | "missing";
}

export interface NetWorthDetail {
  lines: NetWorthLine[];
  items: { id: string; kind: NetWorthItemKind; name: string; eur: number }[];
  trading: NavPortfolio[];
  tradingProblem: string | null;
}

export interface NetWorthResult {
  month: string; // YYYY-MM-01
  cash: number;
  cards: number;
  trading: number | null;
  assets: number;
  liabilities: number;
  reserve: number | null;
  net: number;
  netAfterReserve: number | null;
  /** A balance missing or stale, a trading figure missing or stale. */
  estimated: boolean;
  detail: NetWorthDetail;
}

/** An investment value older than this (days) is stale — same rule as a cash balance. */
export const NAV_STALE_DAYS = STALE_DAYS;
const DAY = 86_400_000;
const toDay = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Last day of the month that `monthIso` (any day in it) falls in, YYYY-MM-DD. */
export function monthEndOf(monthIso: string): string {
  const d = new Date(toDay(monthIso));
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
}

export function monthStartOf(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

/** The last COMPLETE month before `today`, as YYYY-MM-01. */
export function lastCompleteMonth(today: string): string {
  const d = new Date(toDay(today));
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 10);
}

/** The latest balance per account with as-of ≤ `cutoff`. */
export function balancesAsOf(balances: NwBalance[], cutoff: string): Map<string, NwBalance> {
  const out = new Map<string, NwBalance>();
  for (const b of balances) {
    if (b.asOf > cutoff) continue;
    const cur = out.get(b.accountId);
    if (!cur || b.asOf > cur.asOf) out.set(b.accountId, b);
  }
  return out;
}

/**
 * The broker NAV at `cutoff` from the per-portfolio latest snapshots (≤ cutoff). A
 * snapshot older than NAV_STALE_DAYS before min(cutoff, today) is stale; a portfolio with no
 * snapshot is listed with a null value and left out of the total.
 */
export function summariseNav(
  rows: { name: string; date: string | null; value: number | null }[],
  cutoff: string,
  today: string,
): NavResult {
  const ref = cutoff < today ? cutoff : today;
  const portfolios: NavPortfolio[] = rows.map((r) => ({
    name: r.name,
    value: r.value == null ? null : round2(r.value),
    date: r.date,
    stale: r.date != null && (toDay(ref) - toDay(r.date)) / DAY > NAV_STALE_DAYS,
  }));
  const known = portfolios.filter((p) => p.value != null);
  if (!known.length) return { total: null, portfolios, problem: rows.length ? "no snapshot on or before the month end" : "no portfolios" };
  const missing = portfolios.filter((p) => p.value == null).map((p) => p.name);
  return {
    total: round2(known.reduce((s, p) => s + (p.value as number), 0)),
    portfolios,
    problem: missing.length ? `no snapshot for ${missing.join(", ")}` : null,
  };
}

export function computeNetWorth(input: {
  month: string; // any day in the month
  accounts: NwAccount[];
  balances: NwBalance[];
  items: NwItem[];
  nav: NavResult;
  /** Reserve due at month-end; null = no schedule. */
  reserve: number | null;
}): NetWorthResult {
  const month = monthStartOf(input.month);
  const end = monthEndOf(month);
  const latest = balancesAsOf(input.balances, end);

  let cash = 0;
  let cards = 0;
  let estimated = false;
  const lines: NetWorthLine[] = [];
  for (const a of input.accounts) {
    if (a.type === "INVESTMENT") continue; // counted under `trading`
    const b = latest.get(a.id);
    if (!b) {
      lines.push({ accountId: a.id, name: a.name, eur: null, asOf: null, state: "missing" });
      estimated = true;
      continue;
    }
    const stale = (toDay(end) - toDay(b.asOf)) / DAY > STALE_DAYS;
    if (stale) estimated = true;
    if (b.eur < 0) cards += -b.eur;
    else cash += b.eur;
    lines.push({ accountId: a.id, name: a.name, eur: round2(b.eur), asOf: b.asOf, state: stale ? "stale" : "ok" });
  }

  const items = input.items.filter((i) => i.asOf <= end);
  const assets = items.filter((i) => i.kind !== "LIABILITY").reduce((s, i) => s + i.eur, 0);
  const otherDebt = items.filter((i) => i.kind === "LIABILITY").reduce((s, i) => s + i.eur, 0);
  const liabilities = cards + otherDebt;

  const trading = input.nav.total;
  if (trading == null || input.nav.problem || input.nav.portfolios.some((p) => p.stale)) estimated = true;

  const net = round2(cash + (trading ?? 0) + assets - liabilities);
  return {
    month,
    cash: round2(cash),
    cards: round2(cards),
    trading,
    assets: round2(assets),
    liabilities: round2(liabilities),
    reserve: input.reserve == null ? null : round2(input.reserve),
    net,
    netAfterReserve: input.reserve == null ? null : round2(net - input.reserve),
    estimated,
    detail: {
      lines,
      items: items.map((i) => ({ id: i.id, kind: i.kind, name: i.name, eur: round2(i.eur) })),
      trading: input.nav.portfolios,
      tradingProblem: input.nav.problem,
    },
  };
}

/** Snapshots → CSV rows (header first). Trading null is written as an empty cell, never 0. */
export function netWorthCsvRows(
  snaps: { month: string; cash: number; cards: number; trading: number | null; assets: number; liabilities: number; reserve: number | null; net: number; estimated: boolean }[],
): (string | number | null)[][] {
  return [
    ["Month", "Cash (EUR)", "Cards owed (EUR)", "Investments (EUR)", "Assets (EUR)", "Liabilities (EUR)", "Net worth (EUR)", "Tax reserve (EUR)", "Net after reserve (EUR)", "Estimated"],
    ...snaps.map((s) => [
      s.month.slice(0, 7),
      s.cash,
      s.cards,
      s.trading,
      s.assets,
      s.liabilities,
      s.net,
      s.reserve,
      s.reserve == null ? null : round2(s.net - s.reserve),
      s.estimated ? "yes" : "no",
    ]),
  ];
}
