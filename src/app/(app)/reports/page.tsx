import Link from "next/link";
import { redirect } from "next/navigation";
import { Layers, User, Briefcase } from "lucide-react";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  defaultDashboardMonth,
  getMonthlyTrend,
  periodWhere,
  scopeAccountFilter,
  type Scope,
} from "@/lib/finance";
import { toEur } from "@/lib/currency";
import { formatMoney, dec, addMonthsUTC, nextMonthStart } from "@/lib/utils";
import { TrendChart } from "@/components/charts/TrendChart";
import { CategoryDonut } from "@/components/charts/CategoryDonut";
import { CashflowSankey } from "@/components/charts/CashflowSankey";
import { buildSankey } from "@/lib/sankey";
import { expandSplits } from "@/lib/splits";
import { getDividendIncome } from "@/lib/investments-data";
import { addIncomeToTrend } from "@/lib/investments";

import { PageHero } from "@/components/PageHero";

export const dynamic = "force-dynamic";

const MONTHS = 18;

const SCOPES: { key: Scope; label: string; icon: typeof Layers }[] = [
  { key: "all", label: "Together", icon: Layers },
  { key: "personal", label: "Personal", icon: User },
  { key: "business", label: "Business", icon: Briefcase },
];

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  const userId = session.userId;
  const sp = await searchParams;

  // Reports are about your own money by default — business tax and one-off asset
  // sales would otherwise drown personal spending. Toggle for the others.
  const VALID: Scope[] = ["all", "personal", "business"];
  const scope: Scope = VALID.includes(sp.scope as Scope) ? (sp.scope as Scope) : "personal";

  // End on the latest month that is fully COVERED by statements, so the last bar is
  // never a half-imported month. `latestTxnMonth` only asks for 5 rows, which a
  // partly imported current month clears easily.
  const ref = await defaultDashboardMonth(userId);
  const start = addMonthsUTC(ref, -(MONTHS - 1));
  const end = nextMonthStart(ref);
  const acctWhere = await scopeAccountFilter(userId, scope);

  const [trendRows, categories, txns, dividends] = await Promise.all([
    getMonthlyTrend(userId, MONTHS, scope, ref),
    prisma.category.findMany({
      where: { userId },
      select: { id: true, name: true, color: true, group: true, excludeFromTotals: true },
    }),
    prisma.transaction.findMany({
      where: { userId, ...acctWhere, ...periodWhere(start, end) },
      // F3: a split row arrives as one row per part, each with its own category.
      select: { amount: true, currency: true, categoryId: true, type: true, splits: { select: { amount: true, categoryId: true } } },
    }).then(expandSplits),
    // Synced broker dividends not already imported as transactions (no double count).
    getDividendIncome(userId, start, end, scope),
  ]);
  const trend = addIncomeToTrend(trendRows, dividends.monthly);

  const catInfo = new Map(categories.map((c) => [c.id, c]));
  const excluded = new Set(categories.filter((c) => c.excludeFromTotals).map((c) => c.id));
  const groupById = new Map(categories.map((c) => [c.id, c.group]));
  // Net refunds per category: EXPENSE adds, a refund (INCOME in a spend category)
  // subtracts. Real income is skipped, and so is pay handed back (an EXPENSE in an
  // income category) — that is less income, not spending.
  const spentByCat = new Map<string, number>();
  let totalIncome = 0;
  for (const t of txns) {
    if (t.categoryId && excluded.has(t.categoryId)) continue;
    const g = t.categoryId ? groupById.get(t.categoryId) : undefined;
    const eur = toEur(dec(t.amount), t.currency);
    if (t.type === "EXPENSE") {
      if (g === "INCOME") {
        totalIncome -= eur; // pay handed back
        continue;
      }
      const key = t.categoryId ?? "__uncat__";
      spentByCat.set(key, (spentByCat.get(key) ?? 0) + eur);
    } else if (t.categoryId && g != null && g !== "INCOME") {
      spentByCat.set(t.categoryId, (spentByCat.get(t.categoryId) ?? 0) - eur);
    } else {
      totalIncome += eur; // real income, categorised or not — same rule as the trend
    }
  }
  totalIncome += dividends.total;

  const breakdown = Array.from(spentByCat.entries())
    .map(([id, value]) => {
      const info = id === "__uncat__" ? null : catInfo.get(id);
      return { name: info?.name ?? "Uncategorised", color: info?.color ?? "#a59c8e", value };
    })
    .filter((b) => b.value > 0)
    .sort((a, b) => b.value - a.value);

  // Header totals from the unrounded rows. Summing the trend's per-month rounded
  // bars drifted a few euros over 18 months. Same window, same rules as the chart.
  const totalExpense = [...spentByCat.values()].reduce((s, v) => s + v, 0);

  // F6: the same rows, same window and same exclusions, drawn as a flow.
  const sankey = buildSankey(
    txns.map((t) => ({ type: t.type, categoryId: t.categoryId, eur: toEur(dec(t.amount), t.currency) })),
    categories,
    undefined,
    dividends.total > 0 ? [{ name: "Dividends (broker sync)", color: "#5a9a2c", eur: dividends.total }] : [],
  );

  return (
    <div>
      <PageHero
        eyebrow="Insights"
        title="Reports"
        subtitle={
          <>
            {MONTHS} months to {ref.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })} ·{" "}
            {SCOPES.find((s) => s.key === scope)?.label ?? "Personal"} · ≈ EUR (converted)
          </>
        }
      >
        <nav className="hero-seg" aria-label="Accounts shown">
          {SCOPES.map((s) => {
            const Icon = s.icon;
            return (
              <Link key={s.key} href={`/reports?scope=${s.key}`} aria-current={scope === s.key ? "true" : undefined}>
                <Icon size={15} />
                {s.label}
              </Link>
            );
          })}
        </nav>
      </PageHero>

      <div className="bento grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <div className="glass-card p-5">
          <div className="text-sm font-semibold">Income</div>
          <div className="text-3xl font-extrabold tracking-tight tabular-nums mt-1">{formatMoney(totalIncome, true)}</div>
          <div className="text-xs mt-1">
            {MONTHS} months
            {dividends.total > 0 ? ` · incl. ${formatMoney(dividends.total, true)} dividends` : ""}
          </div>
        </div>
        <div className="glass-card p-5">
          <div className="text-sm font-semibold text-ink-soft">Spent</div>
          <div className="text-3xl font-extrabold tracking-tight tabular-nums mt-1">{formatMoney(totalExpense, true)}</div>
          <div className="text-xs text-ink-muted mt-1">{formatMoney(totalExpense / MONTHS, true)} / month</div>
        </div>
        <div className="glass-card p-5">
          <div className="text-sm font-semibold text-ink-soft">{totalIncome >= totalExpense ? "Saved" : "Drawn down"}</div>
          <div className="text-3xl font-extrabold tracking-tight tabular-nums mt-1">
            {formatMoney(Math.abs(totalIncome - totalExpense), true)}
          </div>
          <div className="text-xs text-ink-muted mt-1">
            {totalIncome > 0 ? `${Math.round(((totalIncome - totalExpense) / totalIncome) * 100)}% of income` : "no income in window"}
          </div>
        </div>
        <div className="glass-card p-5">
          <div className="text-sm font-semibold">Biggest category</div>
          <div className="text-2xl font-extrabold tracking-tight mt-1 truncate">{breakdown[0]?.name ?? "—"}</div>
          <div className="text-xs mt-1 tabular-nums">{breakdown[0] ? formatMoney(breakdown[0].value, true) : ""}</div>
        </div>
      </div>

      <div className="glass-card p-6 mb-4">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <h2 className="text-sm text-ink-soft">Income vs expense</h2>
          <span className="text-xs text-ink-muted">
            Total: +{formatMoney(totalIncome, true)} / −{formatMoney(totalExpense, true)}
          </span>
        </div>
        <TrendChart data={trend} />
      </div>

      <div className="glass-card p-6 mb-4">
        <h2 className="text-sm text-ink-soft mb-4">Where the money went</h2>
        <CashflowSankey data={sankey} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="glass-card p-6">
          <h2 className="text-sm text-ink-soft mb-4">Spending by category</h2>
          <CategoryDonut data={breakdown} />
        </div>

        <div className="glass-card p-6">
          <h2 className="text-sm text-ink-soft mb-4">Top categories</h2>
          {breakdown.length > 0 ? (
            <ul className="space-y-3">
              {breakdown.slice(0, 12).map((c) => (
                <li key={c.name}>
                  <div className="flex items-center gap-3 text-sm">
                    <span className="w-3 h-3 rounded shrink-0" style={{ background: c.color }} />
                    <span className="flex-1 truncate font-semibold">{c.name}</span>
                    <span className="tabular-nums font-bold">{formatMoney(c.value)}</span>
                  </div>
                  <div className="mt-1.5 h-2 rounded-full bg-ink/[0.04] overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${Math.min(100, (c.value / (breakdown[0]?.value || 1)) * 100)}%`, background: c.color }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-muted">No spending recorded yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}
