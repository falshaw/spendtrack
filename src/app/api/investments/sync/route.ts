import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/auth";
import { logError, logInfo, requestIdOf } from "@/lib/logger";
import { enforce, MIN } from "@/lib/ratelimit";
import { parseRequest, InvestmentSyncSchema } from "@/lib/validators";
import { brokerConfigs, maySync, syncBrokers } from "@/lib/broker-sync";

/**
 * Trading 212 allows one account-summary call per 5 s and 20 history calls a minute;
 * IBKR Flex throttles report requests too. Two syncs a minute per user stays inside both.
 */
const SYNC_PER_MIN = 2;

/** GET — which brokers are configured and what the last sync left. Calls no broker. */
export async function GET() {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const [rows, allowed] = await Promise.all([
      prisma.brokerConnection.findMany({
        where: { userId },
        select: { broker: true, label: true, status: true, lastSyncAt: true, lastSyncMessage: true, asOf: true, accountId: true },
      }),
      maySync(userId),
    ]);
    const byBroker = new Map(rows.map((r) => [r.broker, r]));
    return NextResponse.json({
      sync: { allowed: allowed.ok, reason: allowed.reason ?? null },
      brokers: brokerConfigs().map((c) => {
        const r = byBroker.get(c.broker);
        return {
          broker: c.broker,
          configured: c.configured,
          env: c.env,
          status: r?.status ?? "NEVER",
          lastSyncAt: r?.lastSyncAt?.toISOString() ?? null,
          lastSyncMessage: r?.lastSyncMessage ?? null,
          asOf: r?.asOf ? r.asOf.toISOString().slice(0, 10) : null,
          accountId: r?.accountId ?? null,
        };
      }),
    });
  } catch (err) {
    logError("investments sync status failed", { route: "/api/investments/sync", userId, err });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * POST { broker?: "TRADING212" | "IBKR" } — pull the configured brokers (read-only GETs)
 * and store the result. Each broker succeeds or fails on its own; the answer lists both.
 * 200 = at least one broker synced (possibly PARTIAL); 502 = every configured broker
 * failed; 429 = rate limited (here, or by every broker that was tried).
 */
export async function POST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limited = enforce(`investments-sync:${userId}`, SYNC_PER_MIN, MIN);
  if (limited) return limited;
  const parsed = await parseRequest(InvestmentSyncSchema, request);
  if (!parsed.success) return parsed.response;

  try {
    const allowed = await maySync(userId);
    if (!allowed.ok) return NextResponse.json({ error: allowed.reason }, { status: 403 });

    const configured = brokerConfigs().filter((c) => c.configured && (!parsed.data.broker || c.broker === parsed.data.broker));
    if (!configured.length) {
      return NextResponse.json(
        {
          error: "No broker is connected.",
          hint: "Set TRADING212_API_KEY (+ TRADING212_API_SECRET) or IBKR_FLEX_TOKEN + IBKR_FLEX_QUERY_ID in .env and restart the app.",
        },
        { status: 400 },
      );
    }

    const results = await syncBrokers(userId, parsed.data.broker);
    const tried = results.filter((r) => r.status !== "SKIPPED");
    const synced = tried.filter((r) => r.ok);
    logInfo("investments sync", {
      route: "/api/investments/sync",
      userId,
      requestId: requestIdOf(request),
      results: results.map((r) => ({ broker: r.broker, status: r.status })),
    });
    if (synced.length) return NextResponse.json({ ok: true, results });
    const status = tried.length && tried.every((r) => r.rateLimited) ? 429 : 502;
    return NextResponse.json({ ok: false, error: "Every broker sync failed.", results }, { status });
  } catch (err) {
    logError("investments sync failed", { route: "/api/investments/sync", userId, err });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
