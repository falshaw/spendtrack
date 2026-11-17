/**
 * Investments — loaders (Prisma). The maths is in investments.ts; the broker sync in
 * broker-sync.ts. Every figure is converted to ≈EUR with the app's FX (`toEur`, the ECB
 * fixing of the value's own date). A currency with no rate is left out and reported in
 * `problems`, never counted 1:1.
 */
import { prisma } from "./prisma";
import { hasRate, toEur } from "./currency";
import { ensureFxRates } from "./fx";
import { dec } from "./utils";
import type { Scope } from "./finance";
import { BROKER_LABEL, brokerConfigs, maySync } from "./broker-sync";
import {
  allocation,
  type AllocationSlice,
  type BrokerNavIn,
  byMonth,
  combineHistory,
  DIVIDEND_MATCH_DAYS,
  lastChange,
  unmatchedDividends,
  unrealised,
  type ValuePoint,
} from "./investments";

const iso = (d: Date) => d.toISOString().slice(0, 10);
const at = (s: string) => new Date(`${s}T00:00:00Z`);
const r2 = (n: number) => Math.round(n * 100) / 100;

type BrokerKey = "TRADING212" | "IBKR" | "MANUAL";

/** ≈EUR, or null (+ a problem line) when the currency has no rate. */
function eurOrNull(amount: number, currency: string, date: Date | string | null, problems: Set<string>): number | null {
  if (!hasRate(currency)) {
    problems.add(`no EUR rate for ${currency} — those values are left out`);
    return null;
  }
  return toEur(amount, currency, date);
}

// ─── net worth ──────────────────────────────────────────────────────────

/** Each connection's latest value on or before `cutoff`, ≈EUR at that date. */
export async function brokerNavInputs(userId: string, cutoff: string): Promise<BrokerNavIn[]> {
  const [conns, values] = await Promise.all([
    prisma.brokerConnection.findMany({
      where: { userId },
      select: { id: true, label: true, accountId: true, baseCurrency: true, totalValue: true, asOf: true },
    }),
    prisma.portfolioValue.findMany({
      where: { userId, date: { lte: at(cutoff) } },
      select: { connectionId: true, date: true, value: true, currency: true },
    }),
  ]);
  const latest = new Map<string, { date: Date; value: number; currency: string }>();
  for (const v of values) {
    const cur = latest.get(v.connectionId);
    if (!cur || v.date > cur.date) latest.set(v.connectionId, { date: v.date, value: dec(v.value), currency: v.currency });
  }
  const problems = new Set<string>();
  return conns.map((c) => {
    const l =
      latest.get(c.id) ??
      (c.totalValue != null && c.asOf && iso(c.asOf) <= cutoff ? { date: c.asOf, value: dec(c.totalValue), currency: c.baseCurrency } : null);
    const eur = l ? eurOrNull(l.value, l.currency, l.date, problems) : null;
    return { label: c.label, accountId: c.accountId, date: l && eur != null ? iso(l.date) : null, value: eur == null ? null : r2(eur) };
  });
}

// ─── income ─────────────────────────────────────────────────────────────

export interface DividendIncome {
  /** ≈EUR of the synced dividends that are not already imported transactions. */
  total: number;
  /** YYYY-MM → ≈EUR. */
  monthly: Map<string, number>;
  /** Dividends left out because an imported transaction already carries them. */
  matched: number;
  problems: string[];
}

/** Does a connection fall in `scope`? Linked account's scope; unlinked = personal. */
function inScope(scope: Scope, biz: "PERSONAL" | "BUSINESS" | null | undefined): boolean {
  if (scope === "all") return true;
  return scope === "business" ? biz === "BUSINESS" : biz !== "BUSINESS";
}

/**
 * Synced dividends paid in [start, end) that count as investment income in `scope`,
 * minus those already in the ledger as imported dividend rows (`unmatchedDividends`).
 */
