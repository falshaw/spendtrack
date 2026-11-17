import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/auth";
import { logError } from "@/lib/logger";
import { getInvestmentsOverview } from "@/lib/investments-data";

/**
 * GET — the portfolio as stored: connections (with "not connected" setup hints),
 * holdings, allocation, value history, dividends, trades and cash flows, all ≈EUR.
 * Reads the database only; it never calls a broker (POST /api/investments/sync does).
 */
export async function GET() {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json(await getInvestmentsOverview(userId));
  } catch (err) {
    logError("investments load failed", { route: "/api/investments", userId, err });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
