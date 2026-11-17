import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/auth";
import { badId } from "@/lib/validators";
import { partsFromReceiptLines } from "@/lib/splits";
import { dec } from "@/lib/utils";

// Same sidecar the receipt import uses; compose sets PARSER_URL, 18000 is the host default.
const PARSER_URL = process.env.PARSER_URL || "http://127.0.0.1:18000";
const IMAGE = new Set(["image/jpeg", "image/png", "image/webp"]);

/**
 * POST — "prefill the split from the receipt": the first image attached to this row
 * (F9) goes through the receipt reader's second pass, and its item lines come back
 * as uncategorised parts for the editor. Writes nothing; the user categorises,
 * adjusts the gap and saves with PUT.
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const invalid = badId(id);
  if (invalid) return invalid;
  const txn = await prisma.transaction.findFirst({ where: { id, userId }, select: { id: true, amount: true } });
  if (!txn) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const att = await prisma.transactionAttachment.findFirst({
    where: { transactionId: id, userId, mime: { in: [...IMAGE] } },
    orderBy: { createdAt: "asc" },
    select: { filename: true, mime: true, data: true },
  });
  if (!att) return NextResponse.json({ error: "Attach a receipt photo (JPEG/PNG/WEBP) to this row first" }, { status: 400 });

  const upstream = new FormData();
  upstream.append("file", new Blob([new Uint8Array(att.data)], { type: att.mime }), att.filename);
  let res: Response;
  try {
    res = await fetch(`${PARSER_URL}/receipt`, {
      method: "POST",
      headers: { "X-Parser-Token": process.env.PARSER_TOKEN ?? "" },
      body: upstream,
      signal: AbortSignal.timeout(300_000),
    });
  } catch (e) {
    return NextResponse.json(
      { error: "The receipt reader is not reachable.", detail: e instanceof Error ? e.message : String(e) },
      { status: 503 },
    );
  }
  let data: { lines?: { label: string; amount: number; currency?: string }[]; error?: string };
  try {
    data = await res.json();
  } catch {
    return NextResponse.json({ error: "The receipt reader returned an unreadable response." }, { status: 502 });
  }
  if (!res.ok) return NextResponse.json({ error: data.error ?? "Receipt read failed" }, { status: res.status });
  const lines = Array.isArray(data.lines) ? data.lines : [];
  const parts = partsFromReceiptLines(lines, dec(txn.amount));
  if (parts.length === 0) {
    return NextResponse.json({ error: "No item lines could be read off that receipt", lines }, { status: 422 });
  }
  return NextResponse.json({ amount: dec(txn.amount), parts, lines: lines.length });
}
