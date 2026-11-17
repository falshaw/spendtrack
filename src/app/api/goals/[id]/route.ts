import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/auth";
import { logError } from "@/lib/logger";
import { parseRequest, GoalCreateSchema, GoalUpdateSchema, badId } from "@/lib/validators";
import { dec } from "@/lib/utils";
import { checkGoalAccount } from "../account-check";

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** PATCH — any subset; the merged goal must still be valid for its source. */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const invalid = badId(id);
  if (invalid) return invalid;
  const existing = await prisma.goal.findFirst({ where: { id, userId } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = await parseRequest(GoalUpdateSchema, request);
  if (!parsed.success) return parsed.response;
  const d = parsed.data;

  const merged = {
    name: d.name ?? existing.name,
    source: d.source ?? existing.source,
    target: d.target !== undefined ? d.target : existing.target == null ? null : dec(existing.target),
    targetDate: d.targetDate !== undefined ? d.targetDate : existing.targetDate ? iso(existing.targetDate) : null,
    accountId: d.accountId !== undefined ? d.accountId : existing.accountId,
    manualAmount: d.manualAmount !== undefined ? d.manualAmount : existing.manualAmount == null ? null : dec(existing.manualAmount),
    note: d.note !== undefined ? d.note : existing.note,
    archived: d.archived ?? existing.archived,
    sortOrder: d.sortOrder ?? existing.sortOrder,
  };
  const check = GoalCreateSchema.safeParse(merged);
  if (!check.success) {
    return NextResponse.json({ error: "Validation failed", details: check.error.flatten() }, { status: 400 });
  }
  if (merged.source === "ACCOUNT" && (d.accountId !== undefined || d.source !== undefined)) {
    const problem = await checkGoalAccount(userId, merged.accountId ?? null);
    if (problem) return problem;
  }

  try {
    const updated = await prisma.goal.updateMany({
      where: { id, userId },
      data: {
        name: merged.name,
        source: merged.source,
        target: merged.target,
        targetDate: merged.targetDate ? new Date(merged.targetDate) : null,
        accountId: merged.source === "ACCOUNT" ? merged.accountId : null,
        manualAmount: merged.source === "MANUAL" ? merged.manualAmount : null,
        note: merged.note?.trim() || null,
        archived: merged.archived,
        sortOrder: merged.sortOrder,
      },
    });
    if (updated.count === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
  } catch (err) {
    logError("goal update failed", { route: "/api/goals/[id]", userId, err });
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
  const res = await prisma.goal.deleteMany({ where: { id, userId } });
  if (res.count === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