export async function getDividendIncome(userId: string, start: Date, end: Date, scope: Scope = "all"): Promise<DividendIncome> {
  await ensureFxRates();
  const pad = DIVIDEND_MATCH_DAYS * 86_400_000;
  const [divs, imported] = await Promise.all([
    prisma.investmentDividend.findMany({
      where: { userId, paidOn: { gte: start, lt: end } },
      select: {
        id: true,
        symbol: true,
        paidOn: true,
        amount: true,
        currency: true,
        connection: { select: { accountId: true, account: { select: { biz: true } } } },
      },
    }),
    prisma.transaction.findMany({
      where: {
        userId,
        type: "INCOME",
        merchant: { contains: "ividend", mode: "insensitive" },
        date: { gte: new Date(start.getTime() - pad), lt: new Date(end.getTime() + pad) },
      },
      select: { id: true, date: true, amount: true, currency: true, merchant: true, accountId: true },
    }),
  ]);
  const problems = new Set<string>();
  const synced = divs
    .filter((d) => inScope(scope, d.connection.account?.biz))
    .map((d) => ({
      id: d.id,
      paidOn: iso(d.paidOn),
      symbol: d.symbol,
      accountId: d.connection.accountId,
      eur: eurOrNull(dec(d.amount), d.currency, d.paidOn, problems),
    }))
    .filter((d): d is typeof d & { eur: number } => d.eur != null);
  const ledger = imported.flatMap((t) => {
    const eur = eurOrNull(dec(t.amount), t.currency, t.date, problems);
    return eur == null ? [] : [{ id: t.id, date: iso(t.date), eur, merchant: t.merchant, accountId: t.accountId }];
  });
  const { kept, matched } = unmatchedDividends(synced, ledger);
  const rows = kept.map((d) => ({ date: d.paidOn, eur: d.eur }));
  return {
    total: r2(rows.reduce((s, r) => s + r.eur, 0)),
    monthly: byMonth(rows),
    matched: matched.length,
    problems: [...problems],
  };
}

// ─── overview (the /investments page + GET /api/investments) ────────────

export interface ConnectionView {
  broker: BrokerKey;
  label: string;
  /** Credentials present; null for MANUAL (nothing to configure). */
  configured: boolean | null;
  env: string[];
  exists: boolean;
  status: "NEVER" | "OK" | "PARTIAL" | "ERROR";
  lastSyncAt: string | null;
  lastSyncMessage: string | null;
  asOf: string | null;
  baseCurrency: string;
  totalEur: number | null;
  cashEur: number | null;
  accountId: string | null;
  holdings: number;
}

export interface HoldingView {
  id: string;
  broker: BrokerKey;
  brokerLabel: string;
  symbol: string;
  name: string | null;
  quantity: number;
  avgCost: number;
  price: number | null;
  currency: string;
  value: number | null;
  baseCurrency: string;
  eur: number | null;
  pnlEur: number | null;
  weight: number | null;
}

export interface DividendView {
  id: string;
  brokerLabel: string;
  symbol: string;
  paidOn: string;
  amount: number;
  currency: string;
  withholdingTax: number | null;
  eur: number | null;
}

export interface TradeView {
  id: string;
  brokerLabel: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  price: number;
  fees: number;
  currency: string;
  executedAt: string;
}

export interface FlowView {
  id: string;
  brokerLabel: string;
  date: string;
  kind: "DEPOSIT" | "WITHDRAWAL";
  amount: number;
  currency: string;
  note: string | null;
  eur: number | null;
}

export interface InvestmentsOverview {
  connections: ConnectionView[];
  hasData: boolean;
  totalEur: number | null;
  cashEur: number;
  holdingsEur: number;
  pnl: { pnl: number | null; cost: number | null; pct: number | null };
  change: { abs: number; pct: number | null; since: string } | null;
  allocation: AllocationSlice[];
  history: ValuePoint[];
  holdings: HoldingView[];
  dividends: DividendView[];
  dividendsYtdEur: number;
  trades: TradeView[];
  flows: FlowView[];
  netDepositsEur: number;
  accounts: { id: string; name: string }[];
  sync: { allowed: boolean; reason: string | null };
  problems: string[];
}

const LIST_LIMIT = 100;

