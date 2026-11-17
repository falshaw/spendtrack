import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/auth";
import { logError } from "@/lib/logger";
import { parseRequest, CategoryUpdateSchema, badId } from "@/lib/validators";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  const invalid = badId(id);
  if (invalid) return invalid;
  const existing = await prisma.category.findFirst({ where: { id, userId } });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const parsed = await parseRequest(CategoryUpdateSchema, request);
  if (!parsed.success) return parsed.response;
  const d = parsed.data;

  if (d.name && d.name !== existing.name) {
    const dupe = await prisma.category.findFirst({
      where: { userId, name: d.name, id: { not: id } },
      select: { id: true },
    });
    if (dupe) {
      return NextResponse.json(
        { error: "A category with that name already exists" },
        { status: 409 },
      );
    }
  }

  // Scoped by userId as well as id: the ownership lookup above is a separate
  // query, so the write carries the same guard rather than trusting it.
  try {
    const updated = await prisma.category.updateMany({
      where: { id, userId },
      data: {
        ...(d.name !== undefined && { name: d.name }),
        ...(d.group !== undefined && { group: d.group }),
        ...(d.color !== undefined && { color: d.color }),
        ...(d.icon !== undefined && { icon: d.icon }),
        ...(d.monthlyBudget !== undefined && { monthlyBudget: d.monthlyBudget }),
        ...(d.excludeFromTotals !== undefined && {
          excludeFromTotals: d.excludeFromTotals,
        }),
        ...(d.isArchived !== undefined && { isArchived: d.isArchived }),
        ...(d.sortOrder !== undefined && { sortOrder: d.sortOrder }),
      },
    });
    if (updated.count === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
  } catch (err) {
    logError("category update failed", { route: "/api/categories/[id]", userId, err });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  const invalid = badId(id);
  if (invalid) return invalid;
  // Transactions keep their history (categoryId -> null via SetNull).
  let result: { count: number };
  try {
    result = await prisma.category.deleteMany({ where: { id, userId } });
  } catch (err) {
    logError("category delete failed", { route: "/api/categories/[id]", userId, err });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
  if (result.count === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
