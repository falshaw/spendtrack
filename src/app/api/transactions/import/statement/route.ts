import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/auth";
import { loadRules } from "@/lib/rules";
import { evaluateRules } from "@/lib/rule-engine";
import { categoriseSlug, slugToCategoryId } from "@/lib/categorise";

/**
 * Parse an uploaded BANK STATEMENT (PDF, or a bank's own CSV export) into
 * reviewable rows, reconciled against the statement's printed totals.
 *
 * The file goes to the parser sidecar (Python; `scripts/statement_service.py`),
 * which detects the bank and returns signed rows plus a validation verdict. This
 * route adds the category guess (learned merchant rules first, then the shared
 * keyword map) and hands the result to the review table. Writes nothing — the
 * client commits via POST /api/transactions/import.
 */
// 18000 = the sidecar's default host port.
// Only `npm run dev` on the host ever uses this default; compose sets PARSER_URL.
const PARSER_URL = process.env.PARSER_URL || "http://127.0.0.1:18000";
const MAX_BYTES = 25 * 1024 * 1024;

interface ParserRow {
  Date: string;
  Merchant: string;
  Amount: number;
  Currency?: string;
  Source?: string;
  /** Only set by the Trading 212 reader, which knows its own conventions. */
  Category?: string;
}

interface ParserResponse {
  format: string | null;
  label: string | null;
  account: string | null;
  rows?: ParserRow[];
  validation?: Record<string, unknown>;
  warnings?: string[];
  fallback?: string;
  error?: string;
  hint?: string;
  source?: string;
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
    res = await fetch(`${PARSER_URL}/parse`, {
      method: "POST",
      headers: { "X-Parser-Token": process.env.PARSER_TOKEN ?? "" },
      body: upstream,
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    return NextResponse.json(
      {
        error: "The statement parser is not reachable.",
        hint: `Start it with: docker compose up -d spendtrack-parser (${PARSER_URL})`,
        detail: e instanceof Error ? e.message : String(e),
      },
      { status: 503 },
    );
  }

  let data: ParserResponse;
  try {
    data = (await res.json()) as ParserResponse;
  } catch (e) {
    // A non-JSON body (uvicorn's plain-text 500, a connection dropped mid-body)
    // must land here with a hint, not escape as a bare Next 500.
    return NextResponse.json(
      {
        error: "The statement parser returned an unreadable response.",
        hint: `Check its logs: docker logs spendtrack-parser (${PARSER_URL}/parse)`,
        detail: e instanceof Error ? e.message : String(e),
      },
      { status: 502 },
    );
  }
  if (!res.ok) {
    // Pass the parser's own diagnosis through verbatim. "0 transactions parsed"
    // is an error there and must stay an error here — a statement that reads as
    // empty is a parser failure, never a quiet success.
    return NextResponse.json(data, { status: res.status });
  }

  // Not a bank export. "generic-csv" → the app's own column mapper; "receipt" →
  // a one-page invoice that should go to the vision model instead. The parser
  // only says "receipt" for a document too short to be a statement, so an
  // unparseable statement still fails loudly rather than being read as one row.
  if (data.fallback) {
    return NextResponse.json({ ...data, rows: [] });
  }

  const parserRows = data.rows ?? [];

  const [rules, categories] = await Promise.all([
    loadRules(userId),
    prisma.category.findMany({
      where: { userId, isArchived: false },
      select: { id: true, name: true },
    }),
  ]);

  const rows = parserRows.map((r) => {
    const amount = Number(r.Amount);
    const merchant = (r.Merchant || "(unknown)").slice(0, 200);
    const type = amount < 0 ? ("EXPENSE" as const) : ("INCOME" as const);
    const currency = (r.Currency || "EUR").toUpperCase();
    // The parser's own Category outranks everything: only the Trading 212 reader
    // sets one, and it KNOWS deposits/buys/sells are internal movement. If a learned
    // rule won, a rule containing "deposit" could file a broker deposit as spend.
    // Then a learned rule (the user's explicit decision), then the keyword map.
    const suggested =
      (r.Category ? slugToCategoryId(r.Category, categories) : null) ??
      evaluateRules({ merchant, amount: Math.abs(amount), type, accountId: data.account ?? null, currency }, rules).categoryId ??
      slugToCategoryId(categoriseSlug(merchant), categories);
    return {
      date: r.Date,
      merchant,
      amount: Math.abs(amount),
      currency,
      type,
      rawCategory: null,
      note: null,
      source: r.Source ?? data.source ?? null,
      suggestedCategoryId: suggested,
    };
  });

  return NextResponse.json({
    format: data.format,
    label: data.label,
    account: data.account,
    validation: data.validation ?? null,
    warnings: data.warnings ?? [],
    source: data.source ?? file.name,
    rows,
  });
}
