import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/auth";
import { parseRequest, CategoryCreateSchema } from "@/lib/validators";

export async function POST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = await parseRequest(CategoryCreateSchema, request);
  if (!parsed.success) return parsed.response;
  const d = parsed.data;

  const dupe = await prisma.category.findFirst({
    where: { userId, name: d.name },
    select: { id: true },
  });
  if (dupe) {
    return NextResponse.json(
      { error: "A category with that name already exists" },
      { status: 409 },
    );
  }

  const count = await prisma.category.count({ where: { userId } });
  const cat = await prisma.category.create({
    data: {
      userId,
      name: d.name,
      group: d.group,
      color: d.color,
      icon: d.icon ?? null,
      monthlyBudget: d.monthlyBudget ?? null,
      excludeFromTotals: d.excludeFromTotals ?? false,
      sortOrder: count,
    },
  });

  return NextResponse.json({ id: cat.id }, { status: 201 });
}
