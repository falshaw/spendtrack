import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getBalanceRows } from "@/lib/money-data";
import { BalancesClient } from "@/components/BalancesClient";
import { PageHero } from "@/components/PageHero";

export const dynamic = "force-dynamic";

export default async function BalancesPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const rows = await getBalanceRows(session.userId);
  // Passed from the server so the stale/fresh chips cannot hydrate differently.
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div>
      <PageHero
        eyebrow="Money"
        title="Balances"
        subtitle={
          <>
            The real balance of each cash account — the closing balance printed on its latest statement, or a figure
            you entered. Never a sum of imported rows. The dashboard&apos;s &quot;safe to draw&quot; figure uses these.
          </>
        }
      />
      <BalancesClient rows={rows} today={today} />
    </div>
  );
}
