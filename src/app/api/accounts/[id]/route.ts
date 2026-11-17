import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/auth";
import { logError } from "@/lib/logger";
import { parseRequest, AccountUpdateSchema, badId } from "@/lib/validators";

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
  const existing = await prisma.account.findFirst({ where: { id, userId } });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const parsed = await parseRequest(AccountUpdateSchema, request);
  if (!parsed.success) return parsed.response;
  const d = parsed.data;

  if (d.name && d.name !== existing.name) {
    const dupe = await prisma.account.findFirst({
      where: { userId, name: d.name, id: { not: id } },
      select: { id: true },
    });
    if (dupe) {
      return NextResponse.json(
        { error: "An account with that name already exists" },
        { status: 409 },
      );
    }
  }

  // Scoped by userId as well as id: the ownership lookup above is a separate
  // query, so the write carries the same guard rather than trusting it.
  try {
    const updated = await prisma.account.updateMany({
      where: { id, userId },
      data: {
        ...(d.name !== undefined && { name: d.name }),
        ...(d.institution !== undefined && { institution: d.institution }),
        ...(d.type !== undefined && { type: d.type }),
        ...(d.biz !== undefined && { biz: d.biz }),
        ...(d.currency !== undefined && { currency: d.currency }),
        ...(d.color !== undefined && { color: d.color }),
        ...(d.isArchived !== undefined && { isArchived: d.isArchived }),
        ...(d.sortOrder !== undefined && { sortOrder: d.sortOrder }),
        ...(d.earmark !== undefined && { earmark: d.earmark }),
      },
    });
    if (updated.count === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
  } catch (err) {
    logError("account update failed", { route: "/api/accounts/[id]", userId, err });
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
  // Transactions keep their history (accountId -> null via SetNull).
  let result: { count: number };
  try {
    result = await prisma.account.deleteMany({ where: { id, userId } });
  } catch (err) {
    logError("account delete failed", { route: "/api/accounts/[id]", userId, err });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
  if (result.count === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
