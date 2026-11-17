import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getInvestmentsOverview } from "@/lib/investments-data";
import { InvestmentsClient } from "@/components/InvestmentsClient";
import { PageHero } from "@/components/PageHero";

export const dynamic = "force-dynamic";

export default async function InvestmentsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const data = await getInvestmentsOverview(session.userId);

  return (
    <div>
      <PageHero
        eyebrow="Money"
        title="Investments"
        subtitle="Holdings, dividends, trades and cash flows from Trading 212 and Interactive Brokers (read-only), plus anything you add by hand. Values are ≈ EUR; the portfolio counts toward net worth and dividends toward income."
      />
      <InvestmentsClient data={data} />
    </div>
  );
}
