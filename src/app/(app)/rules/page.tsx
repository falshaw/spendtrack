import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { RulesClient, type RuleRow } from "@/components/RulesClient";
import { toRuleLite } from "@/lib/rule-engine";
import { PageHero } from "@/components/PageHero";

export const dynamic = "force-dynamic";

export default async function RulesPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const userId = session.userId;

  const [rules, categories, accounts] = await Promise.all([
    prisma.txnRule.findMany({
      where: { userId },
      orderBy: [{ tier: "asc" }, { priority: "asc" }, { matchText: "asc" }, { id: "asc" }],
      select: { id: true, tier: true, name: true, priority: true, active: true, stopProcessing: true, matchText: true, conditions: true, actions: true },
    }),
    prisma.category.findMany({ where: { userId, isArchived: false }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true, name: true } }),
    prisma.account.findMany({ where: { userId, isArchived: false }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true, name: true } }),
  ]);

  const rows: RuleRow[] = rules.map((r) => ({ ...toRuleLite(r), name: r.name }));
  const user = rows.filter((r) => r.tier === "USER").sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : 1));
  const learned = rows.filter((r) => r.tier === "LEARNED");

  return (
    <div>
      <PageHero
        eyebrow="Setup"
        title="Rules"
        subtitle="Rules run on every import and on rows typed by hand, top to bottom. A rule sets a category, a display name, a note or tags — never the date, amount, type, currency, account or the raw merchant, so the reconciliation keys stay as the statement printed them. A parser's own category still outranks a rule, and the keyword map fills what no rule sets. Preview shows what an apply would change before anything is written."
      />
      <RulesClient user={user} learned={learned} categories={categories} accounts={accounts} />
    </div>
  );
}