export async function getInvestmentsOverview(userId: string, now: Date = new Date()): Promise<InvestmentsOverview> {
  await ensureFxRates();
  const today = iso(now);
  const yearStart = at(`${today.slice(0, 4)}-01-01`);
  const [conns, holdings, values, dividends, trades, flows, accounts, sync] = await Promise.all([
    prisma.brokerConnection.findMany({ where: { userId }, orderBy: { broker: "asc" }, include: { _count: { select: { holdings: true } } } }),
    prisma.investmentHolding.findMany({ where: { userId }, include: { connection: { select: { broker: true, label: true, baseCurrency: true, asOf: true } } } }),
    prisma.portfolioValue.findMany({ where: { userId }, orderBy: { date: "asc" }, select: { connectionId: true, date: true, value: true, currency: true } }),
    prisma.investmentDividend.findMany({ where: { userId }, orderBy: { paidOn: "desc" }, include: { connection: { select: { label: true } } } }),
    prisma.investmentTrade.findMany({ where: { userId }, orderBy: { executedAt: "desc" }, take: LIST_LIMIT, include: { connection: { select: { label: true } } } }),
    prisma.investmentCashFlow.findMany({ where: { userId }, orderBy: { date: "desc" }, include: { connection: { select: { label: true } } } }),
    prisma.account.findMany({ where: { userId, type: "INVESTMENT", isArchived: false }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    maySync(userId),
  ]);
  const problems = new Set<string>();

  const configs = new Map(brokerConfigs().map((c) => [c.broker as BrokerKey, c]));
  const order: BrokerKey[] = ["TRADING212", "IBKR", "MANUAL"];
  const byBroker = new Map(conns.map((c) => [c.broker as BrokerKey, c]));
  const connections: ConnectionView[] = order.map((b) => {
    const c = byBroker.get(b);
    const cfg = configs.get(b);
    const date = c?.asOf ?? null;
    const totalEur = c?.totalValue != null ? eurOrNull(dec(c.totalValue), c.baseCurrency, date, problems) : null;
    const cashEur = c?.cash != null ? eurOrNull(dec(c.cash), c.baseCurrency, date, problems) : null;
    return {
      broker: b,
      label: c?.label ?? BROKER_LABEL[b],
      configured: b === "MANUAL" ? null : !!cfg?.configured,
      env: cfg?.env ?? [],
      exists: !!c,
      status: c?.status ?? "NEVER",
      lastSyncAt: c?.lastSyncAt?.toISOString() ?? null,
      lastSyncMessage: c?.lastSyncMessage ?? null,
      asOf: date ? iso(date) : null,
      baseCurrency: c?.baseCurrency ?? "EUR",
      totalEur: totalEur == null ? null : r2(totalEur),
      cashEur: cashEur == null ? null : r2(cashEur),
      accountId: c?.accountId ?? null,
      holdings: c?._count.holdings ?? 0,
    };
  });

  const holdingViews: HoldingView[] = holdings.map((h) => {
    const date = h.connection.asOf ?? now;
    const value = h.value == null ? null : dec(h.value);
    const eur = value == null ? null : eurOrNull(value, h.connection.baseCurrency, date, problems);
    const pnl = h.unrealisedPnl == null ? null : eurOrNull(dec(h.unrealisedPnl), h.connection.baseCurrency, date, problems);
    return {
      id: h.id,
      broker: h.connection.broker as BrokerKey,
      brokerLabel: h.connection.label,
      symbol: h.symbol,
      name: h.name,
      quantity: dec(h.quantity),
      avgCost: dec(h.avgCost),
      price: h.price == null ? null : dec(h.price),
      currency: h.currency,
      value,
      baseCurrency: h.connection.baseCurrency,
      eur: eur == null ? null : r2(eur),
      pnlEur: pnl == null ? null : r2(pnl),
      weight: null,
    };
  });
  const holdingsEur = r2(holdingViews.reduce((s, h) => s + (h.eur ?? 0), 0));
  for (const h of holdingViews) h.weight = h.eur != null && holdingsEur > 0 ? Math.round((h.eur / holdingsEur) * 1000) / 10 : null;
  holdingViews.sort((a, b) => (b.eur ?? 0) - (a.eur ?? 0));

  const cashEur = r2(connections.reduce((s, c) => s + (c.cashEur ?? 0), 0));
  const withTotal = connections.filter((c) => c.totalEur != null);
  const totalEur = withTotal.length ? r2(withTotal.reduce((s, c) => s + (c.totalEur as number), 0)) : null;

  const series = new Map<string, ValuePoint[]>();
  for (const v of values) {
    const eur = eurOrNull(dec(v.value), v.currency, v.date, problems);
    if (eur == null) continue;
    series.set(v.connectionId, [...(series.get(v.connectionId) ?? []), { date: iso(v.date), eur: r2(eur) }]);
  }
  const history = combineHistory([...series.values()]);

  const dividendViews: DividendView[] = dividends.map((d) => {
    const eur = eurOrNull(dec(d.amount), d.currency, d.paidOn, problems);
    return {
      id: d.id,
      brokerLabel: d.connection.label,
      symbol: d.symbol,
      paidOn: iso(d.paidOn),
      amount: dec(d.amount),
      currency: d.currency,
      withholdingTax: d.withholdingTax == null ? null : dec(d.withholdingTax),
      eur: eur == null ? null : r2(eur),
    };
  });
  const dividendsYtdEur = r2(dividendViews.filter((d) => d.paidOn >= iso(yearStart)).reduce((s, d) => s + (d.eur ?? 0), 0));

  const flowViews: FlowView[] = flows.map((f) => {
    const eur = eurOrNull(dec(f.amount), f.currency, f.date, problems);
    return {
      id: f.id,
      brokerLabel: f.connection.label,
      date: iso(f.date),
      kind: f.kind,
      amount: dec(f.amount),
      currency: f.currency,
      note: f.note,
      eur: eur == null ? null : r2(eur),
    };
  });
  const netDepositsEur = r2(flowViews.reduce((s, f) => s + (f.eur ?? 0) * (f.kind === "DEPOSIT" ? 1 : -1), 0));

  return {
    connections,
    hasData: conns.length > 0 && (holdings.length > 0 || values.length > 0),
    totalEur,
    cashEur,
    holdingsEur,
    pnl: unrealised(holdingViews),
    change: lastChange(history),
    allocation: allocation(holdingViews, cashEur),
    history,
    holdings: holdingViews,
    dividends: dividendViews.slice(0, LIST_LIMIT),
    dividendsYtdEur,
    trades: trades.map((t) => ({
      id: t.id,
      brokerLabel: t.connection.label,
      symbol: t.symbol,
      side: t.side,
      quantity: dec(t.quantity),
      price: dec(t.price),
      fees: dec(t.fees),
      currency: t.currency,
      executedAt: t.executedAt.toISOString(),
    })),
    flows: flowViews.slice(0, LIST_LIMIT),
    netDepositsEur,
    accounts,
    sync: { allowed: sync.ok, reason: sync.reason ?? null },
    problems: [...problems],
  };
}

// ─── dashboard card ─────────────────────────────────────────────────────

export interface PortfolioSummary {
  hasData: boolean;
  totalEur: number | null;
  change: { abs: number; pct: number | null; since: string } | null;
  pnl: { pnl: number | null; pct: number | null };
  connected: number;
  asOf: string | null;
}

export async function getPortfolioSummary(userId: string, now: Date = new Date()): Promise<PortfolioSummary> {
  const o = await getInvestmentsOverview(userId, now);
  const dates = o.connections.map((c) => c.asOf).filter((d): d is string => !!d).sort();
  return {
    hasData: o.hasData,
    totalEur: o.totalEur,
    change: o.change,
    pnl: { pnl: o.pnl.pnl, pct: o.pnl.pct },
    connected: o.connections.filter((c) => c.configured).length,
    asOf: dates.length ? dates[dates.length - 1] : null,
  };
}

// ─── manual holdings ────────────────────────────────────────────────────

/**
 * Recompute the MANUAL connection's value (≈EUR: quantity × price per holding) and record
 * today's point in the value history. Called after every manual holding change.
 */
export async function refreshManualTotals(userId: string, now: Date = new Date()): Promise<void> {
  await ensureFxRates();
  const conn = await prisma.brokerConnection.findUnique({ where: { userId_broker: { userId, broker: "MANUAL" } } });
  if (!conn) return;
  const holdings = await prisma.investmentHolding.findMany({ where: { connectionId: conn.id } });
  const today = at(iso(now));
  let total = 0;
  for (const h of holdings) {
    const price = h.price == null ? dec(h.avgCost) : dec(h.price);
    const value = r2(toEur(dec(h.quantity) * price, h.currency, today));
    const pnl = r2(value - toEur(dec(h.quantity) * dec(h.avgCost), h.currency, today));
    total += value;
    await prisma.investmentHolding.update({ where: { id: h.id }, data: { value, unrealisedPnl: pnl } });
  }
  total = r2(total);
  await prisma.$transaction([
    prisma.brokerConnection.update({
      where: { id: conn.id },
      data: { baseCurrency: "EUR", totalValue: total, cash: 0, asOf: today, status: "OK", lastSyncAt: now, lastSyncMessage: null },
    }),
    prisma.portfolioValue.upsert({
      where: { connectionId_date: { connectionId: conn.id, date: today } },
      create: { userId, connectionId: conn.id, date: today, value: total, cash: 0, currency: "EUR" },
      update: { value: total, cash: 0, currency: "EUR" },
    }),
  ]);
}
