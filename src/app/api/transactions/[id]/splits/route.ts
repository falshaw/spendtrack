import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/auth";
import { logError } from "@/lib/logger";
import { parseRequest, SplitsPutSchema, badId } from "@/lib/validators";
import { largestPart, validateSplits } from "@/lib/splits";
import { dec } from "@/lib/utils";

const SELECT = { id: true, amount: true, categoryId: true, note: true, sortOrder: true } as const;

/** GET — the parts of one of the caller's transactions (empty = not split). */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const invalid = badId(id);
  if (invalid) return invalid;
  const txn = await prisma.transaction.findFirst({ where: { id, userId }, select: { id: true, amount: true } });
  if (!txn) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const parts = await prisma.transactionSplit.findMany({ where: { transactionId: id, userId }, orderBy: { sortOrder: "asc" }, select: SELECT });
  return NextResponse.json({ amount: dec(txn.amount), parts: parts.map((p) => ({ ...p, amount: dec(p.amount) })) });
}

/**
 * PUT { parts } — replace the split set. Parts must sum to the row's amount to the
 * cent (checked here and by the deferred DB trigger); [] removes the split. The
 * parent's amount/date/type/currency/account/merchant are never touched; its
 * categoryId follows the largest part so split-blind code still sums right.
 */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const invalid = badId(id);
  if (invalid) return invalid;
  const txn = await prisma.transaction.findFirst({ where: { id, userId }, select: { id: true, amount: true, categoryId: true } });
  if (!txn) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = await parseRequest(SplitsPutSchema, request);
  if (!parsed.success) return parsed.response;
  const parts = parsed.data.parts.map((p) => ({ amount: p.amount, categoryId: p.categoryId ?? null, note: p.note?.trim() || null }));

  const problem = validateSplits(dec(txn.amount), parts);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });

  const catIds = [...new Set(parts.map((p) => p.categoryId).filter((c): c is string => !!c))];
  if (catIds.length) {
    const own = await prisma.category.findMany({ where: { userId, id: { in: catIds } }, select: { id: true } });
    if (own.length !== catIds.length) return NextResponse.json({ error: "Unknown category" }, { status: 400 });
  }

  // Unsplitting keeps whatever category the parent has; splitting moves it to the
  // largest part's (null when no part is categorised — the row then shows as to-review).
  const parentCategory = parts.length ? largestPart(parts) : txn.categoryId;
  try {
    await prisma.$transaction([
      prisma.transactionSplit.deleteMany({ where: { transactionId: id, userId } }),
      ...(parts.length
        ? [
            prisma.transactionSplit.createMany({
              data: parts.map((p, i) => ({ userId, transactionId: id, amount: p.amount, categoryId: p.categoryId, note: p.note, sortOrder: i })),
            }),
          ]
        : []),
      prisma.transaction.updateMany({ where: { id, userId }, data: { categoryId: parentCategory } }),
    ]);
  } catch (err) {
    logError("splits update failed", { route: "/api/transactions/[id]/splits", userId, err });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, parts: parts.length, categoryId: parentCategory });
}
