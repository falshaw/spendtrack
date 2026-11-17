import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/auth";
import { logError } from "@/lib/logger";
import { badId } from "@/lib/validators";
import { ATTACHMENTS_PER_TXN, checkAttachment, declaredTooLarge } from "@/lib/attachments";

/** Metadata only — `data` is never selected for a list. */
const META = { id: true, filename: true, mime: true, sizeBytes: true, createdAt: true } as const;

/** GET — the attachments on one of the caller's transactions (no file bytes). */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const invalid = badId(id);
  if (invalid) return invalid;
  const txn = await prisma.transaction.findFirst({ where: { id, userId }, select: { id: true } });
  if (!txn) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const rows = await prisma.transactionAttachment.findMany({
    where: { transactionId: id, userId },
    orderBy: { createdAt: "asc" },
    select: META,
  });
  return NextResponse.json({ attachments: rows });
}

/**
 * POST multipart `file` — attach a receipt/invoice to a transaction. 10 MB cap,
 * checked on the declared length before `formData()` buffers the body and again
 * on the bytes; the type is sniffed from the magic bytes (JPEG/PNG/WEBP/PDF).
 * The same file twice on one row is one attachment (409).
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const invalid = badId(id);
  if (invalid) return invalid;

  if (declaredTooLarge(request.headers.get("content-length"))) {
    return NextResponse.json({ error: "File too large (10 MB max)" }, { status: 413 });
  }
  const txn = await prisma.transaction.findFirst({ where: { id, userId }, select: { id: true } });
  if (!txn) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected a file upload" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "No file provided" }, { status: 400 });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const verdict = checkAttachment(bytes, file.name);
  if (!verdict.ok) return NextResponse.json({ error: verdict.error }, { status: verdict.status });

  const count = await prisma.transactionAttachment.count({ where: { transactionId: id, userId } });
  if (count >= ATTACHMENTS_PER_TXN) {
    return NextResponse.json({ error: `At most ${ATTACHMENTS_PER_TXN} files per transaction` }, { status: 400 });
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const dupe = await prisma.transactionAttachment.findFirst({
    where: { transactionId: id, userId, sha256 },
    select: { id: true },
  });
  if (dupe) return NextResponse.json({ error: "This file is already attached", id: dupe.id }, { status: 409 });

  try {
    const row = await prisma.transactionAttachment.create({
      data: {
        userId,
        transactionId: id,
        filename: verdict.filename,
        mime: verdict.mime,
        sizeBytes: bytes.length,
        sha256,
        data: Buffer.from(bytes),
      },
      select: META,
    });
    return NextResponse.json(row, { status: 201 });
  } catch (err) {
    logError("attachment upload failed", { route: "/api/transactions/[id]/attachments", userId, err });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
