import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";
import { dec } from "@/lib/utils";
import { computeNetWorthFor, ensureLastCompleteSnapshot, listSnapshots } from "@/lib/net-worth-data";
import { NetWorthClient } from "@/components/NetWorthClient";
import { PageHero } from "@/components/PageHero";

export const dynamic = "force-dynamic";

export default async function NetWorthPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const userId = session.userId;
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  // The last complete month is snapshotted the first time the page opens after it
  // ends. A failure here must not take the page down — the live figure still shows.
  try {
    await ensureLastCompleteSnapshot(userId, now);
  } catch (err) {
    logError("net worth auto-snapshot failed", { route: "/net-worth", userId, err });
  }

  const [current, snapshots, items] = await Promise.all([
    computeNetWorthFor(userId, today, now),
    listSnapshots(userId),
    prisma.netWorthItem.findMany({ where: { userId }, orderBy: [{ kind: "asc" }, { name: "asc" }] }),
  ]);

  return (
    <div>
      <PageHero
        eyebrow="Money"
        title="Net worth"
        subtitle="Cash balances (as printed on statements, never summed rows) + the latest value of your investment accounts + your other assets − cards owed and debts. The tax reserve is cash already counted, so it is shown beside the total, not added."
      />
      <NetWorthClient
        today={today}
        current={current}
        snapshots={snapshots}
        items={items.map((i) => ({
          id: i.id,
          kind: i.kind,
          name: i.name,
          amount: dec(i.amount),
          currency: i.currency,
          asOf: i.asOf.toISOString().slice(0, 10),
          note: i.note,
        }))}
      />
    </div>
  );
}
