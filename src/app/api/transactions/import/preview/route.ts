import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/auth";
import { parseCsv } from "@/lib/csv";
import { loadRules } from "@/lib/rules";
import { evaluateRules } from "@/lib/rule-engine";

/**
 * Parse an uploaded CSV and return reviewable rows with a best-guess category
 * for each (from learned merchant rules, falling back to a name match on the
 * file's own category column). Does NOT write anything — the client reviews,
 * then commits via POST /api/transactions/import.
 */
export async function POST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { csv?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const csv = body.csv;
  if (typeof csv !== "string" || csv.length === 0) {
    return NextResponse.json({ error: "No CSV provided" }, { status: 400 });
  }
  if (csv.length > 2_000_000) {
    return NextResponse.json({ error: "File too large (2MB max)" }, { status: 413 });
  }

  const parsed = parseCsv(csv);
  if (parsed.rows.length === 0) {
    return NextResponse.json(
      {
        error:
          "Could not read any transactions. Expected a header row with at least a date column and an amount (or debit/credit) column.",
        detected: { headers: parsed.headers, mapping: parsed.mapping },
      },
      { status: 422 },
    );
  }

  const [rules, categories] = await Promise.all([
    loadRules(userId),
    prisma.category.findMany({
      where: { userId, isArchived: false },
      select: { id: true, name: true },
    }),
  ]);

  const byLowerName = new Map(
    categories.map((c) => [c.name.toLowerCase(), c.id]),
  );

  const rows = parsed.rows.map((r) => {
    let suggested = evaluateRules(
      { merchant: r.merchant, amount: r.amount, type: r.type, accountId: null, currency: r.currency ?? "EUR" },
      rules,
    ).categoryId;
    if (!suggested && r.rawCategory) {
      suggested = byLowerName.get(r.rawCategory.toLowerCase()) ?? null;
    }
    return { ...r, suggestedCategoryId: suggested };
  });

  return NextResponse.json({
    rows,
    skipped: parsed.skipped,
    signAssumed: parsed.signAssumed,
    detected: {
      delimiter: parsed.delimiter,
      headers: parsed.headers,
      mapping: parsed.mapping,
    },
  });
}
