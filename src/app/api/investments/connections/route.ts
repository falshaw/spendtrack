import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/auth";
import { logError } from "@/lib/logger";
import { parseRequest, InvestmentConnectionSchema } from "@/lib/validators";
import { ensureConnection } from "@/lib/broker-sync";

/**
 * PATCH { broker, accountId } — link a broker connection to one of the user's
 * INVESTMENT accounts (null unlinks). A linked connection's value REPLACES that
 * account's balance in net worth, and imported dividend rows are matched on it.
 */
export async function PATCH(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = await parseRequest(InvestmentConnectionSchema, request);
  if (!parsed.success) return parsed.response;
  const { broker, accountId } = parsed.data;
  try {
    if (accountId) {
      const acct = await prisma.account.findFirst({ where: { id: accountId, userId, type: "INVESTMENT" }, select: { id: true } });
      if (!acct) return NextResponse.json({ error: "Not an investment account of yours" }, { status: 400 });
      const taken = await prisma.brokerConnection.findFirst({ where: { userId, accountId, NOT: { broker } }, select: { label: true } });
      if (taken) return NextResponse.json({ error: `That account is already linked to ${taken.label}` }, { status: 409 });
    }
    const conn = await ensureConnection(userId, broker);
    await prisma.brokerConnection.update({ where: { id: conn.id }, data: { accountId } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    logError("investments link failed", { route: "/api/investments/connections", userId, err });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
