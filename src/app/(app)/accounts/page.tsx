import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { toEur } from "@/lib/currency";
import { dec } from "@/lib/utils";
import { AccountsClient, type AccountFull } from "@/components/AccountsClient";
import { PageHero } from "@/components/PageHero";

export const dynamic = "force-dynamic";

export default async function AccountsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const userId = session.userId;

  const [accounts, txns] = await Promise.all([
    prisma.account.findMany({
      where: { userId },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
    prisma.transaction.findMany({
      where: { userId, accountId: { not: null } },
      select: { id: true, accountId: true, amount: true, currency: true, type: true, date: true },
    }),
  ]);

  const stats = new Map<
    string,
    { balanceEur: number; count: number; lastDate: Date | null }
  >();
  for (const t of txns) {
    if (!t.accountId) continue;
    const s =
      stats.get(t.accountId) ?? { balanceEur: 0, count: 0, lastDate: null };
    const eur = toEur(dec(t.amount), t.currency);
    s.balanceEur += t.type === "INCOME" ? eur : -eur;
    s.count += 1;
    // Hand-entered placeholders (txn-*) stand in for charges the next statement will
    // bring — they are not the data's edge, so they never set "last".
    if (!t.id.startsWith("txn-") && (!s.lastDate || t.date > s.lastDate)) s.lastDate = t.date;
    stats.set(t.accountId, s);
  }

  const data: AccountFull[] = accounts.map((a) => {
    const s = stats.get(a.id);
    return {
      id: a.id,
      name: a.name,
      institution: a.institution,
      type: a.type,
      biz: a.biz,
      currency: a.currency,
      color: a.color,
      isArchived: a.isArchived,
      balanceEur: s?.balanceEur ?? 0,
      count: s?.count ?? 0,
      lastDate: s?.lastDate ? s.lastDate.toISOString() : null,
    };
  });

  return (
    <div>
      <PageHero
        eyebrow="Money"
        title="Accounts"
        subtitle={
          <>
            Your banks, cards and wallets. Figures are the net flow of imported rows since each account&apos;s first
            import (≈ EUR) — not the bank balance, which needs the statement&apos;s own figure.
          </>
        }
      />
      <AccountsClient accounts={data} />
    </div>
  );
}
