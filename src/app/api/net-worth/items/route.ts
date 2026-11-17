import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/auth";
import { parseRequest, NetWorthItemCreateSchema } from "@/lib/validators";
import { dec } from "@/lib/utils";

/** GET — the caller's net-worth items (car, other assets, debts). */
export async function GET() {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const items = await prisma.netWorthItem.findMany({ where: { userId }, orderBy: [{ kind: "asc" }, { name: "asc" }] });
  return NextResponse.json({ items: items.map((i) => ({ ...i, amount: dec(i.amount), asOf: i.asOf.toISOString().slice(0, 10) })) });
}

/** POST — add an item. */
export async function POST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = await parseRequest(NetWorthItemCreateSchema, request);
  if (!parsed.success) return parsed.response;
  const d = parsed.data;
  const item = await prisma.netWorthItem.create({
    data: {
      userId,
      kind: d.kind,
      name: d.name,
      amount: d.amount,
      currency: d.currency,
      asOf: new Date(d.asOf),
      note: d.note?.trim() || null,
    },
    select: { id: true },
  });
  return NextResponse.json({ id: item.id }, { status: 201 });
}
