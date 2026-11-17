/**
 * Broker data → SpendTrack rows, pure (no Prisma, no fetch), so it is testable.
 *
 *  - Trading 212 public API v0 (`/equity/account/summary`, `/equity/positions` and the
 *    paged `/equity/history/*` lists).
 *  - Interactive Brokers Flex Web Service: an Activity Flex report (XML, every value an
 *    attribute). Sections used when the query includes them: AccountInformation,
 *    CashReport, OpenPositions, Trades, CashTransactions, EquitySummaryInBase.
 *
 * Money on a snapshot and its positions is in the account's BASE currency; trades,
 * dividends and cash flows keep the currency they were booked in.
 */

export type BrokerCode = "TRADING212" | "IBKR";

export interface SyncedPosition {
  symbol: string;
  name: string | null;
  quantity: number;
  /** Average cost per share, instrument currency. */
  avgCost: number;
  /** Instrument currency. */
  currency: string;
  price: number | null;
  /** Base currency. */
  value: number | null;
  /** Base currency. */
  unrealisedPnl: number | null;
}

export interface SyncedTrade {
  externalId: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  price: number;
  fees: number;
  currency: string;
  executedAt: Date;
}

export interface SyncedDividend {
  externalId: string;
  symbol: string;
  paidOn: Date;
  quantity: number | null;
  /** Net cash booked (after withholding tax). */
  amount: number;
  withholdingTax: number | null;
  currency: string;
}

export interface SyncedFlow {
  externalId: string;
  date: Date;
  kind: "DEPOSIT" | "WITHDRAWAL";
  /** Positive. */
  amount: number;
  currency: string;
  note: string | null;
}

export interface SyncedValue {
  date: Date;
  value: number;
  cash: number | null;
}

export interface BrokerSnapshot {
  baseCurrency: string;
  cash: number;
  totalValue: number;
  /** The day the data describes. */
  asOf: Date;
  positions: SyncedPosition[];
  trades: SyncedTrade[];
  dividends: SyncedDividend[];
  flows: SyncedFlow[];
  /** Daily account value history, when the broker provides one. */
  values: SyncedValue[];
  /** Non-fatal notes: a section that could not be read, a history cut short. */
  notes: string[];
}

