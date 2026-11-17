import { NextRequest, NextResponse } from "next/server";
import { requireUserId } from "@/lib/auth";
import { logError } from "@/lib/logger";
import { parseRequest, NetWorthSnapshotSchema } from "@/lib/validators";
import { snapshotMonth } from "@/lib/net-worth-data";
import { lastCompleteMonth } from "@/lib/net-worth";

/**
 * POST { month?: "YYYY-MM" } — compute and store (replace) that month's snapshot;
 * omitted = the last complete month. The running month may be snapshotted (as of
 * today) and is replaced again once it is complete; a future month cannot.
 */
export async function POST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = await parseRequest(NetWorthSnapshotSchema, request);
  if (!parsed.success) return parsed.response;
  const today = new Date().toISOString().slice(0, 10);
  const month = parsed.data.month ? `${parsed.data.month}-01` : lastCompleteMonth(today);
  if (month > `${today.slice(0, 7)}-01`) {
    return NextResponse.json({ error: "A future month cannot be snapshotted" }, { status: 400 });
  }
  try {
    const r = await snapshotMonth(userId, month);
    return NextResponse.json({ ok: true, month: r.month, net: r.net, estimated: r.estimated });
  } catch (err) {
    logError("net worth snapshot failed", { route: "/api/net-worth/snapshot", userId, err });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
