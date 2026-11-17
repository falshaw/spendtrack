import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/auth";
import { logError } from "@/lib/logger";
import { listSnapshots } from "@/lib/net-worth-data";
import { netWorthCsvRows } from "@/lib/net-worth";
import { toCsv } from "@/lib/csv";

/** GET — every monthly snapshot as CSV (trading null = empty cell, never 0). */
export async function GET() {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const csv = toCsv(netWorthCsvRows(await listSnapshots(userId)));
    return new NextResponse("﻿" + csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="net-worth-${new Date().toISOString().slice(0, 10)}.csv"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    logError("net worth export failed", { route: "/api/net-worth/export", userId, err });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
