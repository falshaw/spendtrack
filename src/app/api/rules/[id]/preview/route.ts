import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/auth";
import { parseRequest, RuleRangeSchema, badId } from "@/lib/validators";
import { toRuleLite } from "@/lib/rule-engine";
import { planRuleApply } from "@/lib/rule-apply";
import { loadApplyRows, loadRule, PREVIEW_CAP } from "@/lib/rule-apply-db";

/** POST { from, to } — what applying this rule to the window would change. Writes nothing. */
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
  const rows = await loadApplyRows(userId, parsed.data.from, parsed.data.to);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const changes = planRuleApply(rows, toRuleLite(rule));
  const cats = await prisma.category.findMany({ where: { userId }, select: { id: true, name: true } });
  const catName = new Map(cats.map((c) => [c.id, c.name]));
  const name = (cid: string | null) => (cid ? (catName.get(cid) ?? null) : null);
  return NextResponse.json({
    scanned: rows.length,
    capped: rows.length >= PREVIEW_CAP,
    changes: changes.map((c) => {
      const r = byId.get(c.id)!;
      return {
        id: c.id,
        merchant: r.merchant,
        amount: r.amount,
        currency: r.currency,
        type: r.type,
        before: { ...c.before, categoryName: name(c.before.categoryId) },
        after: { ...c.after, categoryName: name(c.after.categoryId) },
      };
    }),
  });
}
