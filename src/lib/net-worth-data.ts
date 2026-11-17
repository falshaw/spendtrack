/**
 * Loads what `computeNetWorth` needs for one month and stores snapshots. Writes
 * only net_worth_snapshots. The maths is in net-worth.ts.
 *
 * Investments = the latest stored balance (≤ the cut-off) of every INVESTMENT
 * account, typed on /balances or read off a broker statement, plus the latest
 * value of each broker connection on /investments (one linked to an account
 * replaces that account's balance). An investment account with no balance is
 * listed with a null value, never counted as 0.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { toEur } from "./currency";
import { ensureFxRates } from "./fx";
import { dec } from "./utils";
import { MONEY_RULES, reserveDue } from "./safe-to-draw";
import { brokerNavInputs } from "./investments-data";
import { brokerNavRows } from "./investments";
import {
  computeNetWorth,
  lastCompleteMonth,
  monthEndOf,
  monthStartOf,
  type NetWorthResult,
  type NwItem,
  summariseNav,
} from "./net-worth";

const iso = (d: Date) => d.toISOString().slice(0, 10);
const at = (s: string) => new Date(`${s}T00:00:00Z`);

/**
 * Net worth for the month containing `monthIso`. For the running month the
 * cut-off is today (a figure "as of now"); for a past month it is the month end.
 */
export async function computeNetWorthFor(userId: string, monthIso: string, now: Date = new Date()): Promise<NetWorthResult> {
  await ensureFxRates();
  const today = iso(now);
  const month = monthStartOf(monthIso);
  const end = monthEndOf(month);
  const cutoff = end < today ? end : today;

  const [accounts, balances, items, steps, bizIncome] = await Promise.all([
    prisma.account.findMany({
      where: { userId },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true, type: true, isArchived: true },
    }),
    prisma.accountBalance.findMany({
      where: { userId, asOf: { lte: at(cutoff) } },
      select: { accountId: true, asOf: true, balance: true, currency: true },
    }),
    prisma.netWorthItem.findMany({
      where: { userId, asOf: { lte: at(cutoff) } },
      select: { id: true, kind: true, name: true, amount: true, currency: true, asOf: true },
    }),
    prisma.reserveStep.findMany({
      where: { userId },
      select: { payDate: true, label: true, invoicesGross: true, reserveAfter: true },
    }),
    // Same invoice money the safe-to-draw tile counts toward the reserve steps.
    prisma.transaction.findMany({
      where: {
        userId,
        type: "INCOME",
        account: { biz: "BUSINESS" },
        NOT: { category: { excludeFromTotals: true } },
        date: { gte: at(MONEY_RULES.since), lte: at(cutoff) },
      },
      select: { amount: true, currency: true, date: true },
    }),
  ]);

  // Latest balance per INVESTMENT account on or before the cut-off.
  const latestBal = new Map<string, { asOf: Date; eur: number }>();
  for (const b of balances) {
    const cur = latestBal.get(b.accountId);
    if (!cur || b.asOf > cur.asOf) latestBal.set(b.accountId, { asOf: b.asOf, eur: toEur(dec(b.balance), b.currency, b.asOf) });
  }
  // A synced broker connection linked to one of these accounts REPLACES its row; an
  // unlinked connection is a row of its own (brokerNavRows — never counted twice).
  const brokers = await brokerNavInputs(userId, cutoff);
  const nav = summariseNav(
    brokerNavRows(
      accounts
        .filter((a) => a.type === "INVESTMENT" && !a.isArchived)
        .map((a) => {
          const l = latestBal.get(a.id);
          return { accountId: a.id, name: a.name, date: l ? iso(l.asOf) : null, value: l ? l.eur : null };
        }),
      brokers,
    ),
    cutoff,
    today,
  );

  const withBalance = new Set(balances.map((b) => b.accountId));
  // An archived account still counts in a month it had a balance; without one it is gone, not missing.
  const live = accounts.filter((a) => !a.isArchived || withBalance.has(a.id));

  const received = bizIncome.reduce((s, t) => s + toEur(dec(t.amount), t.currency, t.date), 0);
  const reserve = steps.length
    ? reserveDue(
        steps.map((st) => ({ payDate: iso(st.payDate), label: st.label, invoicesGross: dec(st.invoicesGross), reserveAfter: dec(st.reserveAfter) })),
        received,
      ).level
    : null;

  const nwItems: NwItem[] = items.map((i) => ({
    id: i.id,
    kind: i.kind,
    name: i.name,
    eur: toEur(dec(i.amount), i.currency, i.asOf),
    asOf: iso(i.asOf),
  }));

  return computeNetWorth({
    month,
    accounts: live.map((a) => ({ id: a.id, name: a.name, type: a.type })),
    balances: balances.map((b) => ({ accountId: b.accountId, asOf: iso(b.asOf), eur: toEur(dec(b.balance), b.currency, b.asOf) })),
    items: nwItems,
    nav,
    reserve,
  });
}

/** Compute and store (replace) the snapshot of one month. */
export async function snapshotMonth(userId: string, monthIso: string, now: Date = new Date()): Promise<NetWorthResult> {
  const r = await computeNetWorthFor(userId, monthIso, now);
  const data = {
    cash: r.cash,
    cards: r.cards,
    trading: r.trading,
    assets: r.assets,
    liabilities: r.liabilities,
    reserve: r.reserve,
    net: r.net,
    detail: r.detail as unknown as Prisma.InputJsonValue,
    estimated: r.estimated,
  };
  await prisma.netWorthSnapshot.upsert({
    where: { userId_month: { userId, month: at(r.month) } },
    create: { userId, month: at(r.month), ...data },
    update: data,
  });
  return r;
}

/** The last complete month is snapshotted once, the first time the page is opened after it ends. */
export async function ensureLastCompleteSnapshot(userId: string, now: Date = new Date()): Promise<boolean> {
  const month = lastCompleteMonth(iso(now));
  const exists = await prisma.netWorthSnapshot.findUnique({
    where: { userId_month: { userId, month: at(month) } },
    select: { id: true },
  });
  if (exists) return false;
  await snapshotMonth(userId, month, now);
  return true;
}

export interface SnapshotRow {
  month: string;
  cash: number;
  cards: number;
  trading: number | null;
  assets: number;
  liabilities: number;
  reserve: number | null;
  net: number;
  estimated: boolean;
  updatedAt: string;
}

export async function listSnapshots(userId: string): Promise<SnapshotRow[]> {
  const rows = await prisma.netWorthSnapshot.findMany({
    where: { userId },
    orderBy: { month: "asc" },
    select: { month: true, cash: true, cards: true, trading: true, assets: true, liabilities: true, reserve: true, net: true, estimated: true, updatedAt: true },
  });
  return rows.map((s) => ({
    month: iso(s.month),
    cash: dec(s.cash),
    cards: dec(s.cards),
    trading: s.trading == null ? null : dec(s.trading),
    assets: dec(s.assets),
    liabilities: dec(s.liabilities),
    reserve: s.reserve == null ? null : dec(s.reserve),
    net: dec(s.net),
    estimated: s.estimated,
    updatedAt: s.updatedAt.toISOString(),
  }));
}
