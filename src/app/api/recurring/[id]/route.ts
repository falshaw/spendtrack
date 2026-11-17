import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/auth";
import { logError } from "@/lib/logger";
import { parseRequest, RecurringUpdateSchema, badId } from "@/lib/validators";

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
  const existing = await prisma.recurringRule.findFirst({
    where: { id, userId },
    select: { id: true },
  });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const parsed = await parseRequest(RecurringUpdateSchema, request);
  if (!parsed.success) return parsed.response;
  const d = parsed.data;

  if (d.categoryId) {
    const cat = await prisma.category.findFirst({
      where: { id: d.categoryId, userId },
      select: { id: true },
    });
    if (!cat) {
      return NextResponse.json({ error: "Unknown category" }, { status: 400 });
    }
  }

  if (d.accountId) {
    const acct = await prisma.account.findFirst({
      where: { id: d.accountId, userId },
      select: { id: true },
    });
    if (!acct) {
      return NextResponse.json({ error: "Unknown account" }, { status: 400 });
    }
  }

  // Compare against the stored nextDate when the patch only moves one end.
  if (d.endDate) {
    const current = await prisma.recurringRule.findFirst({
      where: { id, userId },
      select: { nextDate: true },
    });
    const start = d.nextDate ? new Date(d.nextDate) : current?.nextDate;
    if (start && new Date(d.endDate) < start) {
      return NextResponse.json(
        { error: "End date cannot be before the next date" },
        { status: 400 },
      );
    }
  }

  // Scoped by userId as well as id: the ownership lookup above is a separate
  // query, so the write carries the same guard rather than trusting it.
  try {
    const updated = await prisma.recurringRule.updateMany({
      where: { id, userId },
      data: {
        ...(d.merchant !== undefined && { merchant: d.merchant }),
        ...(d.amount !== undefined && { amount: d.amount }),
        ...(d.currency !== undefined && { currency: d.currency }),
        ...(d.type !== undefined && { type: d.type }),
        ...(d.cadence !== undefined && { cadence: d.cadence }),
        ...(d.nextDate !== undefined && { nextDate: new Date(d.nextDate) }),
        ...(d.endDate !== undefined && {
          endDate: d.endDate ? new Date(d.endDate) : null,
        }),
        ...(d.categoryId !== undefined && { categoryId: d.categoryId }),
        ...(d.accountId !== undefined && { accountId: d.accountId }),
        ...(d.active !== undefined && { active: d.active }),
      },
    });
    if (updated.count === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
  } catch (err) {
    logError("recurringRule update failed", { route: "/api/recurring/[id]", userId, err });
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
  let result: { count: number };
  try {
    result = await prisma.recurringRule.deleteMany({
      where: { id, userId },
    });
  } catch (err) {
    logError("recurringRule delete failed", { route: "/api/recurring/[id]", userId, err });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
  if (result.count === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
