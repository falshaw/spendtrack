import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/auth";
import { logError } from "@/lib/logger";
import { parseRequest, AccountBalanceCreateSchema } from "@/lib/validators";

/**
 * A balance typed on /balances. One balance per account per date: entering a
 * figure for a date that already has one replaces it (and marks it MANUAL);
 * a new date adds a newer balance and keeps the old one as history.
 * Statement figures are written by scripts/import-balances.ts, never here.
 */
export async function POST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const parsed = await parseRequest(AccountBalanceCreateSchema, request);
  if (!parsed.success) return parsed.response;
  const d = parsed.data;

  const account = await prisma.account.findFirst({ where: { id: d.accountId, userId }, select: { id: true } });
  if (!account) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }

  const asOf = new Date(d.asOf + "T00:00:00Z");
  try {
    const row = await prisma.accountBalance.upsert({
      where: { accountId_asOf: { accountId: d.accountId, asOf } },
      create: {
        userId,
        accountId: d.accountId,
        asOf,
        balance: d.balance.toFixed(2),
        currency: d.currency,
        source: "manual",
        origin: "MANUAL",
      },
      update: { balance: d.balance.toFixed(2), currency: d.currency, source: "manual", origin: "MANUAL" },
    });
    return NextResponse.json({ id: row.id }, { status: 201 });
  } catch (err) {
    logError("account balance save failed", { route: "/api/account-balances", userId, err });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
