import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/auth";
import { parseRequest, RuleReorderSchema } from "@/lib/validators";

/** POST { ids } — the full USER order; priority = position. Ids that are not the caller's USER rules are refused. */
export async function POST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = await parseRequest(RuleReorderSchema, request);
  if (!parsed.success) return parsed.response;
  const ids = parsed.data.ids;
  if (new Set(ids).size !== ids.length) return NextResponse.json({ error: "Duplicate id" }, { status: 400 });
  const own = await prisma.txnRule.findMany({ where: { userId, tier: "USER" }, select: { id: true } });
  const ownIds = new Set(own.map((r) => r.id));
  if (ids.length !== ownIds.size || ids.some((id) => !ownIds.has(id))) {
    return NextResponse.json({ error: "ids must be exactly your rules" }, { status: 400 });
  }
  await prisma.$transaction(ids.map((id, i) => prisma.txnRule.updateMany({ where: { id, userId }, data: { priority: i } })));
  return NextResponse.json({ ok: true });
}
