import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/auth";
import { logError } from "@/lib/logger";
import { loadSuggestions } from "@/lib/recurring-suggest";

/** GET — repeating charges that are not a recurring rule yet (F4). Writes nothing. */
export async function GET() {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const suggestions = await loadSuggestions(userId);
    return NextResponse.json({ suggestions });
  } catch (err) {
    logError("recurring suggestions failed", { route: "/api/recurring/suggestions", userId, err });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
