import { NextRequest, NextResponse } from "next/server";
import { badId } from "@/lib/validators";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/auth";
import { advanceByCadence } from "@/lib/utils";

/**
 * "Log now": post this recurring rule as a real transaction (dated on its
 * due date) and roll nextDate forward by one cadence step.
 */
export async function POST(
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
  const rule = await prisma.recurringRule.findFirst({ where: { id, userId } });
  if (!rule) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const txnDate = new Date(rule.nextDate);

  // An ended or switched-off rule must not mint money: `endDate` is the LAST date
  // the rule can fire (a salary rule that ends 31.07 — logging it in August would
  // invent a payment that never came).
  if (!rule.active) {
    return NextResponse.json({ error: "This rule is inactive" }, { status: 409 });
  }
  if (rule.endDate && txnDate > rule.endDate) {
    return NextResponse.json({ error: "This rule has ended" }, { status: 409 });
  }
  // Idempotent per occurrence: a double-click posted the same bill twice.
  const already = await prisma.transaction.findFirst({
    where: { userId, recurringId: rule.id, date: txnDate },
    select: { id: true },
  });
  if (already) {
    return NextResponse.json({ error: "Already logged for this date" }, { status: 409 });
  }

  const nextDate = advanceByCadence(txnDate, rule.cadence);

  await prisma.$transaction([
    prisma.transaction.create({
      data: {
        userId,
        // The rule's account carries its scope (an invoice rule → a business account).
        // Without it the row landed account-less = Personal, and the importers, which
        // dedup per account, could not see it — the statement row imported as a twin.
        accountId: rule.accountId,
        type: rule.type,
        amount: rule.amount,
        currency: rule.currency,
        date: txnDate,
        merchant: rule.merchant,
        categoryId: rule.categoryId,
        recurringId: rule.id,
        reviewed: true,
        note: "Recurring",
      },
    }),
    prisma.recurringRule.update({
      where: { id: rule.id },
      data: { nextDate },
    }),
  ]);

  return NextResponse.json({ ok: true, nextDate: nextDate.toISOString() });
}
