import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/auth";
import { parseRequest, ImportCommitSchema } from "@/lib/validators";
import { learnMerchantRule, loadRules } from "@/lib/rules";
import { evaluateRules } from "@/lib/rule-engine";
import { hasRate } from "@/lib/currency";
import { dedupAgainstExisting } from "@/lib/import-dedup";

/**
 * The shared commit schema, tightened for this route:
 *  - `currency` is any code WITH A RATE in src/lib/currency.ts, not a short fixed
 *    list — a statement can carry a pocket in any rated currency. A code
 *    with no rate is refused outright: `toEur` would have counted it 1:1 as EUR
 *    (5,000 JPY = EUR 5,000) and the dialog used to relabel it EUR on the way in.
 *  - `userCategorised` marks a row whose category the USER picked in review. Only
 *    those teach a merchant rule (see below).
 *  - `allowMirrors` inserts rows the mirrored-twin guard would otherwise hold back.
 */
const CommitSchema = ImportCommitSchema.extend({
  allowMirrors: z.boolean().optional(),
  rows: z
    .array(
      ImportCommitSchema.shape.rows.element.extend({
        currency: z
          .string()
          .default("EUR")
          .refine((c) => hasRate(c), {
            message:
              "Currency has no EUR rate — add it to RATES_TO_EUR in src/lib/currency.ts before importing",
          }),
        userCategorised: z.boolean().optional(),
      }),
    )
    .min(1, "No rows to import")
    .max(5000, "Too many rows in one import"),
});

/**
 * Commit a reviewed batch of imported transactions into an account. A row lands
 * reviewed=true when it arrives with a category (the dialog showed it, a rule or
 * the keyword map chose it) and reviewed=false only when uncategorised — the
 * to-review inbox is for rows that still need a decision, not a log of every
 * import. Duplicates are skipped in two phases (exact key, then
 * merchant-blind) so re-importing or overlapping monthly statements never double
 * up, and a row whose only DB counterpart has the OPPOSITE type is held back as a
 * suspected mirrored twin — all three in `src/lib/import-dedup.ts`.
 *
 * Only a category the USER chose in review teaches a merchant rule. If every
 * categorised row did, including the keyword map's own guesses — and a learned rule
 * outranks the keyword map — a guess made before a keyword fix would be frozen in
 * as a rule and keep overriding the corrected map forever.
 */
export async function POST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = await parseRequest(CommitSchema, request);
  if (!parsed.success) return parsed.response;
  const { rows, accountId, allowMirrors } = parsed.data;

  const [ownCats, ownAccs] = await Promise.all([
    prisma.category.findMany({ where: { userId }, select: { id: true } }),
    prisma.account.findMany({ where: { userId }, select: { id: true } }),
  ]);
  const ownCatIds = new Set(ownCats.map((c) => c.id));
  // Reject unknown/foreign refs loudly — silently importing into "no account"
  // or dropping a category hides client bugs behind a 201.
  if (accountId && !ownAccs.some((a) => a.id === accountId)) {
    return NextResponse.json({ error: "Unknown account" }, { status: 400 });
  }
  const accId = accountId ?? null;
  const badCat = rows.find((r) => r.categoryId && !ownCatIds.has(r.categoryId));
  if (badCat) {
    return NextResponse.json(
      { error: `Unknown category on row for "${badCat.merchant}"` },
      { status: 400 },
    );
  }

  // Everything this account already holds over the import's date span, so
  // overlapping monthly imports don't create duplicates.
  const dates = rows.map((r) => r.date).sort();
  const minD = new Date(dates[0]);
  const maxD = new Date(dates[dates.length - 1]);
  maxD.setUTCDate(maxD.getUTCDate() + 1);

  const existing = await prisma.transaction.findMany({
    where: { userId, accountId: accId, date: { gte: minD, lt: maxD } },
    select: { date: true, amount: true, merchant: true, type: true, currency: true },
  });

  // Rows are NOT deduped against each other within one upload: a statement can
  // genuinely list the same charge twice on one day, and collapsing those
  // silently dropped real transactions.
  const verdict = dedupAgainstExisting(
    rows,
    existing.map((e) => ({
      date: e.date.toISOString(),
      amount: Number(e.amount.toString()),
      merchant: e.merchant,
      type: e.type,
      currency: e.currency,
    })),
    { allowMirrors },
  );

  const batch = crypto.randomUUID();
  // F2: the reviewed category is the user's (or the preview's) decision and stands;
  // rules add the labels a review table has no column for (display name, note, tags).
  const ruleRows = await loadRules(userId);
  const data = verdict.insert.map((i) => {
    const r = rows[i];
    const categoryId = r.categoryId && ownCatIds.has(r.categoryId) ? r.categoryId : null;
    const ruled = evaluateRules({ merchant: r.merchant, amount: r.amount, type: r.type, accountId: accId, currency: r.currency }, ruleRows);
    return {
      userId,
      accountId: accId,
      type: r.type,
      amount: r.amount,
      currency: r.currency,
      date: new Date(r.date),
      merchant: r.merchant,
      categoryId,
      note: r.note ?? ruled.note,
      reviewed: categoryId != null,
      importBatch: batch,
      displayMerchant: ruled.displayMerchant,
      tags: ruled.tags,
    };
  });

  // createManyAndReturn: same single INSERT, but hands back the new ids so the
  // receipt dialog can attach its file to the row it just created (F9).
  const createdRows =
    data.length > 0
      ? await prisma.transaction.createManyAndReturn({ data, select: { id: true } })
      : [];
  const created = { count: createdRows.length };

  // Learn merchant→category rules from the user's OWN choices only (dedupe by merchant).
  const learned = new Map<string, string>();
  for (const r of rows) {
    if (r.userCategorised && r.categoryId && ownCatIds.has(r.categoryId)) {
      learned.set(r.merchant, r.categoryId);
    }
  }
  await Promise.all(
    Array.from(learned.entries()).map(([merchant, categoryId]) =>
      learnMerchantRule(userId, merchant, categoryId).catch(() => {}),
    ),
  );

  return NextResponse.json(
    {
      imported: created.count,
      duplicates: verdict.duplicates,
      variantDuplicates: verdict.variantDuplicates,
      // Held back (or, with allowMirrors, inserted) because the account already
      // holds the same date/amount with the opposite sign — see import-dedup.ts.
      suspectedMirrors: verdict.suspectedMirrors.map((i) => ({
        index: i,
        date: rows[i].date,
        merchant: rows[i].merchant,
        amount: rows[i].amount,
        currency: rows[i].currency,
        type: rows[i].type,
      })),
      mirrorsInserted: !!allowMirrors,
      rulesLearned: learned.size,
      batch,
      ids: createdRows.map((r) => r.id),
    },
    { status: 201 },
  );
}
