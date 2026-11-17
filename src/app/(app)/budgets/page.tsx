import Link from "next/link";
import { redirect } from "next/navigation";
import { Layers, User, Briefcase } from "lucide-react";
import { getSession } from "@/lib/auth";
import { getBudgetStatus, getDashboard, latestTxnMonth, type Scope } from "@/lib/finance";
import { monthLabel } from "@/lib/utils";
import { MonthPicker } from "@/components/MonthPicker";
import { BudgetsClient } from "@/components/BudgetsClient";
import { PageHero } from "@/components/PageHero";

export const dynamic = "force-dynamic";

const SCOPES: { key: Scope; label: string; icon: typeof Layers }[] = [
  { key: "all", label: "Together", icon: Layers },
  { key: "personal", label: "Personal", icon: User },
  { key: "business", label: "Business", icon: Briefcase },
];

export default async function BudgetsPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; scope?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  const sp = await searchParams;

  // Budgets are about personal spending — default to Personal so business
  // Tax/Loan/etc. don't inflate the caps. Toggle to view other scopes.
  const VALID: Scope[] = ["all", "personal", "business"];
  const scope: Scope = VALID.includes(sp.scope as Scope) ? (sp.scope as Scope) : "personal";

  const ref =
    sp.month && /^\d{4}-\d{2}$/.test(sp.month)
      ? new Date(sp.month + "-01T00:00:00Z")
      : await latestTxnMonth(session.userId);

  // Income comes from the dashboard engine, not a query of its own. The private
  // aggregate that used to sit here summed native amounts across currencies, left
  // out uncategorised income and ignored pay handed back (a salary
  // clawback) — so the 50/30/20 split ran against a different income than the
  // dashboard showed for the same month and scope.
  const [categories, dashboard] = await Promise.all([
    getBudgetStatus(session.userId, ref, scope),
    getDashboard(session.userId, ref, scope),
  ]);

  const monthStr = ref.toISOString().slice(0, 7);

  return (
    <div>
      <PageHero
        eyebrow="Plan"
        title="Budgets"
        subtitle={
          <>
            Monthly category caps · {monthLabel(ref)}
            {scope !== "all" && <> · {SCOPES.find((s) => s.key === scope)?.label ?? "Personal"}</>}
          </>
        }
        actions={<MonthPicker value={monthStr} basePath="/budgets" extraQuery={`scope=${scope}`} />}
      >
        {/* Together / Personal / Business — budgets default to Personal */}
        <nav className="hero-seg" aria-label="Accounts shown">
          {SCOPES.map((s) => {
            const Icon = s.icon;
            return (
              <Link
                key={s.key}
                href={`/budgets?month=${monthStr}&scope=${s.key}`}
                aria-current={scope === s.key ? "true" : undefined}
              >
                <Icon size={15} />
                {s.label}
              </Link>
            );
          })}
        </nav>
      </PageHero>

      <BudgetsClient
        categories={categories}
        income={dashboard.income}
      />
    </div>
  );
}
