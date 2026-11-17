import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/**
 * An ACCOUNT goal tracks money that is held back — the account must be the
 * caller's and carry an earmark (set on /balances), so the goal and the
 * safe-to-draw tile describe the same money. Null = fine; otherwise the 400.
 */
export async function checkGoalAccount(userId: string, accountId: string | null): Promise<NextResponse | null> {
  if (!accountId) return NextResponse.json({ error: "An account goal needs an account" }, { status: 400 });
  const acct = await prisma.account.findFirst({ where: { id: accountId, userId }, select: { earmark: true } });
  if (!acct) return NextResponse.json({ error: "Unknown account" }, { status: 400 });
  if (!acct.earmark || !acct.earmark.trim()) {
    return NextResponse.json({ error: "Earmark the account on /balances first (held back), then set a goal on it" }, { status: 400 });
  }
  return null;
}
