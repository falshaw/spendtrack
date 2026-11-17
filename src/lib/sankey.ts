/**
 * F6 — cash-flow Sankey data, pure (no Prisma), so it is testable.
 *
 *   income categories ─► Income ─► category groups ─► top categories
 *                         ▲                 └────────► Saved (income left over)
 *          From savings ──┘  (only when spend > income)
 *
 * The classification is exactly `getYearSummary`'s (finance.ts): a row in an
 * `excludeFromTotals` category is dropped; INCOME outside a spend category is real
 * income; INCOME inside a spend category is a refund and nets against it; an EXPENSE
 * in an INCOME-group category is pay handed back and reduces income. So the spend
 * that flows out equals the year summary's `total` and the income its `income`
 * whenever no category ends the window net-negative (a category refunded beyond its
 * spend cannot be drawn as a negative band — it is left out and reported in `netted`).
 *
 * The caller passes the rows of one window (already filtered with `periodWhere`, so
 * COALESCE(accrualDate, date) decides membership) converted to ≈EUR.
 */

export interface SankeyTxn {
  type: "EXPENSE" | "INCOME" | string;
  categoryId: string | null;
  eur: number;
}

export interface SankeyCategory {
  id: string;
  name: string;
  color: string;
  group: string; // INCOME | NEEDS | WANTS | SAVINGS
  excludeFromTotals: boolean;
}

export interface SankeyNode {
  name: string;
  color: string;
  kind: "source" | "hub" | "group" | "category" | "saved" | "savings";
}

export interface SankeyLink {
  source: number;
  target: number;
  value: number;
}

export interface SankeyData {
  nodes: SankeyNode[];
  links: SankeyLink[];
  income: number;
  spend: number;
  saved: number;
  fromSavings: number;
  /** Net-negative categories left out of the drawing (refunds beyond spend), ≈EUR. */
  netted: number;
}

export const SANKEY_TOP_CATEGORIES = 8;
const UNCAT = "__uncat__";
const GROUP_LABEL: Record<string, string> = {
  NEEDS: "Needs",
  WANTS: "Wants",
  SAVINGS: "Savings & investing",
  UNCATEGORISED: "Uncategorised",
};
const GROUP_COLOR: Record<string, string> = {
  NEEDS: "#2f62b8",
  WANTS: "#e2553c",
  SAVINGS: "#5a9a2c",
  UNCATEGORISED: "#a59c8e",
};
const NEUTRAL = "#a59c8e";
const INCOME_COLOR = "#008a9e";
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Income that is not a transaction row (synced broker dividends), drawn as its own source. */
export interface SankeyExtraIncome {
  name: string;
  color: string;
  eur: number;
}

