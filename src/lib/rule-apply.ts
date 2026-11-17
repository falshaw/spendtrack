/**
 * F2 — what applying ONE rule to a set of rows would change. Pure, so the preview
 * route, the apply route and the tests share it.
 *
 * The only fields a rule may write are category, display name, note and tags. That
 * list is the reconciliation guarantee: date/amount/type/currency/account/merchant
 * never appear in a change, so the step-5 SQL is identical before and after an apply.
 */
import { matchesConditions, type TxnRuleLite } from "./rule-engine";

export interface ApplyRow {
  id: string;
  merchant: string;
  amount: number;
  type: "EXPENSE" | "INCOME";
  accountId: string | null;
  currency: string;
  categoryId: string | null;
  displayMerchant: string | null;
  note: string | null;
  tags: string[];
}

export interface LabelState {
  categoryId: string | null;
  displayMerchant: string | null;
  note: string | null;
  tags: string[];
}

export interface ApplyChange {
  id: string;
  before: LabelState;
  after: LabelState;
}

export const APPLY_FIELDS = ["categoryId", "displayMerchant", "note", "tags"] as const;

const sameTags = (a: string[], b: string[]) => a.length === b.length && a.every((t, i) => t === b[i]);

export function planRuleApply(rows: ApplyRow[], rule: TxnRuleLite): ApplyChange[] {
  const out: ApplyChange[] = [];
  const a = rule.actions;
  for (const r of rows) {
    if (!matchesConditions({ merchant: r.merchant, amount: r.amount, type: r.type, accountId: r.accountId, currency: r.currency }, rule.conditions)) continue;
    const before: LabelState = { categoryId: r.categoryId, displayMerchant: r.displayMerchant, note: r.note, tags: [...r.tags] };
    const after: LabelState = {
      categoryId: a.categoryId ? a.categoryId : r.categoryId,
      displayMerchant: a.displayMerchant && a.displayMerchant.trim() ? a.displayMerchant.trim() : r.displayMerchant,
      note: a.note && a.note.trim() ? a.note.trim() : r.note,
      tags: [...r.tags],
    };
    if (a.tags) for (const t of a.tags) if (t && !after.tags.includes(t)) after.tags.push(t);
    const changed =
      before.categoryId !== after.categoryId ||
      before.displayMerchant !== after.displayMerchant ||
      before.note !== after.note ||
      !sameTags(before.tags, after.tags);
    if (changed) out.push({ id: r.id, before, after });
  }
  return out;
}
