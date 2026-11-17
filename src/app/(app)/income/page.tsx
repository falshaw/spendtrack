import Link from "next/link";
import { redirect } from "next/navigation";
import {
  TrendingUp,
  Wallet,
  CalendarClock,
  Banknote,
  Layers,
  User,
  Briefcase,
} from "lucide-react";
import { getSession } from "@/lib/auth";
import { getIncomeOverview, type Scope } from "@/lib/finance";
import { formatMoney, formatDate, cn, addMonthsUTC, monthStart } from "@/lib/utils";
import { getDividendIncome } from "@/lib/investments-data";
import { withDividendIncome } from "@/lib/investments";
import { TrendChart } from "@/components/charts/TrendChart";

import { PageHero } from "@/components/PageHero";

export const dynamic = "force-dynamic";

const SCOPES: { key: Scope; label: string; icon: typeof Layers }[] = [
  { key: "all", label: "Together", icon: Layers },
  { key: "personal", label: "Personal", icon: User },
  { key: "business", label: "Business", icon: Briefcase },
];

export default async function IncomePage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  const sp = await searchParams;

  const VALID: Scope[] = ["all", "personal", "business"];
  const scope: Scope = VALID.includes(sp.scope as Scope) ? (sp.scope as Scope) : "all";

  const now = new Date();
  const base = await getIncomeOverview(session.userId, now, scope);
  // Synced broker dividends that are not already imported transactions, over the
  // calendar year and the 12-month trend window (whichever starts earlier).
  const trendStart = addMonthsUTC(monthStart(now), -11);
  const yearStart = new Date(Date.UTC(base.year, 0, 1));
  const dividends = await getDividendIncome(
    session.userId,
    trendStart < yearStart ? trendStart : yearStart,
    new Date(Date.UTC(base.year + 1, 0, 1)),
    scope,
  );
  const ov = withDividendIncome(base, dividends.monthly);

  // "What's left each month" needs the ONGOING monthly income, not the soonest payment —
  // the soonest may be a one-off invoice that ends next month. Every ongoing
  // stream counts, not just the largest. The "Next payment" card is the opposite case: it
  // shows the soonest stream's date, so it must print THAT stream's amount (`ov.salary.net`).
  const net = ov.streams
    .filter((s) => !s.ended && s.cadence === "MONTHLY" && s.remainingPayments >= 2)
    .reduce((s, x) => s + x.amount, 0);
  const bills = ov.fixedOutgoings.filter((o) => !o.isTax);
  const taxBills = ov.fixedOutgoings.filter((o) => o.isTax);
  const maxSource = ov.bySource.reduce((m, s) => Math.max(m, s.value), 0);
  const maxStream = ov.streams.reduce((m, s) => Math.max(m, s.remainingTotal), 0);
  const maxMonth = Math.max(1, ...ov.byMonth.map((m) => m.actual + m.projected));
  const projectedTotal = ov.projection?.projectedTotal ?? ov.totalYtd;

  const subtitle =
    scope === "business"
      ? "Business accounts · ≈ EUR · transfers excluded"
      : scope === "personal"
        ? "Personal accounts · ≈ EUR · transfers excluded"
        : "All accounts · ≈ EUR · transfers excluded";

  return (
    <div>
      <PageHero eyebrow="Money" title="Income" subtitle={`${ov.year} · ${subtitle}`}>
        <nav className="hero-seg" aria-label="Accounts shown">
          {SCOPES.map((s) => {
            const Icon = s.icon;
            return (
              <Link key={s.key} href={`/income?scope=${s.key}`} aria-current={scope === s.key ? "true" : undefined}>
                <Icon size={15} />
                {s.label}
              </Link>
            );
          })}
        </nav>
      </PageHero>

      {/* summary */}
      <div className="bento grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
        <div className="glass-card p-5">
          <span className="flex items-center gap-2 text-sm text-ink-soft mb-2">
            <TrendingUp size={16} className="text-accent-green" /> Received {ov.year}
          </span>
          <div className="text-3xl font-extrabold tracking-tight tabular-nums text-accent-green">
            {formatMoney(ov.totalYtd, true)}
          </div>
          <div className="text-xs text-ink-muted mt-1">
            across {ov.monthsWithIncome} month{ov.monthsWithIncome === 1 ? "" : "s"}
          </div>
        </div>
        <div className="glass-card p-5">
          <span className="flex items-center gap-2 text-sm text-ink-soft mb-2">
            <Wallet size={16} className="text-accent-green" /> Projected {ov.year}
          </span>
          <div className="text-3xl font-extrabold tracking-tight tabular-nums text-accent-green">
            {formatMoney(projectedTotal, true)}
          </div>
          <div className="text-xs text-ink-muted mt-1">
            {ov.projection
              ? `${formatMoney(ov.projection.receivedYtd, true)} in + ${formatMoney(ov.projection.remainingSalary, true)} due (${ov.projection.remainingPayments}×)`
              : "received so far · no recurring income in this view"}
          </div>
        </div>
        <div className="glass-card p-5">
          <span className="flex items-center gap-2 text-sm text-ink-soft mb-2">
            <CalendarClock size={16} className="text-ink-soft" /> Next payment
          </span>
          <div className="text-3xl font-extrabold tracking-tight tabular-nums">
            {ov.salary ? formatDate(ov.salary.nextPayDate) : "—"}
          </div>
          <div className="text-xs text-ink-muted mt-1">
            {ov.salary
              ? `${ov.salary.merchant} · ${ov.salary.daysUntil >= 0 ? `in ${ov.salary.daysUntil} days · ` : "due · "}${formatMoney(ov.salary.net)}`
              : "no recurring income in this view"}
          </div>
        </div>
      </div>

      {/* income streams — every active recurring INCOME rule in scope */}
      {ov.streams.length > 0 && (
        <div className="glass-card p-6 mb-4">
          <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
            <h2 className="text-sm text-ink-soft flex items-center gap-2">
              <Banknote size={16} /> Income streams
            </h2>
            <span className="text-xs text-ink-muted">
              still due in {ov.year}
            </span>
          </div>
          <ul className="divide-y divide-ink/[0.06]">
            {ov.streams.map((s) => {
              const ended = s.ended;
              return (
                <li key={s.id} className="py-3 first:pt-0 last:pb-0">
                  <div className="flex items-center justify-between gap-3 mb-1.5 flex-wrap">
                    <span className="flex items-center gap-2 min-w-0 text-sm">
                      {s.accountColor && (
                        <span
                          className="w-2.5 h-2.5 rounded-sm shrink-0"
                          style={{ background: s.accountColor }}
                        />
                      )}
                      <span className={cn("truncate font-medium", ended && "text-ink-muted line-through")}>
                        {s.merchant}
                      </span>
                      {s.accountName && (
                        <span className="text-[10px] uppercase tracking-wide text-ink-muted bg-ink/[0.04] px-1.5 py-0.5 rounded shrink-0">
                          {s.accountName}
                        </span>
                      )}
                      {s.endDate && (
                        <span
                          className={cn(
                            "text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded shrink-0",
                            ended ? "bg-clay/10 text-clay-deep" : "bg-ink/[0.04] text-ink-muted",
                          )}
                        >
                          {ended ? "ended" : "ends"} {formatDate(s.endDate)}
                        </span>
                      )}
                    </span>
                    <span className="tabular-nums text-sm shrink-0">
                      <span className="text-accent-green font-semibold">
                        {formatMoney(s.remainingTotal, true)}
                      </span>
                      <span className="text-ink-muted text-xs ml-1.5">
                        {s.remainingPayments}× {formatMoney(s.amount)}
                      </span>
                    </span>
                  </div>
                  <div className="h-1.5 w-full rounded-full bg-ink/[0.06] overflow-hidden">
                    <div
                      className="h-full rounded-full bg-accent-green"
                      style={{
                        width: `${maxStream > 0 ? (s.remainingTotal / maxStream) * 100 : 0}%`,
                      }}
                    />
                  </div>
                  <div className="text-xs text-ink-muted mt-1">
                    {ended
                      ? "no further payments projected"
                      : `next ${formatDate(s.nextPayDate)}${s.daysUntil >= 0 ? ` · in ${s.daysUntil} days` : " · due"} · ${s.cadence.toLowerCase()}`}
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-ink-muted mt-4 leading-relaxed">
            Projected from your recurring income rules — a rule stops at its end date, so income
            that has finished is not forecast forward.
          </p>
        </div>
      )}

      {/* income by month */}
      <div className="glass-card p-6 mb-4">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <h2 className="text-sm text-ink-soft">Income by month ({ov.year})</h2>
          <span className="text-xs text-ink-muted flex items-center gap-1">
            <span className="inline-block w-2.5 h-2.5 rounded-sm bg-[#008a9e]" /> received
            <span className="inline-block w-2.5 h-2.5 rounded-sm bg-[#008a9e] opacity-40 ml-2" /> projected
          </span>
        </div>
        <div className="flex items-end gap-1.5 h-40">
          {ov.byMonth.map((m) => {
            const total = m.actual + m.projected;
            const h = (total / maxMonth) * 100;
            const projPct = total > 0 ? (m.projected / total) * 100 : 0;
            const actPct = total > 0 ? (m.actual / total) * 100 : 0;
            return (
              <div
                key={m.monthIndex}
                className="flex-1 flex flex-col justify-end h-full"
                title={`${m.label}: ${formatMoney(total)}${m.projected > 0 ? ` (incl. ${formatMoney(m.projected)} projected)` : ""}`}
              >
                <div className="w-full rounded-t-md overflow-hidden flex flex-col" style={{ height: `${h}%` }}>
                  <div className="bg-[#008a9e] opacity-40" style={{ height: `${projPct}%` }} />
                  <div className="bg-[#008a9e]" style={{ height: `${actPct}%` }} />
                </div>
                <span className="text-[10px] text-ink-muted mt-1 text-center">{m.label}</span>
              </div>
            );
          })}
        </div>
        {ov.projection && (
          <p className="text-xs text-ink-muted mt-3">
            Projected {ov.year}: {formatMoney(ov.projection.receivedYtd, true)} received +{" "}
            {formatMoney(ov.projection.remainingSalary, true)} still due ({ov.projection.remainingPayments} payments) ={" "}
            <span className="text-accent-green font-semibold">{formatMoney(ov.projection.projectedTotal, true)}</span>.
          </p>
        )}
      </div>

      {/* by source + trend */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="glass-card p-6">
          <h2 className="text-sm text-ink-soft mb-4">Income by source ({ov.year})</h2>
          {ov.bySource.length > 0 ? (
            <ul className="space-y-3">
              {ov.bySource.map((s) => (
                <li key={s.name} className="text-sm">
                  <div className="flex items-center justify-between mb-1">
                    <span className="flex items-center gap-2 text-ink-soft min-w-0">
                      <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: s.color }} />
                      <span className="truncate">{s.name}</span>
                    </span>
                    <span className="tabular-nums text-ink-soft shrink-0 ml-3">{formatMoney(s.value, true)}</span>
                  </div>
                  <div className="h-1.5 w-full rounded-full bg-ink/[0.06] overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${maxSource > 0 ? (s.value / maxSource) * 100 : 0}%`, background: s.color }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-muted">No income recorded in this view this year.</p>
          )}
        </div>

        <div className="glass-card p-6">
          <h2 className="text-sm text-ink-soft mb-4">12-month income vs expense</h2>
          <TrendChart data={ov.trend} />
        </div>
      </div>

      {/* fixed monthly outgoings */}
      <div className="glass-card p-6 mt-4">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <h2 className="text-sm text-ink-soft">Fixed monthly outgoings</h2>
          <span className="text-lg font-bold tabular-nums text-clay-deep">
            −{formatMoney(ov.fixedOutgoingsTotal)}/mo
          </span>
        </div>
        {ov.fixedOutgoings.length > 0 ? (
          <>
            {[
              { title: null as string | null, rows: bills },
              { title: "of which taxes", rows: taxBills },
            ]
              .filter((g) => g.rows.length > 0)
              .map((g) => (
                <div key={g.title ?? "bills"}>
                  {g.title && (
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted mt-4 mb-1">
                      {g.title} · {formatMoney(g.rows.reduce((s, o) => s + o.monthly, 0))}/mo
                    </div>
                  )}
                  <ul className="divide-y divide-ink/[0.06] text-sm">
                    {g.rows.map((o) => (
                      <li key={o.merchant} className="flex items-center justify-between py-2 gap-3">
                        <span className="text-ink-soft flex items-center gap-2 min-w-0">
                          <span className="truncate">{o.merchant}</span>
                          {o.cadence !== "MONTHLY" && (
                            <span className="text-[10px] uppercase tracking-wide text-ink-muted bg-ink/[0.04] px-1.5 py-0.5 rounded shrink-0">
                              {o.cadence.toLowerCase()} ÷ mo
                            </span>
                          )}
                        </span>
                        <span className="tabular-nums text-ink-soft shrink-0">{formatMoney(o.monthly)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
          </>
        ) : (
          <p className="text-sm text-ink-muted">No recurring bills set up yet.</p>
        )}
        {net > 0 && (
          <div className="mt-4 pt-3 border-t border-line flex items-center justify-between text-sm flex-wrap gap-2">
            <span className="text-ink-soft">
              Monthly income {formatMoney(net)} − {formatMoney(ov.fixedOutgoingsTotal, true)} fixed bills (before
              tax on profit &amp; travel)
            </span>
            <span
              className={cn(
                "font-bold tabular-nums",
                net - ov.fixedOutgoingsTotal >= 0 ? "text-accent-green" : "text-clay-deep",
              )}
            >
              {formatMoney(net - ov.fixedOutgoingsTotal)}/mo left
            </span>
          </div>
        )}
        <p className="text-xs text-ink-muted mt-3 leading-relaxed">
          From your recurring bills (quarterly/yearly normalised to monthly). A credit card balance is not
          included — it varies, so it is not a fixed bill; add it as a recurring rule to track it here.
        </p>
      </div>
    </div>
  );
}
