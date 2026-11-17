import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/auth";
import { logError } from "@/lib/logger";
import { badId } from "@/lib/validators";
import { downloadHeaders } from "@/lib/attachments";

/**
 * GET — download one stored file, scoped `{id, userId}`. Always served as an
 * attachment with nosniff + `CSP: sandbox`, so even a crafted file cannot run in
 * this origin.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const invalid = badId(id);
  if (invalid) return invalid;
  const a = await prisma.transactionAttachment.findFirst({
    where: { id, userId },
    select: { filename: true, mime: true, sizeBytes: true, data: true },
  });
  if (!a) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return new NextResponse(new Uint8Array(a.data), { status: 200, headers: downloadHeaders(a) });
}

/** DELETE — remove one stored file, scoped `{id, userId}`. */
export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const invalid = badId(id);
  if (invalid) return invalid;
  try {
    const r = await prisma.transactionAttachment.deleteMany({ where: { id, userId } });
    if (r.count === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
  } catch (err) {
    logError("attachment delete failed", { route: "/api/attachments/[id]", userId, err });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
