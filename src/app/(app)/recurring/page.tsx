import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { dec, formatMoney } from "@/lib/utils";
import { toEur } from "@/lib/currency";
import { recurringHasStarted } from "@/lib/finance";
import { rulePriceChange } from "@/lib/recurring-detect";
import { statusSummary, type RuleStatusKind } from "@/lib/recurring-status";
import { getRecurringStatuses } from "@/lib/money-data";
import { RecurringSuggestions } from "@/components/RecurringSuggestions";
import {
  RecurringClient,
  type RecurringRow,
  type AcctLite,
} from "@/components/RecurringClient";
import type { CatLite } from "@/components/TransactionsClient";

import { PageHero } from "@/components/PageHero";

export const dynamic = "force-dynamic";

const STATUS_FILTERS: RuleStatusKind[] = ["paid", "due", "missed", "unknown", "upcoming"];

export default async function RecurringPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  const userId = session.userId;
  const sp = await searchParams;
  // `/recurring?status=missed` from the dashboard line; anything else shows every rule.
  const statusFilter = STATUS_FILTERS.includes(sp.status as RuleStatusKind) ? (sp.status as RuleStatusKind) : null;

  const [rules, categories, accounts, statuses] = await Promise.all([
    prisma.recurringRule.findMany({
      where: { userId },
      orderBy: [{ active: "desc" }, { nextDate: "asc" }],
      include: {
        category: true,
        account: true,
        // F4 price-change badge: the latest charges linked to the rule.
        transactions: { select: { amount: true, currency: true, date: true }, orderBy: { date: "desc" }, take: 3 },
      },
    }),
    prisma.category.findMany({
      where: { userId, isArchived: false },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
    prisma.account.findMany({
      where: { userId, isArchived: false },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true, color: true },
    }),
    getRecurringStatuses(userId),
  ]);

  // Resolved once per request: the client component must not compare against
  // `now` during render (React purity).
  const today = new Date(new Date().toISOString().slice(0, 10));

  const rows: RecurringRow[] = rules.map((r) => ({
    id: r.id,
    merchant: r.merchant,
    amount: dec(r.amount),
    currency: r.currency,
    type: r.type,
    cadence: r.cadence,
    nextDate: r.nextDate.toISOString(),
    endDate: r.endDate ? r.endDate.toISOString() : null,
    ended: r.endDate != null && r.endDate < today,
    active: r.active,
    categoryId: r.categoryId,
    categoryName: r.category?.name ?? null,
    categoryColor: r.category?.color ?? null,
    accountId: r.accountId,
    accountName: r.account?.name ?? null,
    accountColor: r.account?.color ?? null,
    priceChange: rulePriceChange(
      dec(r.amount),
      r.transactions.map((t) => ({ amount: dec(t.amount), currency: t.currency, date: t.date.toISOString().slice(0, 10) })),
      r.currency,
    ),
    status: statuses[r.id] ?? null,
  }));
  // Counted over the rules shown on this page.
  const summary = statusSummary(rows.map((r) => r.status));

  const cats: CatLite[] = categories.map((c) => ({
    id: c.id,
    name: c.name,
    color: c.color,
    group: c.group,
  }));

  const accts: AcctLite[] = accounts.map((a) => ({
    id: a.id,
    name: a.name,
    color: a.color,
  }));

  // What the live bills cost per month: quarterly ÷3, yearly ÷12, weekly ×52/12.
  // Scope follows the linked account's `biz`; a rule with no account is personal.
  const PER_MONTH = { WEEKLY: 52 / 12, MONTHLY: 1, QUARTERLY: 1 / 3, YEARLY: 1 / 12 } as const;
  const monthly = { PERSONAL: 0, BUSINESS: 0 };
  // ≈EUR like every other total (a GBP subscription is not worth its face value in
  // euros), and a bill that has not started yet is left out — the same two rules the
  // fixed-outgoings panel on /income applies, so the two pages agree.
  for (const r of rules) {
    if (!r.active || r.type !== "EXPENSE" || (r.endDate != null && r.endDate < today)) continue;
    if (!recurringHasStarted(r.nextDate, r.cadence, today)) continue;
    monthly[r.account?.biz ?? "PERSONAL"] += toEur(dec(r.amount), r.currency) * PER_MONTH[r.cadence];
  }
  const totals = [
    { label: "Personal", value: monthly.PERSONAL },
    { label: "Business", value: monthly.BUSINESS },
    { label: "Total", value: monthly.PERSONAL + monthly.BUSINESS },
  ];

  return (
    <div>
      <PageHero eyebrow="Setup" title="Recurring bills" subtitle="Subscriptions, rent, salary and other repeating transactions." />
      <div className="bento grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        {totals.map((t) => (
          <div key={t.label} className="glass-card p-5">
            <div className="text-sm font-semibold text-ink-soft mb-1">{t.label} bills</div>
            <div className="text-3xl font-extrabold tracking-tight tabular-nums">
              {formatMoney(t.value)}
              <span className="text-sm font-semibold text-ink-muted"> /mo</span>
            </div>
          </div>
        ))}
      </div>
      <RecurringSuggestions categories={cats} accounts={accts} />
      <RecurringClient rules={rows} categories={cats} accounts={accts} summary={summary} statusFilter={statusFilter} />
    </div>
  );
}
