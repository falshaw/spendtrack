import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/auth";
import { logError } from "@/lib/logger";
import { parseRequest, RecurringDismissSchema } from "@/lib/validators";

/** POST { key } — never suggest this group again (F4). Idempotent. */
export async function POST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = await parseRequest(RecurringDismissSchema, request);
  if (!parsed.success) return parsed.response;
  try {
    await prisma.recurringDismissal.upsert({
      where: { userId_key: { userId, key: parsed.data.key } },
      create: { userId, key: parsed.data.key },
      update: {},
    });
  } catch (err) {
    logError("recurring dismiss failed", { route: "/api/recurring/suggestions/dismiss", userId, err });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
