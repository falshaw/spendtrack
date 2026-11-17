import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/auth";
import { logError } from "@/lib/logger";
import { parseRequest, RuleRangeSchema, badId } from "@/lib/validators";
import { toRuleLite } from "@/lib/rule-engine";
import { planRuleApply } from "@/lib/rule-apply";
import { loadApplyRows, loadRule } from "@/lib/rule-apply-db";

/**
 * POST { from, to } — apply this rule to the window in ONE database transaction,
 * logging every row's before/after under a batch id so POST /api/rules/undo/[batch]
 * can put it back. Only category / display name / note / tags are written: never
 * date, amount, type, currency, account or merchant (the reconciliation keys).
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const invalid = badId(id);
  if (invalid) return invalid;
  const parsed = await parseRequest(RuleRangeSchema, request);
  if (!parsed.success) return parsed.response;
  const rule = await loadRule(userId, id);
  if (!rule) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const lite = toRuleLite(rule);
  if (lite.actions.categoryId) {
    const cat = await prisma.category.findFirst({ where: { id: lite.actions.categoryId, userId }, select: { id: true } });
    if (!cat) return NextResponse.json({ error: "Unknown category" }, { status: 400 });
  }
  const rows = await loadApplyRows(userId, parsed.data.from, parsed.data.to);
  const changes = planRuleApply(rows, lite);
  const batch = crypto.randomUUID();
  if (changes.length === 0) return NextResponse.json({ batch, changed: 0 });
  try {
    await prisma.$transaction([
      ...changes.map((c) =>
        prisma.transaction.updateMany({
          where: { id: c.id, userId },
          data: {
            categoryId: c.after.categoryId,
            displayMerchant: c.after.displayMerchant,
            note: c.after.note,
            tags: c.after.tags,
          },
        }),
      ),
      prisma.ruleApplyLog.createMany({
        data: changes.map((c) => ({
          userId,
          ruleId: rule.id,
          batch,
          transactionId: c.id,
          before: c.before as unknown as Prisma.InputJsonObject,
          after: c.after as unknown as Prisma.InputJsonObject,
        })),
      }),
    ]);
  } catch (err) {
    logError("rule apply failed", { route: "/api/rules/[id]/apply", userId, err });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
  return NextResponse.json({ batch, changed: changes.length });
}
