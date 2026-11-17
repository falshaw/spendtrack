import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/auth";
import { parseRequest, TransactionCreateSchema } from "@/lib/validators";
import { learnMerchantRule, loadRules } from "@/lib/rules";
import { evaluateRules } from "@/lib/rule-engine";

export async function POST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = await parseRequest(TransactionCreateSchema, request);
  if (!parsed.success) return parsed.response;
  const d = parsed.data;

  // Validate the category belongs to this user, if provided.
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
    const acc = await prisma.account.findFirst({
      where: { id: d.accountId, userId },
      select: { id: true },
    });
    if (!acc) {
      return NextResponse.json({ error: "Unknown account" }, { status: 400 });
    }
  }

  // F2: a row typed by hand goes through the rules like an imported one — the
  // category only when none was chosen, the labels always.
  const ruled = evaluateRules(
    { merchant: d.merchant, amount: d.amount, type: d.type, accountId: d.accountId ?? null, currency: d.currency },
    await loadRules(userId),
  );
  const txn = await prisma.transaction.create({
    data: {
      userId,
      type: d.type,
      amount: d.amount,
      currency: d.currency,
      date: new Date(d.date),
      merchant: d.merchant,
      accountId: d.accountId ?? null,
      categoryId: d.categoryId ?? ruled.categoryId,
      note: d.note ?? ruled.note,
      reviewed: d.reviewed ?? true,
      displayMerchant: ruled.displayMerchant,
      tags: ruled.tags,
    },
  });

  if (d.categoryId) {
    await learnMerchantRule(userId, d.merchant, d.categoryId).catch(() => {});
  }

  return NextResponse.json({ id: txn.id }, { status: 201 });
}
