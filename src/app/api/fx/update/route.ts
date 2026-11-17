import { NextRequest, NextResponse } from "next/server";
import { requireUserId } from "@/lib/auth";
import { logError } from "@/lib/logger";
import { parseRequest, FxUpdateSchema } from "@/lib/validators";
import { fetchAndSaveEcb } from "@/lib/fx";

/**
 * Pull the ECB euro reference rates into `fx_rates` on demand. `mode: "daily"` =
 * today's fixing, `"hist90"` = the last ~90 business days. Authenticated like every
 * other write: it is an outbound call plus a DB write, not a public endpoint.
 * If the container has no outbound network, run `npm run fx:update` on the host.
 */
export async function POST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const parsed = await parseRequest(FxUpdateSchema, request);
  if (!parsed.success) return parsed.response;

  try {
    const result = await fetchAndSaveEcb(parsed.data.mode);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    logError("ECB fx update failed", { route: "/api/fx/update", userId, err });
    return NextResponse.json(
      { error: "Could not fetch the ECB rates — run `npm run fx:update` on the host instead" },
      { status: 502 },
    );
  }
}
