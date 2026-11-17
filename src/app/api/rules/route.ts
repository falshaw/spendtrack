import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/auth";
import { parseRequest, RuleCreateSchema } from "@/lib/validators";

const SELECT = {
  id: true, tier: true, name: true, priority: true, active: true, stopProcessing: true,
  matchText: true, conditions: true, actions: true, createdAt: true, updatedAt: true,
} as const;

/** GET ?tier=USER|LEARNED (default USER) — the caller's rules in evaluation order. */
export async function GET(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const tier = request.nextUrl.searchParams.get("tier") === "LEARNED" ? "LEARNED" : "USER";
  const rules = await prisma.txnRule.findMany({
    where: { userId, tier },
    orderBy: tier === "USER" ? [{ priority: "asc" }, { id: "asc" }] : [{ matchText: "asc" }],
    select: SELECT,
  });
  return NextResponse.json({ rules });
}

/** POST — a new USER rule, appended at the end of the order. */
export async function POST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = await parseRequest(RuleCreateSchema, request);
  if (!parsed.success) return parsed.response;
  const d = parsed.data;

  if (d.actions.categoryId) {
    const cat = await prisma.category.findFirst({ where: { id: d.actions.categoryId, userId }, select: { id: true } });
    if (!cat) return NextResponse.json({ error: "Unknown category" }, { status: 400 });
  }
  if (d.conditions.accountIds?.length) {
    const own = await prisma.account.findMany({ where: { userId, id: { in: d.conditions.accountIds } }, select: { id: true } });
    if (own.length !== new Set(d.conditions.accountIds).size) return NextResponse.json({ error: "Unknown account" }, { status: 400 });
  }
  const last = await prisma.txnRule.findFirst({
    where: { userId, tier: "USER" },
    orderBy: { priority: "desc" },
    select: { priority: true },
  });
  const rule = await prisma.txnRule.create({
    data: {
      userId,
      tier: "USER",
      name: d.name,
      priority: (last?.priority ?? -1) + 1,
      active: d.active ?? true,
      stopProcessing: d.stopProcessing ?? true,
      conditions: d.conditions,
      actions: d.actions,
    },
    select: { id: true },
  });
  return NextResponse.json({ id: rule.id }, { status: 201 });
}
