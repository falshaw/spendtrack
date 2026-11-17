import { NextResponse } from "next/server";
import { badId } from "@/lib/validators";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/auth";
import { logError } from "@/lib/logger";

/** Removes one stored balance; the account falls back to its previous one (or "missing"). */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const invalid = badId(id);
  if (invalid) return invalid;
  try {
    // Scoped by userId AND id, like every other [id] write.
    const res = await prisma.accountBalance.deleteMany({ where: { id, userId } });
    if (res.count === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    logError("account balance delete failed", { route: "/api/account-balances/[id]", userId, err });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
