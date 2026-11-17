import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/auth";
import { logError } from "@/lib/logger";
import { parseRequest, RecurringConfirmSchema } from "@/lib/validators";
import { loadSuggestions } from "@/lib/recurring-suggest";

/**
 * POST { key, merchant?, categoryId? } — turn a suggestion into a RecurringRule
 * (amount = the last charge, nextDate = the next occurrence after today) and LINK
 * its past rows (`recurringId`). The suggestion is re-detected here, never taken
 * from the client. Linking is a label: no amount/date/type/currency/account/merchant
 * changes, so the reconciliation does not move.
 */
export async function POST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = await parseRequest(RecurringConfirmSchema, request);
  if (!parsed.success) return parsed.response;
  const d = parsed.data;

  let suggestion;
  try {
    suggestion = (await loadSuggestions(userId)).find((s) => s.key === d.key);
  } catch (err) {
    logError("recurring confirm: detect failed", { route: "/api/recurring/suggestions/confirm", userId, err });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
  if (!suggestion) return NextResponse.json({ error: "That suggestion no longer applies" }, { status: 404 });

  const categoryId = d.categoryId === undefined ? suggestion.categoryId : d.categoryId;
  if (categoryId) {
    const cat = await prisma.category.findFirst({ where: { id: categoryId, userId }, select: { id: true } });
    if (!cat) return NextResponse.json({ error: "Unknown category" }, { status: 400 });
  }

  const s = suggestion;
  try {
    const result = await prisma.$transaction(async (tx) => {
      const rule = await tx.recurringRule.create({
        data: {
          userId,
          merchant: d.merchant ?? s.merchant,
          amount: s.amount,
          currency: s.currency,
          type: s.type,
          cadence: s.cadence,
          nextDate: new Date(`${s.nextDate}T00:00:00Z`),
          categoryId: categoryId ?? null,
          accountId: s.accountId,
          active: true,
        },
        select: { id: true },
      });
      const linked = await tx.transaction.updateMany({
        where: { userId, id: { in: s.txnIds }, recurringId: null },
        data: { recurringId: rule.id },
      });
      return { id: rule.id, linked: linked.count };
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    logError("recurring confirm failed", { route: "/api/recurring/suggestions/confirm", userId, err });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
