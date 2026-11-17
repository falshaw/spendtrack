import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/auth";
import { logError } from "@/lib/logger";
import { parseRequest, ManualHoldingCreateSchema } from "@/lib/validators";
import { ensureConnection } from "@/lib/broker-sync";
import { refreshManualTotals } from "@/lib/investments-data";

/**
 * POST — add a holding to the MANUAL connection (for a broker without an API, or no
 * credentials at all). Synced brokers' holdings are only ever written by the sync.
 */
export async function POST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = await parseRequest(ManualHoldingCreateSchema, request);
  if (!parsed.success) return parsed.response;
  const d = parsed.data;
  try {
    const conn = await ensureConnection(userId, "MANUAL");
    const exists = await prisma.investmentHolding.findUnique({
      where: { connectionId_symbol: { connectionId: conn.id, symbol: d.symbol } },
      select: { id: true },
    });
    if (exists) return NextResponse.json({ error: `${d.symbol} is already listed — edit it instead` }, { status: 409 });
    const row = await prisma.investmentHolding.create({
      data: {
        userId,
        connectionId: conn.id,
        symbol: d.symbol,
        name: d.name || null,
        quantity: d.quantity,
        avgCost: d.avgCost,
        price: d.price ?? null,
        currency: d.currency,
      },
      select: { id: true },
    });
    await refreshManualTotals(userId);
    return NextResponse.json({ ok: true, id: row.id }, { status: 201 });
  } catch (err) {
    logError("manual holding create failed", { route: "/api/investments/holdings", userId, err });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