const finite = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : null;
};
const round = (n: number, dp: number) => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};
const dayOf = (d: Date) => new Date(`${d.toISOString().slice(0, 10)}T00:00:00Z`);
const ccy = (v: unknown, fallback: string) => {
  const s = String(v ?? "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(s) ? s : fallback;
};

// ─── Trading 212 ────────────────────────────────────────────────────────

export interface T212Summary {
  currency?: string;
  totalValue?: number;
  cash?: { availableToTrade?: number; reservedForOrders?: number; inPies?: number };
  investments?: { currentValue?: number };
}

export interface T212Position {
  instrument?: { ticker?: string; name?: string; currency?: string };
  ticker?: string;
  quantity?: number;
  averagePricePaid?: number;
  averagePrice?: number;
  currentPrice?: number;
  walletImpact?: { currentValue?: number; unrealizedProfitLoss?: number };
}

/** "AAPL_US_EQ" → "AAPL", "VUSAl_EQ" → "VUSA" (the lower-case suffix is the exchange). */
export function t212Symbol(t212Ticker: string): string {
  const base = t212Ticker.split("_")[0];
  return base.replace(/[a-z]+$/, "") || base;
}

export function mapT212Snapshot(summary: T212Summary, positions: T212Position[], asOf: Date): BrokerSnapshot {
  const base = ccy(summary.currency, "EUR");
  const cash = summary.cash?.availableToTrade ?? 0;
  const mapped: SyncedPosition[] = positions
    .filter((p) => (finite(p.quantity) ?? 0) > 0)
    .map((p) => ({
      symbol: t212Symbol(p.instrument?.ticker ?? p.ticker ?? "?"),
      name: p.instrument?.name?.slice(0, 120) ?? null,
      quantity: finite(p.quantity) ?? 0,
      avgCost: finite(p.averagePricePaid ?? p.averagePrice) ?? 0,
      currency: ccy(p.instrument?.currency, base),
      price: finite(p.currentPrice),
      value: finite(p.walletImpact?.currentValue),
      unrealisedPnl: finite(p.walletImpact?.unrealizedProfitLoss),
    }));
  const holdings = mapped.reduce((s, p) => s + (p.value ?? 0), 0);
  const totalValue = finite(summary.totalValue) ?? round(cash + holdings, 2);
  return {
    baseCurrency: base,
    cash,
    totalValue,
    asOf: dayOf(asOf),
    positions: mapped,
    trades: [],
    dividends: [],
    flows: [],
    values: [{ date: dayOf(asOf), value: totalValue, cash }],
    notes: [],
  };
}

export interface T212Tax {
  quantity?: number;
}

export interface T212HistoricalOrder {
  order?: {
    id?: number | string;
    ticker?: string;
    side?: string;
    status?: string;
    instrument?: { ticker?: string; currency?: string };
  };
  fill?: {
    quantity?: number;
    price?: number;
    type?: string;
    filledAt?: string;
    walletImpact?: { currency?: string; fxRate?: number; taxes?: T212Tax[] };
  };
}

/**
 * Executed orders → trades, id `t212:<order id>`. Only TRADE fills of FILLED /
 * PARTIALLY_FILLED orders (splits and stock distributions are not executions). An order
 * can come back as one item per fill: they share the order id and are merged into ONE
 * trade (quantity summed, price volume-weighted, fees summed, time = the last fill).
 * Sells carry a negative fill quantity; the quantity is stored positive with the side.
 * Fees arrive in the account currency and are converted into the instrument currency
 * with the fill's `fxRate` (instrument units per account unit), so a trade row stays in
 * one currency.
 */
export function mapT212Orders(items: T212HistoricalOrder[]): SyncedTrade[] {
  const byOrder = new Map<string, SyncedTrade & { notional: number }>();
  for (const { order, fill } of items) {
    if (!order || !fill || order.id == null) continue;
    if (order.status !== "FILLED" && order.status !== "PARTIALLY_FILLED") continue;
    if ((fill.type ?? "TRADE") !== "TRADE") continue;
    const side = order.side === "BUY" || order.side === "SELL" ? order.side : null;
    const qty = Math.abs(finite(fill.quantity) ?? NaN);
    const price = finite(fill.price);
    const at = new Date(fill.filledAt ?? "");
    if (!side || !Number.isFinite(qty) || qty === 0 || price == null || !Number.isFinite(at.getTime())) continue;
    const currency = ccy(order.instrument?.currency, "EUR");
    const wallet = fill.walletImpact;
    const feeAccount = (wallet?.taxes ?? []).reduce((s, t) => s + Math.abs(finite(t.quantity) ?? 0), 0);
    const fx = finite(wallet?.fxRate);
    const sameCcy = !wallet?.currency || wallet.currency === currency;
    const fees = sameCcy ? feeAccount : fx != null && fx > 0 ? feeAccount * fx : 0;
    const id = `t212:${order.id}`;
    const seen = byOrder.get(id);
    if (!seen) {
      byOrder.set(id, {
        externalId: id,
        symbol: t212Symbol(order.instrument?.ticker ?? order.ticker ?? "?"),
        side,
        quantity: qty,
        price,
        fees,
        currency,
        executedAt: at,
        notional: qty * price,
      });
      continue;
    }
    seen.quantity += qty;
    seen.notional += qty * price;
    seen.fees += fees;
    if (at > seen.executedAt) seen.executedAt = at;
  }
  return [...byOrder.values()].map(({ notional, ...t }) => ({
    ...t,
    quantity: round(t.quantity, 8),
    price: round(notional / t.quantity, 6),
    fees: round(t.fees, 4),
  }));
}

export interface T212Dividend {
  ticker?: string;
  instrument?: { ticker?: string };
  reference?: string;
  quantity?: number;
  amount?: number;
  amountInEuro?: number;
  currency?: string;
  paidOn?: string;
}

/**
 * Paid dividends → rows, id `t212div:<reference>`. Trading 212 reports what was booked
 * to the account, after withholding tax: `amount` in the account currency (or the
 * item's own `currency`), `amountInEuro` as the fallback when `amount` is missing.
 */
export function mapT212Dividends(items: T212Dividend[], accountCurrency: string): SyncedDividend[] {
  const out: SyncedDividend[] = [];
  for (const d of items) {
    const paid = new Date(d.paidOn ?? "");
    if (!d.reference || !Number.isFinite(paid.getTime())) continue;
    let amount = finite(d.amount);
    let currency = ccy(d.currency, accountCurrency);
    if (amount == null && finite(d.amountInEuro) != null) {
      amount = finite(d.amountInEuro);
      currency = "EUR";
    }
    if (amount == null || amount === 0) continue;
    const qty = finite(d.quantity);
    out.push({
      externalId: `t212div:${d.reference}`,
      symbol: t212Symbol(d.instrument?.ticker ?? d.ticker ?? "?"),
      paidOn: dayOf(paid),
      quantity: qty == null ? null : Math.abs(qty),
      amount: round(amount, 2),
      withholdingTax: null,
      currency,
    });
  }
  return out;
}

export interface T212Transaction {
  type?: string;
  amount?: number;
  currency?: string;
  reference?: string;
  dateTime?: string;
}

/** DEPOSIT / WITHDRAW → cash flows; fees and internal transfers are not external money. */
export function mapT212Flows(items: T212Transaction[], accountCurrency: string): SyncedFlow[] {
  const out: SyncedFlow[] = [];
  for (const t of items) {
    const type = (t.type ?? "").toUpperCase();
    if (type !== "DEPOSIT" && type !== "WITHDRAW" && type !== "WITHDRAWAL") continue;
    const amt = Math.abs(finite(t.amount) ?? NaN);
    const at = new Date(t.dateTime ?? "");
    if (!t.reference || !Number.isFinite(amt) || amt === 0 || !Number.isFinite(at.getTime())) continue;
    const deposit = type === "DEPOSIT";
    out.push({
      externalId: `t212:${t.reference}`,
      date: dayOf(at),
      kind: deposit ? "DEPOSIT" : "WITHDRAWAL",
      amount: round(amt, 2),
      currency: ccy(t.currency, accountCurrency),
      note: deposit ? "Deposit" : "Withdrawal",
    });
  }
  return out;
}

/**
 * The next page of a Trading 212 history list, or null. Only a relative path on the same
 * list endpoint is followed — never an absolute URL taken from a response body.
 */
export function t212NextPath(next: string | null | undefined, list: "orders" | "dividends" | "transactions"): string | null {
  if (!next) return null;
  const re = new RegExp(`^/api/v0/equity/history/${list}\\?[\\w=&%:.+-]*$`);
  return re.test(next) ? next.replace(/^\/api\/v0/, "") : null;
}

// ─── Interactive Brokers Flex ───────────────────────────────────────────

type Attrs = Record<string, string>;

const XML_ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };

