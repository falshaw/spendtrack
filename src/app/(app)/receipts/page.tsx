import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getReceiptRows } from "@/lib/money-data";
import { ReceiptsClient } from "@/components/ReceiptsClient";
import { PageHero } from "@/components/PageHero";

export const dynamic = "force-dynamic";

export default async function ReceiptsPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  const sp = await searchParams;
  const thisYear = new Date().getUTCFullYear();
  const year = sp.year && /^\d{4}$/.test(sp.year) ? Number(sp.year) : thisYear;
  const data = await getReceiptRows(session.userId, new Date(Date.UTC(year, 0, 1)));
  // Only rows of the chosen year: the loader's `from` is a lower bound.
  const rows = data.rows.filter((r) => !r.date || r.date < `${year + 1}-01-01`);

  return (
    <div>
      <PageHero
        eyebrow="Setup"
        title="Missing receipts"
        subtitle="Business costs that need a receipt on file: every outgoing on a business account (own-account transfers and other excluded categories left out). A receipt reference or an attached file counts as covered."
      />
      <ReceiptsClient rows={rows} year={year} thisYear={thisYear} />
    </div>
  );
}
