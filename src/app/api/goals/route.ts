import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/auth";
import { logError } from "@/lib/logger";
import { parseRequest, GoalCreateSchema } from "@/lib/validators";
import { getGoals } from "@/lib/goals-data";
import { checkGoalAccount } from "./account-check";

/** GET — every goal with its progress (F5). Display only. */
export async function GET() {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ goals: await getGoals(userId) });
  } catch (err) {
    logError("goals load failed", { route: "/api/goals", userId, err });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/** POST — create a goal. An ACCOUNT goal needs one of the caller's EARMARKED accounts. */
export async function POST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = await parseRequest(GoalCreateSchema, request);
  if (!parsed.success) return parsed.response;
  const d = parsed.data;

  if (d.source === "ACCOUNT") {
    const problem = await checkGoalAccount(userId, d.accountId ?? null);
    if (problem) return problem;
  }

  const goal = await prisma.goal.create({
    data: {
      userId,
      name: d.name,
      source: d.source,
      target: d.target ?? null,
      targetDate: d.targetDate ? new Date(d.targetDate) : null,
      // Only the field the source reads is kept; the others would be stale noise.
      accountId: d.source === "ACCOUNT" ? (d.accountId ?? null) : null,
      manualAmount: d.source === "MANUAL" ? (d.manualAmount ?? null) : null,
      note: d.note?.trim() || null,
      archived: d.archived ?? false,
      sortOrder: d.sortOrder ?? 0,
    },
    select: { id: true },
  });
  return NextResponse.json({ id: goal.id }, { status: 201 });
}
