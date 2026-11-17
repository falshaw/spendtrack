import Link from "next/link";
import { redirect } from "next/navigation";
import {
  TrendingUp,
  TrendingDown,
  ArrowUpRight,
  ArrowDownRight,
  Inbox,
  Briefcase,
  User,
  Layers,
  Receipt,
  PiggyBank,
  Repeat,
  AlertTriangle,
  Scale,
  CalendarDays,
  Plus,
  CandlestickChart,
} from "lucide-react";
import { getSession } from "@/lib/auth";
import {
  getDashboard,
  getYearSummary,
  getTopMerchants,
  getMonthlyTrend,
  defaultDashboardMonth,
  getMonthCoverage,
  type Scope,
} from "@/lib/finance";
import { formatMoney, formatAmount, monthLabel } from "@/lib/utils";
import { CategoryDonut } from "@/components/charts/CategoryDonut";
import { TrendChart } from "@/components/charts/TrendChart";
import { PaceChart } from "@/components/charts/PaceChart";
import { CategoryBar } from "@/components/CategoryBar";
import { MonthPicker } from "@/components/MonthPicker";
import { getSafeToDraw, getRecurringStatuses } from "@/lib/money-data";
import { statusSummary } from "@/lib/recurring-status";
import { ecbRefreshState } from "@/lib/fx";
import { getUnusual } from "@/lib/unusual-data";
import { getPortfolioSummary } from "@/lib/investments-data";

export const dynamic = "force-dynamic";

const UNCAT_COLOR = "#a59c8e";

const SCOPES: { key: Scope; label: string; icon: typeof Layers }[] = [
  { key: "all", label: "Together", icon: Layers },
  { key: "personal", label: "Personal", icon: User },
  { key: "business", label: "Business", icon: Briefcase },
];

