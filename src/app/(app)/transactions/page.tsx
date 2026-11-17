import { redirect } from "next/navigation";
import type { Prisma } from "@prisma/client";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { latestTxnMonth, periodWhere } from "@/lib/finance";
import { dec, monthLabel, monthStart, nextMonthStart } from "@/lib/utils";
import { MonthPicker } from "@/components/MonthPicker";
import {
  TransactionsClient,
  type TxnRow,
  type CatLite,
  type AccountLite,
} from "@/components/TransactionsClient";

import { PageHero } from "@/components/PageHero";

export const dynamic = "force-dynamic";

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; filter?: string; account?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  const userId = session.userId;
  const sp = await searchParams;
  const accountParam = sp.account || "";

  const ref =
    sp.month && /^\d{4}-\d{2}$/.test(sp.month)
      ? new Date(sp.month + "-01T00:00:00Z")
      : await latestTxnMonth(userId);
  const start = monthStart(ref);
  const end = nextMonthStart(ref);

  // The month a row COUNTS in (like every total) is fetched whole — it is what the
  // totals are computed from, so it must never be truncated. On top of that come the
  // extras: any unreviewed row, and (when an account is chosen) that account's full
  // history, so arriving from the Accounts page shows it. Only the extras are capped.
  // One query with `take: 2000` ordered by date let an account's newer rows push the
  // viewed month's own rows out of the window without a word.
  const EXTRA_CAP = 2000;
  const extraOr: Prisma.TransactionWhereInput[] = [{ reviewed: false }];
  if (accountParam) extraOr.push({ accountId: accountParam });

  const [monthTxns, extraTxns, categories, accounts] = await Promise.all([
    prisma.transaction.findMany({
      where: { userId, ...periodWhere(start, end) },
      include: { category: true, account: true, _count: { select: { splits: true } } },
    }),
    prisma.transaction.findMany({
      where: { userId, OR: extraOr },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      take: EXTRA_CAP + 1,
      include: { category: true, account: true, _count: { select: { splits: true } } },
    }),
    prisma.category.findMany({
      where: { userId, isArchived: false },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
    prisma.account.findMany({
      where: { userId, isArchived: false },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
  ]);
  const capped = extraTxns.length > EXTRA_CAP;
  const inMonthIds = new Set(monthTxns.map((t) => t.id));
  const txns = [...monthTxns, ...extraTxns.slice(0, EXTRA_CAP).filter((t) => !inMonthIds.has(t.id))].sort(
    (x, y) => y.date.getTime() - x.date.getTime() || y.createdAt.getTime() - x.createdAt.getTime(),
  );

  const rows: TxnRow[] = txns.map((t) => ({
    id: t.id,
    date: t.date.toISOString(),
    accrualDate: t.accrualDate ? t.accrualDate.toISOString() : null,
    merchant: t.merchant,
    displayMerchant: t.displayMerchant,
    tags: t.tags,
    splitParts: t._count.splits,
    amount: dec(t.amount),
    currency: t.currency,
    type: t.type,
    accountId: t.accountId,
    accountName: t.account?.name ?? null,
    accountColor: t.account?.color ?? null,
    categoryId: t.categoryId,
    categoryName: t.category?.name ?? null,
    categoryColor: t.category?.color ?? null,
    categoryGroup: t.category?.group ?? null,
    inMonth: inMonthIds.has(t.id),
    excluded: t.category?.excludeFromTotals ?? false,
    note: t.note,
    reviewed: t.reviewed,
  }));

  const cats: CatLite[] = categories.map((c) => ({
    id: c.id,
    name: c.name,
    color: c.color,
    group: c.group,
  }));

  const accs: AccountLite[] = accounts.map((a) => ({
    id: a.id,
    name: a.name,
    color: a.color,
  }));

  return (
    <div>
      <PageHero
        eyebrow="Spending"
        title="Transactions"
        subtitle={`${monthLabel(ref)} · search, categorise, split and import statements`}
        actions={<MonthPicker value={ref.toISOString().slice(0, 7)} basePath="/transactions" />}
      />

      <TransactionsClient
        rows={rows}
        categories={cats}
        accounts={accs}
        initialFilter={sp.filter === "review" ? "review" : "all"}
        initialAccount={accountParam}
        monthLabel={monthLabel(ref)}
        capped={capped}
      />
    </div>
  );
}
