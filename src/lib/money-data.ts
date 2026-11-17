/**
 * Server loaders shared by the money pages (balances, the safe-to-draw tile on the
 * dashboard, receipts, recurring status). They only read and shape rows; the maths
 * lives in the pure modules they call (forecast.ts, safe-to-draw.ts, receipts.ts)
 * so it can be unit-tested without a database.
 */
import { prisma } from "./prisma";
import { toEur } from "./currency";
import { ensureFxRates } from "./fx";
import { dec } from "./utils";
import { getDashboard } from "./finance";
import { ruleOccurrences, type ForecastAccount, type ForecastRule } from "./forecast";
import { buildReceiptRows, receiptTotals, type ReceiptRow, type ReceiptTxn } from "./receipts";
import { ruleStatuses, type RuleStatus, type StatusRule, type StatusTxn } from "./recurring-status";
import {
  computeSafeToDraw,
  isEarned,
  isSettled,
  MONEY_RULES,
  type CashInput,
  type ReceivableInput,
  type ReserveStepInput,
  type SafeToDrawResult,
} from "./safe-to-draw";

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Every account with its latest statement balance rolled forward by the rows imported since. */
export async function getForecastAccounts(userId: string): Promise<ForecastAccount[]> {
  await ensureFxRates();
  const [accounts, balances, txns] = await Promise.all([
    prisma.account.findMany({
      where: { userId, isArchived: false },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true, biz: true, color: true },
    }),
    prisma.accountBalance.findMany({
      where: { userId },
      orderBy: { asOf: "desc" },
      select: { accountId: true, asOf: true, balance: true, currency: true },
    }),
    prisma.transaction.findMany({
      where: { userId, accountId: { not: null } },
      select: { id: true, accountId: true, amount: true, currency: true, type: true, date: true },
    }),
  ]);
  const latest = new Map<string, { asOf: string; balance: number; currency: string }>();
  for (const b of balances) {
    if (!latest.has(b.accountId)) latest.set(b.accountId, { asOf: iso(b.asOf), balance: dec(b.balance), currency: b.currency });
  }
  const flow = new Map<string, number>();
  const last = new Map<string, string>();
  for (const t of txns) {
    const a = t.accountId!;
    const d = iso(t.date);
    // Hand-entered placeholders (txn-*) stand in for charges the next statement will
    // bring — they are money, but they are not the edge of the imported data.
    if (!t.id.startsWith("txn-") && (!last.has(a) || d > last.get(a)!)) last.set(a, d);
    const l = latest.get(a);
    if (l && d > l.asOf) {
      const eur = toEur(dec(t.amount), t.currency, t.date);
      flow.set(a, (flow.get(a) ?? 0) + (t.type === "INCOME" ? eur : -eur));
    }
  }
  return accounts.map((a) => ({
    id: a.id,
    name: a.name,
    biz: a.biz,
    color: a.color,
    latest: latest.get(a.id) ?? null,
    flowSinceEur: flow.get(a.id) ?? 0,
    lastTxnDate: last.get(a.id) ?? null,
  }));
}

export async function getForecastRules(userId: string): Promise<ForecastRule[]> {
  const rules = await prisma.recurringRule.findMany({
    where: { userId, active: true },
    select: {
      id: true, merchant: true, amount: true, currency: true, type: true, cadence: true,
      nextDate: true, endDate: true, active: true, accountId: true,
    },
  });
  return rules.map((r) => ({
    id: r.id,
    merchant: r.merchant,
    amount: dec(r.amount),
    currency: r.currency,
    type: r.type,
    cadence: r.cadence,
    nextDate: iso(r.nextDate),
    endDate: r.endDate ? iso(r.endDate) : null,
    active: r.active,
    accountId: r.accountId,
  }));
}

export interface SafeToDraw extends SafeToDrawResult {
  today: string;
  cashLines: CashInput[];
  receivableLines: ReceivableInput[];
  invoicesReceived: number;
  spentThisMonth: number;
}

/**
 * Safe to draw under the money rules in `safe-to-draw.ts`. Reads only what the
 * database holds: statement balances (`account_balances`), account earmarks (held
 * back, e.g. a VAT reserve), the reserve plan (`reserve_steps`), the business INCOME
 * rules for money already earned, imported rows for what has been paid. A balance that is not there is reported as missing, never filled in.
 */
