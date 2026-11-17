import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/auth";
import { parseRequest, RecurringCreateSchema } from "@/lib/validators";

export async function POST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = await parseRequest(RecurringCreateSchema, request);
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

  if (d.endDate && new Date(d.endDate) < new Date(d.nextDate)) {
    return NextResponse.json(
      { error: "End date cannot be before the next date" },
      { status: 400 },
    );
  }

  const rule = await prisma.recurringRule.create({
    data: {
      userId,
      merchant: d.merchant,
      amount: d.amount,
      currency: d.currency,
      type: d.type,
      cadence: d.cadence,
      nextDate: new Date(d.nextDate),
      endDate: d.endDate ? new Date(d.endDate) : null,
      categoryId: d.categoryId ?? null,
      accountId: d.accountId ?? null,
      active: d.active ?? true,
    },
  });

  return NextResponse.json({ id: rule.id }, { status: 201 });
}
