import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/auth";
import { logError } from "@/lib/logger";
import { parseRequest, RuleUpdateSchema, badId } from "@/lib/validators";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const invalid = badId(id);
  if (invalid) return invalid;
  const existing = await prisma.txnRule.findFirst({ where: { id, userId }, select: { id: true, tier: true } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = await parseRequest(RuleUpdateSchema, request);
  if (!parsed.success) return parsed.response;
  const d = parsed.data;
  // A LEARNED row is one merchant -> one category; only its switch and category may change.
  if (existing.tier === "LEARNED" && (d.conditions !== undefined || d.stopProcessing !== undefined)) {
    return NextResponse.json(
      { error: "A learned rule's conditions cannot be edited; write a rule instead" },
      { status: 400 },
    );
  }
  if (d.actions?.categoryId) {
    const cat = await prisma.category.findFirst({ where: { id: d.actions.categoryId, userId }, select: { id: true } });
    if (!cat) return NextResponse.json({ error: "Unknown category" }, { status: 400 });
  }
  if (d.conditions?.accountIds?.length) {
    const own = await prisma.account.findMany({ where: { userId, id: { in: d.conditions.accountIds } }, select: { id: true } });
    if (own.length !== new Set(d.conditions.accountIds).size) return NextResponse.json({ error: "Unknown account" }, { status: 400 });
  }
  try {
    const updated = await prisma.txnRule.updateMany({
      where: { id, userId },
      data: {
        ...(d.name !== undefined && { name: d.name }),
        ...(d.active !== undefined && { active: d.active }),
        ...(d.stopProcessing !== undefined && { stopProcessing: d.stopProcessing }),
        ...(d.conditions !== undefined && { conditions: d.conditions }),
        ...(d.actions !== undefined && { actions: d.actions }),
      },
    });
    if (updated.count === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
  } catch (err) {
    logError("rule update failed", { route: "/api/rules/[id]", userId, err });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const invalid = badId(id);
  if (invalid) return invalid;
  // rule_apply_log.rule_id is ON DELETE SET NULL: the undo history survives.
  let result: { count: number };
  try {
    result = await prisma.txnRule.deleteMany({ where: { id, userId } });
  } catch (err) {
    logError("rule delete failed", { route: "/api/rules/[id]", userId, err });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
  if (result.count === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
