/**
 * Loader for "Unusual this month" (`src/lib/unusual.ts`). Reads the viewed month plus the 12
 * months before it under the dashboard's own rules — scope filter, accrual month, splits
 * expanded, excluded categories out, refunds netted, income and income reversals skipped —
 * so a flag always refers to money the Spent card counts.
 */
import { prisma } from "./prisma";
import { toEur } from "./currency";
import { expandSplits } from "./splits";
import { dec, monthStart, nextMonthStart, addMonthsUTC } from "./utils";
import { normalizeMerchant } from "./categorise";
import {
  makeIsIncomeReversal,
  makeIsRefund,
  periodDate,
  periodWhere,
  scopeAccountFilter,
  type Scope,
} from "./finance";
import { findUnusual, type UnusualFlag, type UnusualRow } from "./unusual";

export interface UnusualResult {
  month: string;
  flags: (UnusualFlag & { categoryName: string })[];
}

export async function getUnusual(userId: string, ref: Date, scope: Scope = "all"): Promise<UnusualResult> {
  const month = monthStart(ref).toISOString().slice(0, 7);
  const start = addMonthsUTC(monthStart(ref), -12);
  const end = nextMonthStart(ref);
  const acctWhere = await scopeAccountFilter(userId, scope);

  const [txns, cats] = await Promise.all([
    prisma.transaction.findMany({
      where: { userId, ...acctWhere, ...periodWhere(start, end) },
      select: {
        id: true,
        amount: true,
        currency: true,
        type: true,
        date: true,
        accrualDate: true,
        categoryId: true,
        merchant: true,
        splits: { select: { amount: true, categoryId: true } },
      },
    }),
    prisma.category.findMany({ where: { userId }, select: { id: true, name: true, group: true, excludeFromTotals: true } }),
  ]);

  const excluded = new Set(cats.filter((c) => c.excludeFromTotals).map((c) => c.id));
  const groupById = new Map(cats.map((c) => [c.id, c.group]));
  const nameById = new Map(cats.map((c) => [c.id, c.name]));
  const isRefund = makeIsRefund(groupById);
  const isReversal = makeIsIncomeReversal(groupById);

  const rows: UnusualRow[] = [];
  for (const t of expandSplits(txns)) {
    if (t.categoryId && excluded.has(t.categoryId)) continue;
    const refund = isRefund(t.type, t.categoryId);
    if (t.type === "INCOME" && !refund) continue; // real income is not spend
    if (isReversal(t.type, t.categoryId)) continue; // pay handed back, not spend
    const eur = toEur(dec(t.amount), t.currency);
    const pd = periodDate(t);
    rows.push({
      id: t.id,
      month: pd.toISOString().slice(0, 7),
      date: t.date.toISOString().slice(0, 10),
      categoryId: t.categoryId,
      eur: t.type === "EXPENSE" ? eur : -eur,
      merchant: t.merchant,
      merchantKey: normalizeMerchant(t.merchant ?? ""),
    });
  }

  const flags = findUnusual(rows, month).map((f) => ({
    ...f,
    categoryName: f.categoryId ? nameById.get(f.categoryId) ?? "Unknown category" : "Uncategorised",
  }));
  return { month, flags };
}