/** Every `<tag …/>` / `<tag …>` element's attributes. Flex reports carry all data as attributes. */
export function flexElements(body: string, tag: string): Attrs[] {
  const out: Attrs[] = [];
  const el = new RegExp(`<${tag}\\s([^>]*?)\\/?>`, "g");
  for (const m of body.matchAll(el)) {
    const attrs: Attrs = {};
    for (const a of m[1].matchAll(/([\w:]+)="([^"]*)"/g)) {
      attrs[a[1]] = a[2].replace(/&(amp|lt|gt|quot|apos);/g, (e) => XML_ENTITIES[e]);
    }
    out.push(attrs);
  }
  return out;
}

const num = (v: unknown): number => finite(v) ?? 0;

/** Flex dates: yyyyMMdd or yyyy-MM-dd, optionally followed by ";HHmmss" / "," + time. */
export function flexDate(v: string | undefined): Date | null {
  const s = String(v ?? "").replace(/-/g, "");
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(s);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** "yyyyMMdd;HHmmss" (or a bare date) → Date, read as UTC. */
export function flexDateTime(v: string | undefined): Date | null {
  const d = flexDate(v);
  if (!d) return null;
  const m = /[;,T ](\d{2}):?(\d{2}):?(\d{2})/.exec(v ?? "");
  if (m) d.setUTCHours(+m[1], +m[2], +m[3]);
  return d;
}

const DIVIDEND_TYPE = /^(dividends|payment in lieu of dividends)$/i;
const WITHHOLDING_TYPE = /^withholding tax$/i;
const isDetail = (c: Attrs) => (c.levelOfDetail ?? "DETAIL").toUpperCase() !== "SUMMARY" && c.currency !== "BASE_SUMMARY";

export function parseFlexStatement(body: string): BrokerSnapshot {
  const stmt = flexElements(body, "FlexStatement")[0];
  if (!stmt) throw new Error("The IBKR Flex report has no statement.");
  const notes: string[] = [];

  const info = flexElements(body, "AccountInformation")[0];
  const base = ccy(info?.currency, "EUR");
  if (!info?.currency) notes.push("IBKR: no Account Information section — base currency assumed EUR");

  const cashRows = flexElements(body, "CashReportCurrency");
  const cashRow = cashRows.find((c) => c.currency === "BASE_SUMMARY") ?? cashRows.find((c) => c.currency === base);
  const cash = num(cashRow?.endingCash);

  const positions: SyncedPosition[] = flexElements(body, "OpenPosition")
    .filter((p) => p.assetCategory !== "CASH" && num(p.position) !== 0 && (p.levelOfDetail ?? "SUMMARY").toUpperCase() !== "LOT")
    .map((p) => {
      const fx = num(p.fxRateToBase) || 1;
      return {
        symbol: p.symbol || "?",
        name: p.description ? p.description.slice(0, 120) : null,
        quantity: num(p.position),
        avgCost: num(p.costBasisPrice),
        currency: ccy(p.currency, base),
        price: finite(p.markPrice),
        value: round(num(p.positionValue) * fx, 2),
        unrealisedPnl: finite(p.fifoPnlUnrealized) == null ? null : round(num(p.fifoPnlUnrealized) * fx, 2),
      };
    });

  const trades: SyncedTrade[] = [];
  for (const t of flexElements(body, "Trade")) {
    if ((t.levelOfDetail ?? "EXECUTION") !== "EXECUTION") continue;
    if (t.assetCategory && t.assetCategory !== "STK") continue;
    const id = t.tradeID || t.transactionID;
    const qty = num(t.quantity);
    const price = num(t.tradePrice);
    const at = flexDateTime(t.dateTime || t.tradeDate);
    if (!id || qty === 0 || price <= 0 || !at) continue;
    trades.push({
      externalId: `ibkr:${id}`,
      symbol: t.symbol || "?",
      side: (t.buySell ?? "").toUpperCase().startsWith("SELL") || qty < 0 ? "SELL" : "BUY",
      quantity: Math.abs(qty),
      price,
      fees: round(Math.abs(num(t.ibCommission)), 4),
      currency: ccy(t.currency, base),
      executedAt: at,
    });
  }

  const cashTx = flexElements(body, "CashTransaction").filter(isDetail);

  const flows: SyncedFlow[] = [];
  for (const c of cashTx) {
    if (!/deposit|withdraw/i.test(c.type ?? "")) continue;
    const amount = num(c.amount);
    const date = flexDate(c.dateTime || c.reportDate || c.settleDate);
    if (!c.transactionID || amount === 0 || !date) continue;
    flows.push({
      externalId: `ibkr:${c.transactionID}`,
      date,
      kind: amount > 0 ? "DEPOSIT" : "WITHDRAWAL",
      amount: round(Math.abs(amount), 2),
      currency: ccy(c.currency, base),
      note: c.description ? c.description.slice(0, 120) : null,
    });
  }

  // Withholding tax is its own cash row; it is netted into the dividend of the same
  // symbol, currency and day, so `amount` is what actually reached the account.
  const wht = new Map<string, number>();
  const key = (c: Attrs, d: Date) => `${c.symbol ?? ""}|${ccy(c.currency, base)}|${d.toISOString().slice(0, 10)}`;
  for (const c of cashTx) {
    if (!WITHHOLDING_TYPE.test(c.type ?? "")) continue;
    const date = flexDate(c.dateTime || c.reportDate || c.settleDate);
    if (!date) continue;
    wht.set(key(c, date), (wht.get(key(c, date)) ?? 0) + num(c.amount));
  }
  const dividends: SyncedDividend[] = [];
  for (const c of cashTx) {
    if (!DIVIDEND_TYPE.test(c.type ?? "")) continue;
    const gross = num(c.amount);
    const date = flexDate(c.dateTime || c.reportDate || c.settleDate);
    if (!c.transactionID || gross === 0 || !date) continue;
    const k = key(c, date);
    const tax = wht.get(k) ?? 0;
    wht.delete(k); // one dividend absorbs the tax row(s) of its day
    dividends.push({
      externalId: `ibkrdiv:${c.transactionID}`,
      symbol: c.symbol || "?",
      paidOn: date,
      quantity: null,
      amount: round(gross + tax, 2),
      withholdingTax: tax === 0 ? null : round(Math.abs(tax), 2),
      currency: ccy(c.currency, base),
    });
  }

  const values: SyncedValue[] = [];
  for (const e of flexElements(body, "EquitySummaryByReportDateInBase")) {
    const date = flexDate(e.reportDate);
    const total = finite(e.total);
    if (!date || total == null) continue;
    values.push({ date, value: round(total, 2), cash: finite(e.cash) });
  }

  const asOf = flexDate(stmt.toDate) ?? flexDate(stmt.whenGenerated) ?? dayOf(new Date());
  const holdings = positions.reduce((s, p) => s + (p.value ?? 0), 0);
  const totalValue = round(cash + holdings, 2);
  if (!values.some((v) => v.date.getTime() === asOf.getTime())) values.push({ date: asOf, value: totalValue, cash });

  return { baseCurrency: base, cash, totalValue, asOf, positions, trades, dividends, flows, values, notes };
}

/** The reference code of a Flex SendRequest answer, or the error it carries. */
export function flexReference(body: string): { ref: string | null; code: string | null; message: string | null } {
  return {
    ref: body.match(/<ReferenceCode>\s*(\d+)\s*<\/ReferenceCode>/)?.[1] ?? null,
    code: body.match(/<ErrorCode>\s*(\d+)/)?.[1] ?? null,
    message: body.match(/<ErrorMessage>([^<]+)/)?.[1]?.trim() ?? null,
  };
}
