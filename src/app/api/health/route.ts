import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// Docker's healthcheck hits this. It used to return a static "ok", which meant
// the container reported healthy while Postgres was unreachable and every page
// in the app was 500-ing — a health check that cannot fail is not a check. It
// now round-trips the database.
export const dynamic = "force-dynamic";

export async function GET() {
  const startedAt = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({
      status: "ok",
      app: "spendtrack",
      database: "up",
      latencyMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
    });
  } catch {
    // Public route — say that the dependency is down, never why.
    return NextResponse.json(
      {
        status: "degraded",
        app: "spendtrack",
        database: "down",
        timestamp: new Date().toISOString(),
      },
      { status: 503 },
    );
  }
}
