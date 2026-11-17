import { prisma } from "./prisma";
import { normalizeMerchant, suggestCategoryId } from "./categorise";
import type { RuleLite } from "./categorise";
import { toRuleLite, type TxnRuleLite } from "./rule-engine";

// The pure matcher lives in categorise.ts (no database import) so the CLI
// importer can share it; re-exported here so existing imports keep working.
export { normalizeMerchant, suggestCategoryId };
export type { RuleLite };

/**
 * Every active rule of the user, both tiers, in the shape the pure engine reads
 * (`evaluateRules` in rule-engine.ts). One query per import/preview; the engine
 * sorts USER rules itself.
 */
export async function loadRules(userId: string, opts: { includeInactive?: boolean } = {}): Promise<TxnRuleLite[]> {
  const rows = await prisma.txnRule.findMany({
    where: { userId, ...(opts.includeInactive ? {} : { active: true }) },
    orderBy: [{ tier: "asc" }, { priority: "asc" }, { id: "asc" }],
    select: { id: true, tier: true, priority: true, active: true, stopProcessing: true, matchText: true, conditions: true, actions: true },
  });
  return rows.map(toRuleLite);
}

/**
 * Persist (or update) the merchant→category association so future imports of
 * the same merchant auto-categorise. Called whenever the user assigns a
 * category to a transaction. Silently no-ops on a blank merchant.
 *
 * Since F2 this writes a LEARNED row in `txn_rules` (payee.op =
 * word, the normalised text as `matchText`), not `merchant_rules` — that table is
 * read-only until it is dropped.
 */
export async function learnMerchantRule(
  userId: string,
  merchant: string,
  categoryId: string,
): Promise<void> {
  const key = normalizeMerchant(merchant).slice(0, 60);
  if (!key) return;
  const conditions = { payee: { op: "word", value: key } };
  const actions = { categoryId };
  await prisma.txnRule.upsert({
    where: { userId_matchText: { userId, matchText: key } },
    update: { actions, conditions, active: true },
    create: { userId, tier: "LEARNED", name: key, matchText: key, conditions, actions },
  });
}
