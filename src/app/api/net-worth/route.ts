import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/auth";
import { logError } from "@/lib/logger";
import { computeNetWorthFor, listSnapshots } from "@/lib/net-worth-data";

/** GET — net worth as of today + every stored monthly snapshot (F1). Writes nothing. */
export async function GET() {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const today = new Date().toISOString().slice(0, 10);
    const [current, snapshots] = await Promise.all([computeNetWorthFor(userId, today), listSnapshots(userId)]);
    return NextResponse.json({ current, snapshots });
  } catch (err) {
    logError("net worth load failed", { route: "/api/net-worth", userId, err });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
