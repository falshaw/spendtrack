import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/auth";
import { logError } from "@/lib/logger";
import { parseRequest, TransactionUpdateSchema, badId } from "@/lib/validators";
import { learnMerchantRule } from "@/lib/rules";

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
  const existing = await prisma.transaction.findFirst({
    where: { id, userId },
  });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const parsed = await parseRequest(TransactionUpdateSchema, request);
  if (!parsed.success) return parsed.response;
  const d = parsed.data;

  // F3: a split row's amount is pinned by its parts (the DB trigger refuses a
  // mismatch at commit) and its category follows the largest part. Changing either
  // here would fail or drift — the split editor is the place for both.
  const amountChanges = d.amount !== undefined && Math.round(d.amount * 100) !== Math.round(Number(existing.amount) * 100);
  const categoryChanges = d.categoryId !== undefined && d.categoryId !== existing.categoryId;
  if (amountChanges || categoryChanges) {
    const parts = await prisma.transactionSplit.count({ where: { transactionId: id, userId } });
    if (parts > 0) {
      return NextResponse.json(
        { error: "This transaction is split — change its amount or categories in the split editor (or unsplit it first)" },
        { status: 409 },
      );
    }
  }

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

  // Scoped by userId as well as id: the ownership lookup above is a separate
  // query, so the write carries the same guard rather than trusting it.
  try {
    const updated = await prisma.transaction.updateMany({
      where: { id, userId },
      data: {
        ...(d.type !== undefined && { type: d.type }),
        ...(d.amount !== undefined && { amount: d.amount }),
        ...(d.currency !== undefined && { currency: d.currency }),
        ...(d.date !== undefined && { date: new Date(d.date) }),
        ...(d.merchant !== undefined && { merchant: d.merchant }),
        ...(d.accountId !== undefined && { accountId: d.accountId }),
        ...(d.categoryId !== undefined && { categoryId: d.categoryId }),
        ...(d.note !== undefined && { note: d.note }),
        ...(d.reviewed !== undefined && { reviewed: d.reviewed }),
        // Receipt reference: a label only, never a total.
        ...(d.receiptRef !== undefined && {
          receiptRef: d.receiptRef && d.receiptRef.trim() ? d.receiptRef.trim() : null,
        }),
        ...(d.accrualDate !== undefined && {
          accrualDate: d.accrualDate ? new Date(d.accrualDate) : null,
        }),
      },
    });
    if (updated.count === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
  } catch (err) {
    logError("transaction update failed", { route: "/api/transactions/[id]", userId, err });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }

  // Learn the merchant→category association when a category is set.
  const merchant = d.merchant ?? existing.merchant;
  if (d.categoryId) {
    await learnMerchantRule(userId, merchant, d.categoryId).catch(() => {});
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
    result = await prisma.transaction.deleteMany({
      where: { id, userId },
    });
  } catch (err) {
    logError("transaction delete failed", { route: "/api/transactions/[id]", userId, err });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
  if (result.count === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