export function buildSankey(
  txns: SankeyTxn[],
  categories: SankeyCategory[],
  topN: number = SANKEY_TOP_CATEGORIES,
  extraIncome: SankeyExtraIncome[] = [],
): SankeyData {
  const cat = new Map(categories.map((c) => [c.id, c]));
  const incomeBy = new Map<string, number>(); // key = category id, UNCAT, or an extra source
  const extra = new Map<string, SankeyExtraIncome>();
  for (const x of extraIncome) {
    const key = `__extra__${x.name}`;
    extra.set(key, x);
    incomeBy.set(key, (incomeBy.get(key) ?? 0) + x.eur);
  }
  const spendBy = new Map<string, number>();
  for (const t of txns) {
    const c = t.categoryId ? cat.get(t.categoryId) : undefined;
    if (c?.excludeFromTotals) continue;
    const isRefund = t.type === "INCOME" && !!c && c.group !== "INCOME";
    const isReversal = t.type === "EXPENSE" && !!c && c.group === "INCOME";
    const key = t.categoryId && c ? t.categoryId : UNCAT;
    if (t.type === "INCOME" && !isRefund) {
      incomeBy.set(key, (incomeBy.get(key) ?? 0) + t.eur);
    } else if (isReversal) {
      incomeBy.set(key, (incomeBy.get(key) ?? 0) - t.eur);
    } else {
      spendBy.set(key, (spendBy.get(key) ?? 0) + (t.type === "EXPENSE" ? t.eur : -t.eur));
    }
  }

  const nodes: SankeyNode[] = [];
  const links: SankeyLink[] = [];
  const add = (n: SankeyNode) => nodes.push(n) - 1;
  const link = (source: number, target: number, value: number) => {
    if (value >= 0.005) links.push({ source, target, value: r2(value) });
  };

  // Income sources, biggest first. A source pushed negative by reversals is netted.
  let netted = 0;
  const sources = [...incomeBy.entries()]
    .map(([id, v]) => ({ id, v }))
    .filter((s) => {
      if (s.v < 0.005) netted += Math.max(0, -s.v);
      return s.v >= 0.005;
    })
    .sort((a, b) => b.v - a.v);
  const income = sources.reduce((s, x) => s + x.v, 0);

  // Spend per category; a net-negative category (refunds > spend) cannot be drawn.
  const cats = [...spendBy.entries()]
    .map(([id, v]) => {
      const c = id === UNCAT ? undefined : cat.get(id);
      return { id, v, name: c?.name ?? "Uncategorised", color: c?.color ?? NEUTRAL, group: c?.group ?? "UNCATEGORISED" };
    })
    .filter((c) => {
      if (c.v < 0.005) netted += Math.max(0, -c.v);
      return c.v >= 0.005;
    })
    .sort((a, b) => b.v - a.v);
  const spend = cats.reduce((s, x) => s + x.v, 0);

  const hubIdx = add({ name: "Income", color: INCOME_COLOR, kind: "hub" });
  for (const s of sources) {
    const x = extra.get(s.id);
    const c = s.id === UNCAT ? undefined : cat.get(s.id);
    const i = add({ name: x?.name ?? c?.name ?? "Other income", color: x?.color ?? c?.color ?? INCOME_COLOR, kind: "source" });
    link(i, hubIdx, s.v);
  }
  const fromSavings = spend > income ? spend - income : 0;
  if (fromSavings >= 0.005) {
    const i = add({ name: "From savings", color: NEUTRAL, kind: "savings" });
    link(i, hubIdx, fromSavings);
  }

  // Groups, then the top N categories by name; the rest fold into "Other <group>".
  const top = new Set(cats.slice(0, topN).map((c) => c.id));
  const groups = new Map<string, typeof cats>();
  for (const c of cats) groups.set(c.group, [...(groups.get(c.group) ?? []), c]);
  const groupOrder = [...groups.entries()]
    .map(([g, list]) => ({ g, list, v: list.reduce((s, x) => s + x.v, 0) }))
    .sort((a, b) => b.v - a.v);
  for (const { g, list, v } of groupOrder) {
    const gi = add({ name: GROUP_LABEL[g] ?? g, color: GROUP_COLOR[g] ?? NEUTRAL, kind: "group" });
    link(hubIdx, gi, v);
    let rest = 0;
    for (const c of list) {
      if (!top.has(c.id)) {
        rest += c.v;
        continue;
      }
      const ci = add({ name: c.name, color: c.color, kind: "category" });
      link(gi, ci, c.v);
    }
    if (rest >= 0.005) {
      const oi = add({ name: `Other ${(GROUP_LABEL[g] ?? g).toLowerCase()}`, color: NEUTRAL, kind: "category" });
      link(gi, oi, rest);
    }
  }
  const saved = income > spend ? income - spend : 0;
  if (saved >= 0.005) {
    const si = add({ name: "Saved", color: INCOME_COLOR, kind: "saved" });
    link(hubIdx, si, saved);
  }

  return { nodes, links, income: r2(income), spend: r2(spend), saved: r2(saved), fromSavings: r2(fromSavings), netted: r2(netted) };
}