// Discretionary = the cuttable stuff; everything else counts as essentials.
const DISCRETIONARY = new Set([
  "Dining Out",
  "Entertainment",
  "Shopping",
  "Travel",
  "Cash",
  "Cash / ATM",
  "Misc / Unnamed",
]);

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; scope?: string; bills?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  const sp = await searchParams;

  const VALID: Scope[] = ["all", "personal", "business"];
  const scope: Scope = VALID.includes(sp.scope as Scope) ? (sp.scope as Scope) : "all";
  const showBills = sp.bills === "1";

  // Default to the latest month that actually has data (imported history is
  // mostly in the past), but let the user navigate months.
  const ref =
    sp.month && /^\d{4}-\d{2}$/.test(sp.month)
      ? new Date(sp.month + "-01T00:00:00Z")
      : await defaultDashboardMonth(session.userId);
  const monthStr = ref.toISOString().slice(0, 7);

  const [d, year, coverage, topMerchants, trend, std, ruleStatuses, unusual, portfolio] = await Promise.all([
    getDashboard(session.userId, ref, scope),
    getYearSummary(session.userId, ref, scope),
    getMonthCoverage(session.userId, ref),
    getTopMerchants(session.userId, ref, scope, 8),
    getMonthlyTrend(session.userId, 6, scope, ref),
    getSafeToDraw(session.userId),
    getRecurringStatuses(session.userId),
    getUnusual(session.userId, ref, scope),
    getPortfolioSummary(session.userId),
  ]);
  // A bill or salary whose statement is in but whose row is not — the one recurring
  // state worth a line here. Due/unknown stay on /recurring.
  const missedBills = statusSummary(Object.values(ruleStatuses)).missed;
  const stdMonth = new Date(std.today + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  // "Nov 03" / "Nov 03, 2026" — read as UTC so the day never slides on the host's timezone.
  const shortDate = (iso: string, withYear = false) =>
    new Date(iso.slice(0, 10) + "T00:00:00Z").toLocaleDateString("en-US", {
      month: "short", day: "2-digit", ...(withYear ? { year: "numeric" as const } : {}), timeZone: "UTC",
    });
  // Only needed for the incomplete-month banner — the most recent month that
  // is fully covered by imported statements.
  const lastCovered = coverage.complete ? null : await defaultDashboardMonth(session.userId);
  const netDelta = d.net - (d.lastIncome - d.lastSpent);
  // The layout tops fx_rates up on its own; this chip only shows when that fetch FAILED.
  const fx = ecbRefreshState();

  // Full category breakdown (all spend categories with activity + uncategorised),
  // largest first. `d.categories` already carries archived-category and uncategorised
  // spend, and a category that refunds pushed NEGATIVE stays in (shown as a credit):
  // both are in the Spent figure, so dropping either made this list add up to a
  // different number.
  const breakdown = d.categories
    .filter((c) => c.group !== "INCOME" && Math.abs(c.spent) >= 0.005)
    .map((c) => ({ name: c.name, value: c.spent, color: c.color }));
  breakdown.sort((a, b) => b.value - a.value);
  const totalSpend = breakdown.reduce((s, x) => s + x.value, 0) || 1;

  // Yearly spend per category — every category itemised, biggest first.
  const yearCats = year.categories.map((c) => ({ name: c.name, value: c.total, color: c.color }));
  const yearTotal = year.total || 1;
  const billsHref = `/dashboard?month=${monthStr}&scope=${scope}${showBills ? "" : "&bills=1"}`;

  let essentials = 0;
  let discretionary = 0;
  for (const c of breakdown) {
    if (DISCRETIONARY.has(c.name)) discretionary += c.value;
    else essentials += c.value;
  }
  const evd = essentials + discretionary || 1;

  // Savings rate only means something against salary-sized income: a month whose
  // pay landed elsewhere would print "-3543%".
  const savingsRate = d.income >= Math.max(500, d.spent * 0.2) ? (d.income - d.spent) / d.income : null;

  // Budget vs actual — categories with a monthly cap set, worst overspend first
  const budgetBars = d.categories
    .filter((c) => c.budget != null && c.budget > 0)
    .sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0));
  const budgetSpent = budgetBars.reduce((s, c) => s + c.spent, 0);
  const daysLeft = d.daysInMonth - d.dayOfMonth;
  const overCaps = budgetBars.filter((c) => (c.pct ?? 0) > 1).length;

  const months = Math.max(1, year.elapsedMonths);
  const noTax = year.total - year.taxTotal;
  const noTaxNoTravel = noTax - year.businessTravelTotal;
  const fixedAsset = year.excluded.find((c) => /fixed asset/i.test(c.name));

  const scopeLabel =
    scope === "business" ? "Business accounts" : scope === "personal" ? "Personal accounts" : "All accounts";

  return (
    <div className="sunset">
      {/* ── hero: the month in one sentence + the tilted panel ── */}
      <section className="su-hero">
        <div className="su-hgrid">
          <div>
            <p className="su-over">Overview · {scopeLabel} · ≈ EUR</p>
            <h1 className="su-h1">{monthLabel(ref)}</h1>
            <p className="su-lead">
              {d.hasBudget ? (
                <>
                  <b>{formatMoney(d.spent, true)}</b> spent of a <b>{formatMoney(d.totalBudget, true)}</b> budget
                  {d.freeToSpend >= 0 ? (
                    <> — {formatMoney(d.freeToSpend, true)} left</>
                  ) : (
                    <> — {formatMoney(-d.freeToSpend, true)} over</>
                  )}
                  {daysLeft > 0 ? `, ${daysLeft} day${daysLeft === 1 ? "" : "s"} to go.` : "."}
                </>
              ) : (
                <>
                  <b>{formatMoney(d.spent, true)}</b> spent and <b>{formatMoney(d.income, true)}</b> in this month.
                </>
              )}
            </p>
            <nav className="su-seg" aria-label="Accounts shown">
              {SCOPES.map((s) => {
                const Icon = s.icon;
                return (
                  <Link
                    key={s.key}
                    href={`/dashboard?month=${monthStr}&scope=${s.key}`}
                    aria-current={scope === s.key ? "true" : undefined}
                  >
                    <Icon size={14} />
                    {s.label}
                  </Link>
                );
              })}
            </nav>
            <div className="su-ctas">
              <Link href="/transactions" className="su-btn su-btn-white">
                <Plus size={16} /> Add transaction
              </Link>
              <MonthPicker value={monthStr} basePath="/dashboard" extraQuery={`scope=${scope}`} />
            </div>
          </div>

          <div className="su-pwrap">
            <div className="su-float su-f1">
              <small>Net this month</small>
              <b>
                {d.net >= 0 ? "+" : "−"}
                {formatMoney(Math.abs(d.net), true)}
              </b>
            </div>
            <div className="su-panel" data-testid="safe-to-draw">
              <div className="su-prog">
                <span className="su-prog-ic">
                  <PiggyBank size={22} />
                </span>
                <div>
                  <span>Safe to draw now</span>
                  <b>{std.safe != null ? formatMoney(std.safe, true) : `> ${formatMoney(std.floor, true)}`}</b>
                </div>
              </div>
              <div className="su-list">
                <p className="su-small px-1 pt-1">Needs you</p>
                {d.toReviewCount > 0 ? (
                  <Link href="/transactions?filter=review" className="su-it">
                    <Inbox size={18} className="text-clay-deep shrink-0" />
                    <span>
                      {d.toReviewCount} {d.toReviewCount === 1 ? "transaction" : "transactions"} to review
                    </span>
                    <em>Review →</em>
                  </Link>
                ) : (
                  <div className="su-it">
                    <Inbox size={18} className="text-olive shrink-0" />
                    <span>Nothing to review</span>
                  </div>
                )}
                {missedBills > 0 && (
                  <Link href="/recurring?status=missed" className="su-it" data-testid="missed-bills">
                    <Repeat size={18} className="text-clay-deep shrink-0" />
                    <span>
                      {missedBills} recurring {missedBills === 1 ? "payment" : "payments"} missed
                    </span>
                    <em>Check →</em>
                  </Link>
                )}
                <p className="su-small px-1 pt-3">Coming up</p>
                {d.upcoming.slice(0, 3).map((u) => (
                  <Link key={u.id} href="/recurring" className="su-it">
                    <span className="su-dot" style={{ background: u.categoryColor ?? UNCAT_COLOR }} />
                    <span className="min-w-0 truncate">
                      {u.merchant}
                      <small>
                        {u.daysUntil <= 0 ? "due now" : u.daysUntil === 1 ? "tomorrow" : `in ${u.daysUntil} days`} ·{" "}
                        {shortDate(u.nextDate)}
                      </small>
                    </span>
                    <em className={u.type === "INCOME" ? "text-accent-green" : undefined}>
                      {u.type === "INCOME" ? "+" : ""}
                      {formatAmount(u.amount, u.currency)}
                    </em>
                  </Link>
                ))}
                {d.upcoming.length === 0 && (
                  <div className="su-it">
                    <CalendarDays size={18} className="text-ink-muted shrink-0" />
                    <span>No recurring bills set up</span>
                  </div>
                )}
              </div>
            </div>
            <div className="su-float su-f2">
              <small>Savings rate</small>
              <b>{savingsRate == null ? "—" : `${Math.round(savingsRate * 100)}%`}</b>
            </div>
          </div>
        </div>
      </section>

      {/* ── stat row floating over the sea strip ── */}
      <div className="su-stats">
        <Link href={`/income?month=${monthStr}`} className="su-stat">
          <span className="su-si">
            <ArrowUpRight size={18} />
          </span>
          <span>Income</span>
          <b>{formatMoney(d.income, true)}</b>
          <small>{formatMoney(d.lastIncome, true)} last month</small>
        </Link>
        <Link href={`/transactions?month=${monthStr}`} className="su-stat">
          <span className="su-si">
            <ArrowDownRight size={18} />
          </span>
          <span>Spent</span>
          <b>{formatMoney(d.spent, true)}</b>
          <small>{formatMoney(d.lastSpent, true)} last month</small>
        </Link>
        <div className={`su-stat${d.net < 0 ? " su-neg" : ""}`}>
          <span className="su-si">{netDelta >= 0 ? <TrendingUp size={18} /> : <TrendingDown size={18} />}</span>
          <span>Net</span>
          <b>{formatMoney(d.net, true)}</b>
          <small>
            {formatMoney(Math.abs(netDelta), true)} {netDelta >= 0 ? "better" : "worse"} than last month
          </small>
        </div>
        <Link href="/budgets" className="su-stat">
          <span className="su-si">
            <Scale size={18} />
          </span>
          <span>Budget caps</span>
          <b>{budgetBars.length > 0 ? `${budgetBars.length - overCaps}/${budgetBars.length}` : "—"}</b>
          <small>{budgetBars.length > 0 ? `on track · ${overCaps} over` : "no caps set yet"}</small>
        </Link>
      </div>

      {fx.lastError && (
        <div className="su-notice" data-testid="fx-stale-chip" title={fx.lastError}>
          <AlertTriangle size={16} className="shrink-0 mt-0.5" />
          <span>
            FX rates {fx.gapDays != null ? `${fx.gapDays} business days` : ""} old
            {fx.latest ? ` (last fixing ${fx.latest})` : ""} — the ECB fetch failed; run{" "}
            <code className="font-mono">npm run fx:update</code> on the host.
          </span>
        </div>
      )}

      {!coverage.complete && (
        <div className="su-notice">
          <AlertTriangle size={16} className="shrink-0 mt-0.5" />
          <span>
            <b>{monthLabel(ref)} is incomplete</b> — {coverage.note}. The latest statement(s) cut off mid-month, so these
            totals are understated.
            {lastCovered ? ` ${monthLabel(lastCovered)} is the last fully-covered month.` : ""}
          </span>
        </div>
      )}

      {/* ── bento of charts ── */}
      <section className="su-sec">
        <p className="su-ey">This month</p>
        <h2 className="su-h2">Where the money goes</h2>
        <p className="su-sub">Spending by category, the budget burn against an even pace, and six months of cash flow.</p>

        <div className="su-bento">
          <div className="su-b su-c7">
            <div className="su-bh">
              <div>
                <h3>Spending by category</h3>
                <p>{breakdown.length} categories with activity</p>
              </div>
              <Link href={`/reports?month=${monthStr}`}>Reports →</Link>
            </div>
            {d.donut.length > 0 ? (
              <CategoryDonut data={d.donut} />
            ) : (
              <p className="su-empty py-10 text-center">No spending in this view for {monthLabel(ref)}.</p>
            )}
          </div>

          <div className="su-b su-c5 su-t-peach">
            <div className="su-bh">
              <div>
                <h3>Budget burn</h3>
                <p>
                  {d.hasBudget
                    ? `Cumulative spend vs an even pace to ${formatMoney(d.totalBudget, true)}`
                    : "Cumulative spend this month"}
                </p>
              </div>
              <span className="su-pill">
                Day {d.dayOfMonth}/{d.daysInMonth}
              </span>
            </div>
            <PaceChart data={d.pace} />
          </div>

          <div className="su-b su-c8">
            <div className="su-bh">
              <div>
                <h3>Income vs spending</h3>
                <p>Last 6 months, ≈ EUR</p>
              </div>
            </div>
            <TrendChart data={trend} />
          </div>

          <div className="su-b su-c4 su-t-coral">
            <div className="su-bh">
              <div>
                <h3>Essentials vs discretionary</h3>
                <p>Discretionary = dining, going out, shopping, travel, cash.</p>
              </div>
            </div>
            <div className="su-split" aria-hidden="true">
              <i style={{ width: `${(essentials / evd) * 100}%`, background: "#fff" }} />
              <i style={{ width: `${(discretionary / evd) * 100}%`, background: "#ffc38a" }} />
            </div>
            <div className="su-kv">
              <div>
                <span>Essentials · {Math.round((essentials / evd) * 100)}%</span>
                <b>{formatMoney(essentials, true)}</b>
              </div>
              <div>
                <span>Discretionary · {Math.round((discretionary / evd) * 100)}%</span>
                <b>{formatMoney(discretionary, true)}</b>
              </div>
            </div>
            <div className="mt-6 pt-4 border-t border-white/30">
              <span className="text-sm font-semibold">Savings rate</span>
              <div className="su-big mt-1">
                {savingsRate == null ? "—" : `${Math.round(savingsRate * 100)}%`}
                <small> of income kept</small>
              </div>
            </div>
          </div>

          <div className="su-b su-c6">
            <div className="su-bh">
              <div>
                <h3>Budget vs actual</h3>
                <p>Worst first · {formatMoney(budgetSpent, true)} spent in capped categories</p>
              </div>
              <Link href="/budgets">Edit caps →</Link>
            </div>
            {budgetBars.length > 0 ? (
              <div className="space-y-4">
                {budgetBars.map((c) => (
                  <CategoryBar key={c.id} slice={c} />
                ))}
              </div>
            ) : (
              <p className="su-empty">
                No budgets set.{" "}
                <Link href="/budgets" className="text-clay-deep font-semibold hover:underline">
                  Set caps →
                </Link>
              </p>
            )}
          </div>

          <div className="su-b su-c6">
            <div className="su-bh">
              <div>
                <h3>All categories</h3>
                <p>{formatMoney(totalSpend, true)} across {breakdown.length} active</p>
              </div>
            </div>
            {breakdown.length > 0 ? (
              <ul className="su-rows su-scroll">
                {breakdown.map((c) => {
                  const pct = (c.value / totalSpend) * 100;
                  return (
                    <li key={c.name}>
                      <div className="su-row">
                        <span className="su-dot" style={{ background: c.color ?? UNCAT_COLOR }} />
                        <span className="su-name">{c.name}</span>
                        <span className="su-amt">{formatMoney(c.value)}</span>
                        <span className="su-pct">{pct.toFixed(0)}%</span>
                      </div>
                      <div className="su-track">
                        {/* a net-refund category is a credit: no bar */}
                        <i style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: c.color ?? UNCAT_COLOR }} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="su-empty">No spending to break down.</p>
            )}
          </div>

          <div className="su-b su-c4 su-t-sea">
            <div className="su-bh">
              <div>
                <h3>Top merchants</h3>
                <p>{monthLabel(ref)}</p>
              </div>
            </div>
            {topMerchants.length > 0 ? (
              <ul className="su-rows">
                {topMerchants.slice(0, 6).map((m, i) => (
                  <li key={m.name} className="su-row">
                    <span className="su-rank">{i + 1}</span>
                    <span className="su-name">{m.name}</span>
                    <span className="su-pct">×{m.count}</span>
                    <span className="su-amt">{formatMoney(m.total, true)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="su-empty">No spending this month.</p>
            )}
          </div>

          <div className="su-b su-c4">
            <div className="su-bh">
              <div>
                <h3>Unusual this month</h3>
                <p>Against the 12 months before — worth a look, not necessarily wrong.</p>
              </div>
            </div>
            {unusual.flags.length > 0 ? (
              <ul className="su-rows">
                {unusual.flags.slice(0, 5).map((f, i) => (
                  <li key={`${f.kind}-${f.txnId ?? f.categoryId ?? i}`} className="text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className={f.kind === "CATEGORY" ? "su-pill" : f.kind === "LARGE" ? "su-pill su-pill-sea" : "su-pill su-pill-leaf"}>
                        {f.kind === "CATEGORY" ? "Category high" : f.kind === "LARGE" ? "Big charge" : "New merchant"}
                      </span>
                      <Link href={`/transactions?month=${unusual.month}`} className="font-extrabold tabular-nums text-ink hover:text-clay-deep">
                        {formatMoney(f.amount)}
                      </Link>
                    </div>
                    <p className="mt-1 truncate font-semibold">
                      {f.kind === "CATEGORY" ? f.categoryName : f.merchant}
                      {f.kind !== "CATEGORY" && f.count > 1 && <span className="text-ink-muted"> ×{f.count}</span>}
                    </p>
                    {f.usual !== null && (
                      <p className="text-xs text-ink-muted">
                        usually {formatMoney(f.usual)}
                        {f.kind === "CATEGORY" ? "/mo" : " a charge"}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="su-empty">Nothing out of the ordinary.</p>
            )}
          </div>

          <div className="su-b su-c4 su-t-leaf" data-testid="portfolio-card">
            <div className="su-bh">
              <div>
                <h3>Portfolio</h3>
                <p>{portfolio.asOf ? `All brokers · as of ${shortDate(portfolio.asOf, true)}` : "Trading 212 · Interactive Brokers · manual"}</p>
              </div>
              <Link href="/investments">Open →</Link>
            </div>
            {portfolio.hasData && portfolio.totalEur != null ? (
              <>
                <div className="su-big">{formatMoney(portfolio.totalEur, true)}</div>
                <div className="su-kv mt-4">
                  <div>
                    <span>Last change{portfolio.change ? ` · since ${shortDate(portfolio.change.since)}` : ""}</span>
                    <b className={portfolio.change && portfolio.change.abs < 0 ? "text-clay-deep" : "text-accent-green"}>
                      {portfolio.change
                        ? `${portfolio.change.abs >= 0 ? "+" : "−"}${formatMoney(Math.abs(portfolio.change.abs), true)}${portfolio.change.pct == null ? "" : ` · ${portfolio.change.pct}%`}`
                        : "—"}
                    </b>
                  </div>
                  <div>
                    <span>Total unrealised</span>
                    <b className={portfolio.pnl.pnl != null && portfolio.pnl.pnl < 0 ? "text-clay-deep" : "text-accent-green"}>
                      {portfolio.pnl.pnl == null
                        ? "—"
                        : `${portfolio.pnl.pnl >= 0 ? "+" : "−"}${formatMoney(Math.abs(portfolio.pnl.pnl), true)}${portfolio.pnl.pct == null ? "" : ` · ${portfolio.pnl.pct}%`}`}
                    </b>
                  </div>
                </div>
              </>
            ) : (
              <p className="su-empty flex items-center gap-2">
                <CandlestickChart size={18} className="shrink-0" />
                <span>
                  {portfolio.connected > 0 ? "Connected — run the first sync." : "No broker connected yet."}{" "}
                  <Link href="/investments" className="text-clay-deep font-semibold hover:underline">
                    Set up →
                  </Link>
                </span>
              </p>
            )}
          </div>

          <div className="su-b su-c8 su-t-sun">
            <div className="su-bh">
              <div>
                <h3>Latest transactions</h3>
                <p>Newest first</p>
              </div>
              <Link href="/transactions">All →</Link>
            </div>
            {d.recent.length > 0 ? (
              <ul className="su-rows">
                {d.recent.slice(0, 6).map((t) => (
                  <li key={t.id} className="su-row">
                    <span className="su-dot" style={{ background: t.categoryColor ?? UNCAT_COLOR }} />
                    <span className="su-name">
                      {t.merchant}
                      <span className="block text-xs font-medium text-ink-muted">
                        {shortDate(t.date)} · {t.categoryName ?? "Uncategorised"}
                      </span>
                    </span>
                    <span className={`su-amt${t.type === "INCOME" ? " text-accent-green" : ""}`}>
                      {t.type === "INCOME" ? "+" : "−"}
                      {formatAmount(t.amount, t.currency)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="su-empty">No transactions yet.</p>
            )}
          </div>
        </div>
      </section>

      {/* ── dark band: the year so far ── */}
      <section className="su-dark">
        <p className="su-ey">The year so far</p>
        <h2 className="su-h2">{year.year} in three numbers</h2>
        <p className="su-sub">
          Over {year.months} month{year.months === 1 ? "" : "s"}, transfers between your own accounts left out.
        </p>
        <div className="su-dgrid">
          <div className="su-dc">
            <span>
              <i className="su-n not-italic">1</i> Spent in {year.year} so far
            </span>
            <b>{formatMoney(year.total, true)}</b>
            <small>
              {formatMoney(year.taxTotal, true)} of it tax · {formatMoney(noTax / months, true)} / month without tax
            </small>
          </div>
          <div className="su-dc">
            <span>
              <i className="su-n not-italic">2</i> Typical month
            </span>
            <b>{formatMoney(year.typicalPerMonth, true)}</b>
            <small>median, one-offs smoothed · mean {formatMoney(year.avgPerMonth, true)}</small>
          </div>
          <div className="su-dc">
            <span>
              <i className="su-n not-italic">3</i> {year.businessTravelTotal > 0 ? "Without tax and business travel" : "Without tax"}
            </span>
            <b>
              {formatMoney(noTaxNoTravel / months, true)}
              <span className="text-base font-semibold"> / month</span>
            </b>
            <small>
              {formatMoney(noTaxNoTravel, true)} for the year
              {year.businessTravelTotal > 0 ? ` · business travel ${formatMoney(year.businessTravelTotal, true)} taken out` : " · the cost of living, month by month"}
              {fixedAsset ? ` · ${fixedAsset.name} (${formatMoney(fixedAsset.out, true)}) not counted` : ""}
            </small>
          </div>
        </div>

        <div className="su-dlist">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-semibold text-white">
              Safe to draw: how the {std.safe != null ? formatMoney(std.safe, true) : "figure"} is worked out
            </p>
            <Link href={billsHref} className="su-dlink">
              <Receipt size={15} />
              {showBills ? "Hide top bills" : `Top bills ${year.year}`}
            </Link>
          </div>
          <p className="su-dnote" data-testid="safe-to-draw-breakdown">
            drawable cash{" "}
            <b>
              {std.cashMissing.length === 0
                ? formatMoney(std.cashDrawable)
                : `${formatMoney(std.cashDrawable)} + MISSING`}
            </b>{" "}
            + owed to you {formatMoney(std.receivables)} − {Math.round(std.rules.taxRate * 100)}% tax on unpaid {formatMoney(std.taxSetAside)} − reserve due now{" "}
            {formatMoney(std.reserve)} − {stdMonth} budget left {formatMoney(std.budgetLeft)}
          </p>
          {std.held.length > 0 && (
            <p className="su-dnote" data-testid="safe-to-draw-held">
              {std.held
                .map((h) => `${h.label} (${h.name}) ${h.amount != null ? formatMoney(h.amount) : "no balance"} — held back`)
                .join(" · ")}
            </p>
          )}
          <p className="su-dnote">
            {std.reserveMissing
              ? "No reserve schedule — nothing is held back as a reserve."
              : `Reserve plan: ${
                  std.reserveReached
                    ? `${std.reserveReached.label} received → ${formatMoney(std.reserve)}`
                    : "no planned invoice received yet → €0"
                }${
                  std.reserveNext
                    ? `; next ${formatMoney(std.reserveNext.reserveAfter)} once ${std.reserveNext.label} (${formatMoney(std.reserveNext.invoicesGross)}, due ${shortDate(std.reserveNext.payDate)}) is in`
                    : ""
                }; target ${formatMoney(std.reserveTarget)}.`}
          </p>
          {std.cashMissing.length > 0 && (
            <p className="su-dnote">
              Missing input: no statement balance for {std.cashMissing.join(", ")} — nothing is guessed, so the panel shows
              the cash it has to exceed.{" "}
              <Link href="/balances" className="underline text-white">
                Enter balances →
              </Link>
            </p>
          )}
          {std.cashStale.length > 0 && (
            <p className="su-dnote" data-testid="safe-to-draw-stale">
              Stale (as-of over 35 days):{" "}
              {std.cashStale.map((c) => `${c.name} ${shortDate(c.asOf, true)}`).join(", ")} — still counted.{" "}
              <Link href="/balances" className="underline text-white">
                Update on Balances →
              </Link>
            </p>
          )}
          {std.receivableLines.length > 0 && (
            <p className="su-dnote">
              Owed: {std.receivableLines.map((r) => `${r.label} ${formatMoney(r.amount)} (due ${shortDate(r.date)})`).join(" · ")}
            </p>
          )}

          {showBills && (
            <div className="mt-5 pt-4 border-t border-white/10">
              <p className="text-sm font-semibold text-white mb-3">
                Where {year.year} went — biggest bills first · {formatMoney(year.total, true)} total
              </p>
              <ul className="su-rows">
                {yearCats.map((b) => {
                  const pct = (b.value / yearTotal) * 100;
                  return (
                    <li key={b.name}>
                      <div className="su-row">
                        <span className="su-dot" style={{ background: b.color }} />
                        <span className="su-name">{b.name}</span>
                        <span className="su-mo text-xs tabular-nums">
                          {formatMoney(b.value / Math.max(1, year.months), true)}/mo
                        </span>
                        <span className="su-amt">{formatMoney(b.value, true)}</span>
                        <span className="su-pct">{pct.toFixed(0)}%</span>
                      </div>
                      <div className="su-track">
                        <i style={{ width: `${Math.min(100, pct)}%`, background: b.color }} />
                      </div>
                    </li>
                  );
                })}
              </ul>
              {/* The big money that is deliberately NOT spending — shown, not vanished. */}
              {year.excluded.length > 0 && (
                <div className="mt-5">
                  <p className="text-xs text-white/80 mb-2">
                    Not counted as spending — capital, money moved to own accounts and brokers (out / in / net)
                  </p>
                  <ul className="su-rows">
                    {year.excluded.map((b) => (
                      <li key={b.name} className="su-row text-sm">
                        <span className="su-dot bg-white/30" />
                        <span className="su-name">{b.name}</span>
                        <span className="su-pct w-auto">{formatMoney(b.out, true)}</span>
                        <span className="su-pct w-auto">{b.inflow > 0 ? formatMoney(b.inflow, true) : "—"}</span>
                        <span className="su-amt">
                          {b.net < 0 ? "+" : ""}
                          {formatMoney(Math.abs(b.net), true)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
