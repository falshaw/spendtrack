/**
 * "Unusual this month" — pure, so it is testable.
 *
 * Three kinds of flag, each against the 12 complete months before the viewed one:
 *   - CATEGORY: this month's net spend in a category is well above its own monthly median
 *     (≥ 1.5× AND ≥ €150 above it AND ≥ €200 in total). Months with no spend count as 0, so a
 *     category used twice a year does not get a median of its two big months.
 *   - LARGE: one charge far above what that category normally costs per charge
 *     (≥ 3× the category's median charge AND ≥ €250); needs ≥ 5 past charges to judge.
 *   - NEW_MERCHANT: a merchant never seen in the 12 months before, charging ≥ €150.
 *
 * Why: a miscategorised one-off or a duplicated payment is otherwise found only by reading
 * every row. A flag is a pointer to look, never a verdict —
 * nothing here changes a total.
 *
 * Rows arrive already expanded (splits), already in EUR, with refunds signed negative and
 * transfers/excluded categories removed — the same rules the dashboard's Spent uses.
 */

export interface UnusualRow {
  id: string;
  /** YYYY-MM the row counts in (accrual month when set). */
  month: string;
  date: string; // YYYY-MM-DD
  categoryId: string | null;
  /** ≈EUR, + spend / − refund. */
  eur: number;
  merchant: string;
  /** normalised merchant key (see categorise.normalizeMerchant). */
  merchantKey: string;
}

export type UnusualKind = "CATEGORY" | "LARGE" | "NEW_MERCHANT";

export interface UnusualFlag {
  kind: UnusualKind;
  categoryId: string | null;
  /** The figure that tripped the flag (category total, or the charge). */
  amount: number;
  /** What "usual" is: the monthly median (CATEGORY) or the median charge (LARGE); null for NEW_MERCHANT. */
  usual: number | null;
  /** amount − usual (CATEGORY, LARGE) or amount (NEW_MERCHANT) — the sort key. */
  excess: number;
  txnId?: string;
  merchant?: string;
  merchantKey?: string;
  date?: string;
  /** Charges merged into this line (same kind, merchant and category); 1 when single. */
  count: number;
}

export const LIMITS = {
  catRatio: 1.5,
  catAbove: 150,
  catMin: 200,
  largeRatio: 3,
  largeMin: 250,
  largeHistory: 5,
  newMerchantMin: 150,
  maxFlags: 8,
} as const;

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** The `n` months before `month` (YYYY-MM), oldest first. */
export function previousMonths(month: string, n: number): string[] {
  const [y, m] = month.split("-").map(Number);
  const out: string[] = [];
  for (let i = n; i >= 1; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

export function findUnusual(rows: UnusualRow[], month: string, historyMonths = 12): UnusualFlag[] {
  const past = new Set(previousMonths(month, historyMonths));
  const now = rows.filter((r) => r.month === month);
  const before = rows.filter((r) => past.has(r.month));
  const flags: UnusualFlag[] = [];
  const key = (c: string | null) => c ?? "__uncat__";

  // CATEGORY: monthly totals, empty months as 0.
  const pastByCatMonth = new Map<string, Map<string, number>>();
  for (const r of before) {
    const m = pastByCatMonth.get(key(r.categoryId)) ?? new Map<string, number>();
    m.set(r.month, (m.get(r.month) ?? 0) + r.eur);
    pastByCatMonth.set(key(r.categoryId), m);
  }
  const nowByCat = new Map<string, number>();
  for (const r of now) nowByCat.set(key(r.categoryId), (nowByCat.get(key(r.categoryId)) ?? 0) + r.eur);
  for (const [cat, total] of nowByCat) {
    const monthly = [...past].map((mo) => pastByCatMonth.get(cat)?.get(mo) ?? 0);
    const usual = median(monthly);
    if (total >= LIMITS.catMin && total >= usual * LIMITS.catRatio && total - usual >= LIMITS.catAbove) {
      flags.push({ kind: "CATEGORY", categoryId: cat === "__uncat__" ? null : cat, amount: total, usual, excess: total - usual, count: 1 });
    }
  }

  // LARGE: per-charge median of past EXPENSE rows in the same category.
  const pastCharges = new Map<string, number[]>();
  for (const r of before) {
    if (r.eur <= 0) continue;
    const list = pastCharges.get(key(r.categoryId)) ?? [];
    list.push(r.eur);
    pastCharges.set(key(r.categoryId), list);
  }
  for (const r of now) {
    if (r.eur <= 0) continue;
    const hist = pastCharges.get(key(r.categoryId)) ?? [];
    if (hist.length < LIMITS.largeHistory) continue;
    const usual = median(hist);
    if (r.eur >= LIMITS.largeMin && r.eur >= usual * LIMITS.largeRatio) {
      flags.push({ kind: "LARGE", categoryId: r.categoryId, amount: r.eur, usual, excess: r.eur - usual, txnId: r.id, merchant: r.merchant, merchantKey: r.merchantKey, date: r.date, count: 1 });
    }
  }

  // NEW_MERCHANT: first time in the window, big enough to matter. A charge already flagged
  // LARGE is not listed twice.
  const seen = new Set(before.map((r) => r.merchantKey).filter(Boolean));
  const largeIds = new Set(flags.filter((f) => f.kind === "LARGE").map((f) => f.txnId));
  for (const r of now) {
    if (r.eur < LIMITS.newMerchantMin || !r.merchantKey || seen.has(r.merchantKey) || largeIds.has(r.id)) continue;
    flags.push({ kind: "NEW_MERCHANT", categoryId: r.categoryId, amount: r.eur, usual: null, excess: r.eur, txnId: r.id, merchant: r.merchant, merchantKey: r.merchantKey, date: r.date, count: 1 });
  }

  // One charge that explains most of a category's jump is the better pointer: keep the charge,
  // drop the category line, so the same euros are not listed twice.
  const kept = flags.filter((f) => {
    if (f.kind !== "CATEGORY") return true;
    const covered = flags
      .filter((g) => g.kind !== "CATEGORY" && key(g.categoryId) === key(f.categoryId))
      .reduce((s, g) => s + g.excess, 0);
    return covered < f.excess * 0.8;
  });

  // Repeat charges to one merchant (three VAT payments in a month) are one line, not three.
  const merged: UnusualFlag[] = [];
  const byKey = new Map<string, UnusualFlag>();
  for (const f of kept) {
    if (f.kind === "CATEGORY") {
      merged.push(f);
      continue;
    }
    const k = `${f.kind}|${key(f.categoryId)}|${f.merchantKey ?? f.txnId}`;
    const prev = byKey.get(k);
    if (!prev) {
      const copy = { ...f };
      byKey.set(k, copy);
      merged.push(copy);
      continue;
    }
    prev.amount += f.amount;
    prev.excess += f.excess;
    prev.count += 1;
    if ((f.date ?? "") < (prev.date ?? "")) prev.date = f.date;
  }

  return merged.sort((a, b) => b.excess - a.excess).slice(0, LIMITS.maxFlags);
}
