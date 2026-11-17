import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/auth";
import { loadRules } from "@/lib/rules";
import { evaluateRules } from "@/lib/rule-engine";
import { categoriseSlug, slugToCategoryId } from "@/lib/categorise";

/**
 * Read ONE transaction off a photographed or scanned receipt, using the local
 * vision model (Ollama on the host GPU, via the parser sidecar).
 *
 * Unlike the statement path there is nothing to reconcile against — a receipt
 * carries no "money in / money out" totals — so the result is always returned as
 * a DRAFT with the model's own confidence attached, for the user to confirm.
 * Writes nothing; the client commits via POST /api/transactions.
 */
// 18000 = the sidecar's default host port.
// Only `npm run dev` on the host ever uses this default; compose sets PARSER_URL.
const PARSER_URL = process.env.PARSER_URL || "http://127.0.0.1:18000";
const MAX_BYTES = 25 * 1024 * 1024;

interface ReceiptResponse {
  vendor: string | null;
  date: string | null;
  amount: number | null;
  currency: string | null;
  type: "EXPENSE" | "INCOME";
  note: string | null;
  confidence: number | null;
  model?: string;
  error?: string;
  hint?: string;
  partial?: unknown;
  /** Second-pass cross-check: true = agreed, false = corrected, null = none available. */
  agrees?: boolean | null;
  labelled?: { amount: number; label: string; rule: string };
  passOneAmount?: number;
}

export async function POST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Refuse on the declared size BEFORE buffering: formData() reads the whole body
  // into memory first, so the size check below only ran after the damage was done.
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BYTES + 1024 * 1024) {
    return NextResponse.json({ error: "File too large (25MB max)" }, { status: 413 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected a file upload" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "File too large (25MB max)" }, { status: 413 });
  }

  const upstream = new FormData();
  upstream.append("file", file, file.name);

  let res: Response;
  try {
    res = await fetch(`${PARSER_URL}/receipt`, {
      method: "POST",
      headers: { "X-Parser-Token": process.env.PARSER_TOKEN ?? "" },
      body: upstream,
      // A cold model load on the GPU can take a while on the first receipt.
      signal: AbortSignal.timeout(300_000),
    });
  } catch (e) {
    return NextResponse.json(
      {
        error: "The receipt reader is not reachable.",
        hint: `Start it with: docker compose up -d spendtrack-parser (${PARSER_URL})`,
        detail: e instanceof Error ? e.message : String(e),
      },
      { status: 503 },
    );
  }

  let data: ReceiptResponse;
  try {
    data = (await res.json()) as ReceiptResponse;
  } catch (e) {
    // A non-JSON body (uvicorn's plain-text 500, a connection dropped mid-body)
    // must land here with a hint, not escape as a bare Next 500.
    return NextResponse.json(
      {
        error: "The receipt reader returned an unreadable response.",
        hint: `Check its logs: docker logs spendtrack-parser (${PARSER_URL}/receipt)`,
        detail: e instanceof Error ? e.message : String(e),
      },
      { status: 502 },
    );
  }
  if (!res.ok) {
    return NextResponse.json(data, { status: res.status });
  }

  const merchant = (data.vendor || "(unknown)").slice(0, 200);
  const [rules, categories] = await Promise.all([
    loadRules(userId),
    prisma.category.findMany({
      where: { userId, isArchived: false },
      select: { id: true, name: true },
    }),
  ]);

  const suggestedCategoryId =
    evaluateRules(
      {
        merchant,
        amount: Math.abs(data.amount ?? 0),
        type: data.type === "INCOME" ? "INCOME" : "EXPENSE",
        accountId: null,
        currency: (data.currency || "EUR").toUpperCase(),
      },
      rules,
    ).categoryId ?? slugToCategoryId(categoriseSlug(merchant), categories);

  return NextResponse.json({
    draft: {
      date: data.date,
      merchant,
      amount: data.amount,
      currency: (data.currency || "EUR").toUpperCase(),
      type: data.type,
      // The commit schema caps notes at 500; the model's note is unbounded
      note: typeof data.note === "string" ? data.note.slice(0, 500) : data.note,
      suggestedCategoryId,
    },
    confidence: data.confidence,
    model: data.model ?? null,
    // The only uncertainty signal that tracks correctness. The model's own
    // `confidence` never did on the synthetic receipt bench.
    crossCheck: {
      agrees: data.agrees ?? null,
      label: data.labelled?.label ?? null,
      correctedFrom: data.passOneAmount ?? null,
    },
    // Nothing on a receipt can be cross-checked the way a statement's totals can,
    // so the UI must present this as a draft and never auto-commit it.
    needsReview: true,
  });
}
