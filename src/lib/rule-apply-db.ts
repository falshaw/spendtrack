import { prisma } from "./prisma";
import { dec } from "./utils";
import type { ApplyRow } from "./rule-apply";

export const PREVIEW_CAP = 5000;

const RULE_SELECT = {
  id: true, tier: true, priority: true, active: true, stopProcessing: true, matchText: true, conditions: true, actions: true,
} as const;

/** One rule of the caller's, in the raw DB shape `toRuleLite` reads. */
export async function loadRule(userId: string, id: string) {
  return prisma.txnRule.findFirst({ where: { id, userId }, select: RULE_SELECT });
}

/** The caller's rows in the window (by charge `date`, inclusive), in the planner's shape. */
export async function loadApplyRows(userId: string, from: string, to: string): Promise<ApplyRow[]> {
  const rows = await prisma.transaction.findMany({
    where: { userId, date: { gte: new Date(from), lte: new Date(to) } },
    orderBy: [{ date: "desc" }],
    take: PREVIEW_CAP,
    select: {
      id: true, merchant: true, amount: true, type: true, accountId: true, currency: true,
      categoryId: true, displayMerchant: true, note: true, tags: true,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    merchant: r.merchant,
    amount: dec(r.amount),
    type: r.type,
    accountId: r.accountId,
    currency: r.currency,
    categoryId: r.categoryId,
    displayMerchant: r.displayMerchant,
    note: r.note,
    tags: r.tags,
  }));
}
