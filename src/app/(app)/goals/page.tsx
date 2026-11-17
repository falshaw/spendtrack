import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getGoals } from "@/lib/goals-data";
import { GoalsClient } from "@/components/GoalsClient";
import { PageHero } from "@/components/PageHero";

export const dynamic = "force-dynamic";

export default async function GoalsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const userId = session.userId;
  const [goals, accounts] = await Promise.all([
    getGoals(userId),
    prisma.account.findMany({
      where: { userId, isArchived: false, type: { not: "INVESTMENT" } },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true, earmark: true },
    }),
  ]);

  return (
    <div>
      <PageHero
        eyebrow="Money"
        title="Goals"
        subtitle={
          <>
            What you are saving towards. Display only — a goal never changes &quot;safe to draw&quot;; holding money
            back is still the account earmark on Balances.
          </>
        }
      />
      <GoalsClient goals={goals} accounts={accounts} />
    </div>
  );
}
