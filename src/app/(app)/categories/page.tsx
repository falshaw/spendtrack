import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { dec } from "@/lib/utils";
import { CategoriesClient, type CatFull } from "@/components/CategoriesClient";
import { PageHero } from "@/components/PageHero";

export const dynamic = "force-dynamic";

export default async function CategoriesPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const categories = await prisma.category.findMany({
    where: { userId: session.userId },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });

  const cats: CatFull[] = categories.map((c) => ({
    id: c.id,
    name: c.name,
    group: c.group,
    color: c.color,
    monthlyBudget: c.monthlyBudget == null ? null : dec(c.monthlyBudget),
    excludeFromTotals: c.excludeFromTotals,
    isArchived: c.isArchived,
  }));

  return (
    <div>
      <PageHero eyebrow="Setup" title="Categories" subtitle="Organise spending into buckets, set colours and monthly caps." />
      <div className="max-w-4xl">
        <CategoriesClient categories={cats} />
      </div>
    </div>
  );
}
