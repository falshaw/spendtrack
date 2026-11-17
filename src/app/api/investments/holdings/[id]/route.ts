import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/auth";
import { logError } from "@/lib/logger";
import { parseRequest, ManualHoldingUpdateSchema, badId } from "@/lib/validators";
import { refreshManualTotals } from "@/lib/investments-data";

/** Only MANUAL holdings can be edited; a synced broker's rows belong to the sync. */
const manualOnly = (id: string, userId: string) => ({ id, userId, connection: { broker: "MANUAL" as const } });

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const invalid = badId(id);
  if (invalid) return invalid;
  const parsed = await parseRequest(ManualHoldingUpdateSchema, request);
  if (!parsed.success) return parsed.response;
  const d = parsed.data;
  try {
    const res = await prisma.investmentHolding.updateMany({
      where: manualOnly(id, userId),
      data: {
        ...(d.name !== undefined && { name: d.name || null }),
        ...(d.quantity !== undefined && { quantity: d.quantity }),
        ...(d.avgCost !== undefined && { avgCost: d.avgCost }),
        ...(d.price !== undefined && { price: d.price }),
        ...(d.currency !== undefined && { currency: d.currency }),
      },
    });
    if (res.count === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
    await refreshManualTotals(userId);
  } catch (err) {
    logError("manual holding update failed", { route: "/api/investments/holdings/[id]", userId, err });
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
  try {
    const res = await prisma.investmentHolding.deleteMany({ where: manualOnly(id, userId) });
    if (res.count === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
    await refreshManualTotals(userId);
  } catch (err) {
    logError("manual holding delete failed", { route: "/api/investments/holdings/[id]", userId, err });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
