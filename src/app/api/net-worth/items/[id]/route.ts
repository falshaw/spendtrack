import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/auth";
import { logError } from "@/lib/logger";
import { parseRequest, NetWorthItemUpdateSchema, badId } from "@/lib/validators";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const invalid = badId(id);
  if (invalid) return invalid;
  const parsed = await parseRequest(NetWorthItemUpdateSchema, request);
  if (!parsed.success) return parsed.response;
  const d = parsed.data;
  try {
    const res = await prisma.netWorthItem.updateMany({
      where: { id, userId },
      data: {
        ...(d.kind !== undefined && { kind: d.kind }),
        ...(d.name !== undefined && { name: d.name }),
        ...(d.amount !== undefined && { amount: d.amount }),
        ...(d.currency !== undefined && { currency: d.currency }),
        ...(d.asOf !== undefined && { asOf: new Date(d.asOf) }),
        ...(d.note !== undefined && { note: d.note?.trim() || null }),
      },
    });
    if (res.count === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
  } catch (err) {
    logError("net worth item update failed", { route: "/api/net-worth/items/[id]", userId, err });
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
  const res = await prisma.netWorthItem.deleteMany({ where: { id, userId } });
  if (res.count === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
