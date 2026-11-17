/**
 * F4 — loads what the pure detector needs for one user and runs it. Shared by
 * GET /api/recurring/suggestions and the confirm route (which re-detects instead
 * of trusting a client-sent row list).
 */
import { prisma } from "./prisma";
import { dec } from "./utils";
import { detectRecurring, type Suggestion } from "./recurring-detect";

/** Three years back covers a yearly bill's three charges with room for a late one. */
const WINDOW_DAYS = 3 * 366 + 30;

export async function loadSuggestions(userId: string, now: Date = new Date()): Promise<Suggestion[]> {
  const today = now.toISOString().slice(0, 10);
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - WINDOW_DAYS * 86_400_000);
  const [txns, rules, dismissals] = await Promise.all([
    prisma.transaction.findMany({
      where: {
        userId,
        date: { gte: from },
        // Money movement (transfers, broker top-ups, one-off asset sales) is not a bill.
        NOT: { category: { excludeFromTotals: true } },
      },
      select: {
        id: true, accountId: true, merchant: true, displayMerchant: true, type: true,
        amount: true, currency: true, date: true, categoryId: true, recurringId: true,
      },
    }),
    prisma.recurringRule.findMany({
      where: { userId },
      select: { id: true, merchant: true, accountId: true, type: true, active: true, endDate: true },
    }),
    prisma.recurringDismissal.findMany({ where: { userId }, select: { key: true } }),
  ]);
  return detectRecurring(
    txns.map((t) => ({
      id: t.id,
      accountId: t.accountId,
      merchant: t.merchant,
      displayMerchant: t.displayMerchant,
      type: t.type,
      amount: dec(t.amount),
      currency: t.currency,
      date: t.date.toISOString().slice(0, 10),
      categoryId: t.categoryId,
      recurringId: t.recurringId,
    })),
    rules.map((r) => ({ ...r, endDate: r.endDate ? r.endDate.toISOString().slice(0, 10) : null })),
    dismissals.map((d) => d.key),
    today,
  );
}
