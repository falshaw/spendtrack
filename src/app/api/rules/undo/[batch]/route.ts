import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/auth";
import { logError } from "@/lib/logger";
import { badId } from "@/lib/validators";
import type { LabelState } from "@/lib/rule-apply";

/** POST — restore every row of an apply batch to its logged `before`. Once per batch. */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ batch: string }> }) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { batch } = await params;
  const invalid = badId(batch);
  if (invalid) return invalid;
  const logs = await prisma.ruleApplyLog.findMany({
    where: { userId, batch, undoneAt: null },
    select: { id: true, transactionId: true, before: true },
  });
  if (logs.length === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    await prisma.$transaction([
      ...logs.map((l) => {
        const b = (l.before ?? {}) as Partial<LabelState>;
        return prisma.transaction.updateMany({
          where: { id: l.transactionId, userId },
          data: {
            categoryId: b.categoryId ?? null,
            displayMerchant: b.displayMerchant ?? null,
            note: b.note ?? null,
            tags: Array.isArray(b.tags) ? b.tags : [],
          },
        });
      }),
      prisma.ruleApplyLog.updateMany({ where: { userId, batch, undoneAt: null }, data: { undoneAt: new Date() } }),
    ]);
  } catch (err) {
    logError("rule undo failed", { route: "/api/rules/undo/[batch]", userId, err });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, restored: logs.length });
}
