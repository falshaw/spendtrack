/**
 * F3 splits — pure maths (no Prisma).
 *
 * A split breaks ONE reconciled transaction into parts that carry their own
 * category. The parent row keeps its date/amount/type/currency/account/merchant
 * untouched (the reconciliation and dedup keys), and its `categoryId` is kept at
 * the largest part's category so code that does not know about splits still sums
 * right. Every category breakdown in finance.ts runs its rows through
 * `expandSplits` first, which is what spreads a split across categories without
 * moving a cent of any grand total.
 */

import { RECEIPT_NON_ITEM_WORDS, allLanguages, wordsRegex } from "./l10n-keywords";

export interface SplitPart {
  amount: number;
  categoryId: string | null;
  note?: string | null;
}

export const MAX_PARTS = 20;

const cents = (n: number) => Math.round(n * 100);

/** Null when the parts are a valid split of `amount`; the problem otherwise. Empty = unsplit, valid. */
export function validateSplits(amount: number, parts: SplitPart[]): string | null {
  if (parts.length === 0) return null;
  if (parts.length < 2) return "A split needs at least two parts (or none to unsplit)";
  if (parts.length > MAX_PARTS) return `At most ${MAX_PARTS} parts`;
  for (const p of parts) {
    if (!Number.isFinite(p.amount) || cents(p.amount) <= 0) return "Every part must be greater than 0";
  }
  const sum = parts.reduce((s, p) => s + cents(p.amount), 0);
  if (sum !== cents(amount)) {
    return `The parts sum to ${(sum / 100).toFixed(2)} but the transaction is ${amount.toFixed(2)}`;
  }
  return null;
}

/** The category the parent keeps: the biggest part's; ties go to the first. Null if no part is categorised. */
export function largestPart(parts: SplitPart[]): string | null {
  let best: SplitPart | null = null;
  for (const p of parts) {
    if (!p.categoryId) continue;
    if (!best || cents(p.amount) > cents(best.amount)) best = p;
  }
  return best?.categoryId ?? null;
}

type Splittable = {
  amount: unknown;
  categoryId: string | null;
  splits?: { amount: unknown; categoryId: string | null }[] | null;
};

/**
 * Replace every split row by one row per part (same fields, the part's amount and
 * category); rows without parts pass through. The sum of `amount` is unchanged.
 */
export function expandSplits<T extends Splittable>(rows: T[]): Omit<T, "splits">[] {
  const out: Omit<T, "splits">[] = [];
  for (const r of rows) {
    const { splits, ...rest } = r;
    if (!splits || splits.length === 0) {
      out.push(rest);
      continue;
    }
    for (const p of splits) out.push({ ...rest, amount: p.amount, categoryId: p.categoryId });
  }
  return out;
}

/** Labels the receipt reader's pass 2 prints that are not items: totals, tax, tip, change, discounts. */
const NOT_AN_ITEM = wordsRegex(allLanguages(RECEIPT_NON_ITEM_WORDS));

/**
 * "Prefill from receipt": the item lines of a receipt as uncategorised parts. The
 * sum may not reach the row amount (a receipt lists items before tax); the editor
 * shows the gap and the user adds or adjusts a part. Nothing is written here.
 */
export function partsFromReceiptLines(
  lines: { label: string; amount: number; currency?: string }[],
  _amount: number,
): (SplitPart & { note: string })[] {
  const parts: (SplitPart & { note: string })[] = [];
  for (const l of lines) {
    if (!Number.isFinite(l.amount) || cents(l.amount) <= 0) continue;
    const label = (l.label || "").trim();
    if (!label || NOT_AN_ITEM.test(label)) continue;
    parts.push({ amount: Math.round(l.amount * 100) / 100, categoryId: null, note: label.slice(0, 120) });
    if (parts.length >= MAX_PARTS) break;
  }
  return parts;
}