export async function getSafeToDraw(userId: string, now: Date = new Date()): Promise<SafeToDraw> {
  await ensureFxRates();
  const todayIso = iso(now);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const [accounts, balances, incomeRules, bizIncome, steps, personal] = await Promise.all([
    prisma.account.findMany({
      // Shares are not cash: an investment portfolio is kept apart from the reserve.
      where: { userId, isArchived: false, type: { not: "INVESTMENT" } },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true, earmark: true },
    }),
    prisma.accountBalance.findMany({
      where: { userId },
      orderBy: { asOf: "desc" },
      select: { accountId: true, asOf: true, balance: true, currency: true },
    }),
    prisma.recurringRule.findMany({
      where: { userId, active: true, type: "INCOME", account: { biz: "BUSINESS" } },
      select: {
        id: true, merchant: true, amount: true, currency: true, type: true, cadence: true,
        nextDate: true, endDate: true, active: true, accountId: true,
      },
    }),
    // Invoice money that reached the business — own-account transfers are excluded.
    prisma.transaction.findMany({
      where: {
        userId,
        type: "INCOME",
        account: { biz: "BUSINESS" },
        NOT: { category: { excludeFromTotals: true } },
      },
      select: { accountId: true, amount: true, currency: true, date: true },
    }),
    // The reserve plan, one row per invoice payment step.
    prisma.reserveStep.findMany({
      where: { userId },
      orderBy: { payDate: "asc" },
      select: { payDate: true, label: true, invoicesGross: true, reserveAfter: true },
    }),
    getDashboard(userId, monthStart, "personal"),
  ]);

  // Cash: latest statement balance + the rows imported after it. No balance = missing.
  const latest = new Map<string, { asOf: Date; balance: number; currency: string }>();
  for (const b of balances) {
    if (!latest.has(b.accountId)) latest.set(b.accountId, { asOf: b.asOf, balance: dec(b.balance), currency: b.currency });
  }
  const withBalance = accounts.filter((a) => latest.has(a.id)).map((a) => a.id);
  const after = withBalance.length
    ? await prisma.transaction.findMany({
        where: { userId, accountId: { in: withBalance } },
        select: { accountId: true, amount: true, currency: true, type: true, date: true },
      })
    : [];
  const cashLines: CashInput[] = accounts.map((a) => {
    const l = latest.get(a.id);
    if (!l) return { name: a.name, amount: null, asOf: null, earmark: a.earmark };
    const flow = after
      .filter((t) => t.accountId === a.id && t.date > l.asOf)
      .reduce((s, t) => s + (t.type === "INCOME" ? 1 : -1) * toEur(dec(t.amount), t.currency, t.date), 0);
    return { name: a.name, amount: toEur(l.balance, l.currency, l.asOf) + flow, asOf: iso(l.asOf), earmark: a.earmark };
  });

  // Money owed: each earned, not-yet-paid occurrence of a business INCOME rule.
  const paidRows = bizIncome.map((t) => ({
    date: iso(t.date),
    amount: toEur(dec(t.amount), t.currency, t.date),
    accountId: t.accountId,
  }));
  const receivableLines: ReceivableInput[] = incomeRules
    .flatMap((r) => {
      const rule = {
        id: r.id, merchant: r.merchant, amount: dec(r.amount), currency: r.currency, type: r.type,
        cadence: r.cadence, nextDate: iso(r.nextDate), endDate: r.endDate ? iso(r.endDate) : null,
        active: r.active, accountId: r.accountId,
      };
      const dayBefore = iso(new Date(r.nextDate.getTime() - 86_400_000));
      const until = iso(new Date(now.getTime() + 31 * 86_400_000));
      return ruleOccurrences(rule, dayBefore, until)
        .filter((d) => isEarned(d, todayIso))
        .map((d) => ({ label: shortLabel(r.merchant), date: d, amount: toEur(rule.amount, rule.currency), accountId: r.accountId }))
        .filter((o) => !isSettled(o, paidRows));
    })
    .map(({ label, date, amount }) => ({ label, date, amount }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  const sinceIso = MONEY_RULES.since;
  const invoicesReceived = paidRows.filter((t) => t.date >= sinceIso).reduce((s, t) => s + t.amount, 0);
  const spentThisMonth = personal.spent;
  const reserveSteps: ReserveStepInput[] = steps.map((st) => ({
    payDate: iso(st.payDate),
    label: st.label,
    invoicesGross: dec(st.invoicesGross),
    reserveAfter: dec(st.reserveAfter),
  }));

  const result = computeSafeToDraw({
    cash: cashLines,
    receivables: receivableLines,
    invoicesReceived,
    reserveSteps,
    spentThisMonth,
    today: todayIso,
  });
  return { ...result, today: todayIso, cashLines, receivableLines, invoicesReceived, spentThisMonth };
}

function shortLabel(merchant: string): string {
  return merchant.split(/\s[—-]\s|\(/)[0].trim().slice(0, 48);
}

/** How far back the status check reads rows: a yearly bill's last occurrence + the ±7-day window. */
const STATUS_LOOKBACK_DAYS = 400;

/**
 * Due / paid / missed per active recurring rule (`ruleStatuses`), keyed by rule id.
 * Reads the rules and the last ~13 months of rows; writes nothing.
 */
export async function getRecurringStatuses(userId: string, today: Date = new Date()): Promise<Record<string, RuleStatus>> {
  const todayIso = iso(today);
  const [rules, rows] = await Promise.all([
    prisma.recurringRule.findMany({
      where: { userId, active: true },
      select: {
        id: true, merchant: true, amount: true, currency: true, type: true, cadence: true,
        nextDate: true, endDate: true, active: true, accountId: true,
      },
    }),
    prisma.transaction.findMany({
      where: { userId, date: { gte: new Date(today.getTime() - (STATUS_LOOKBACK_DAYS + 7) * 86_400_000) } },
      select: { date: true, amount: true, currency: true, type: true, accountId: true, recurringId: true },
    }),
  ]);
  const statusRules: StatusRule[] = rules.map((r) => ({
    id: r.id, merchant: r.merchant, amount: dec(r.amount), currency: r.currency, type: r.type,
    cadence: r.cadence, nextDate: iso(r.nextDate), endDate: r.endDate ? iso(r.endDate) : null,
    active: r.active, accountId: r.accountId,
  }));
  const statusRows: StatusTxn[] = rows.map((t) => ({
    date: iso(t.date), amount: dec(t.amount), currency: t.currency, type: t.type,
    accountId: t.accountId, recurringId: t.recurringId,
  }));
  return ruleStatuses(statusRules, statusRows, todayIso);
}

export interface BalanceRow {
  accountId: string;
  name: string;
  institution: string | null;
  type: string;
  biz: string;
  accountCurrency: string;
  /** Non-null = held back from "safe to draw"; the text says why. */
  earmark: string | null;
  /** The latest stored balance; every field below is null when there is none. */
  balanceId: string | null;
  balance: number | null;
  currency: string | null;
  asOf: string | null;
  source: string | null;
  origin: "STATEMENT" | "MANUAL" | null;
  /** ≈EUR of the stored figure at its as-of date — NOT rolled forward. */
  eur: number | null;
  /** How many balances are stored for the account (the latest one counts). */
  stored: number;
}

/**
 * Every non-archived account with its latest stored balance. The "safe to draw"
 * tile uses the non-INVESTMENT ones (`getSafeToDraw`); an INVESTMENT account's
 * balance is its value on Net worth.
 */
export async function getBalanceRows(userId: string): Promise<BalanceRow[]> {
  await ensureFxRates();
  const [accounts, balances] = await Promise.all([
    prisma.account.findMany({
      where: { userId, isArchived: false },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true, institution: true, type: true, biz: true, currency: true, earmark: true },
    }),
    prisma.accountBalance.findMany({
      where: { userId },
      orderBy: { asOf: "desc" },
      select: { id: true, accountId: true, asOf: true, balance: true, currency: true, source: true, origin: true },
    }),
  ]);
  const count = new Map<string, number>();
  for (const b of balances) count.set(b.accountId, (count.get(b.accountId) ?? 0) + 1);
  return accounts.map((a) => {
    const l = balances.find((b) => b.accountId === a.id); // ordered newest first
    return {
      accountId: a.id,
      name: a.name,
      institution: a.institution,
      type: a.type,
      biz: a.biz,
      accountCurrency: a.currency,
      earmark: a.earmark,
      balanceId: l?.id ?? null,
      balance: l ? dec(l.balance) : null,
      currency: l?.currency ?? null,
      asOf: l ? iso(l.asOf) : null,
      source: l?.source ?? null,
      origin: l?.origin ?? null,
      eur: l ? Math.round(toEur(dec(l.balance), l.currency, l.asOf) * 100) / 100 : null,
      stored: count.get(a.id) ?? 0,
    };
  });
}

export interface ReceiptData {
  rows: ReceiptRow[];
  totals: { missing: number; missingEur: number; covered: number };
}

/**
 * The business costs that need a receipt on file (rules in `receipts.ts`): EXPENSE
 * rows on a BUSINESS account outside the excluded categories. `from` limits the
 * window by charge date (default: everything).
 */
export async function getReceiptRows(userId: string, from?: Date): Promise<ReceiptData> {
  await ensureFxRates();
  const dateWhere = from ? { date: { gte: from } } : {};
  const txns = await prisma.transaction.findMany({
    where: {
      userId,
      type: "EXPENSE",
      ...dateWhere,
      account: { biz: "BUSINESS" },
      NOT: { category: { excludeFromTotals: true } },
    },
    orderBy: { date: "desc" },
    select: {
      id: true, date: true, merchant: true, amount: true, currency: true, accountId: true,
      receiptRef: true,
      account: { select: { name: true } },
      category: { select: { name: true } },
      _count: { select: { attachments: true } },
    },
  });
  const rt: ReceiptTxn[] = txns.map((t) => ({
    id: t.id,
    date: iso(t.date),
    merchant: t.merchant,
    amount: dec(t.amount),
    amountEur: Math.round(toEur(dec(t.amount), t.currency, t.date) * 100) / 100,
    currency: t.currency,
    account: t.account?.name ?? null,
    accountId: t.accountId,
    category: t.category?.name ?? null,
    receiptRef: t.receiptRef,
    attachments: t._count.attachments,
  }));
  const rows = buildReceiptRows(rt);
  return { rows, totals: receiptTotals(rows) };
}
