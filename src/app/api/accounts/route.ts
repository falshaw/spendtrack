import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/auth";
import { parseRequest, AccountCreateSchema } from "@/lib/validators";

export async function POST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = await parseRequest(AccountCreateSchema, request);
  if (!parsed.success) return parsed.response;
  const d = parsed.data;

  const dupe = await prisma.account.findFirst({
    where: { userId, name: d.name },
    select: { id: true },
  });
  if (dupe) {
    return NextResponse.json(
      { error: "An account with that name already exists" },
      { status: 409 },
    );
  }

  const count = await prisma.account.count({ where: { userId } });
  const acc = await prisma.account.create({
    data: {
      userId,
      name: d.name,
      institution: d.institution ?? null,
      type: d.type,
      biz: d.biz,
      currency: d.currency,
      color: d.color,
      sortOrder: count,
    },
  });

  return NextResponse.json({ id: acc.id }, { status: 201 });
}
