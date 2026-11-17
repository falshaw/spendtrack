/**
 * Pure import-dedup logic used by `POST /api/transactions/import`. No database,
 * no Next — so it is unit tested (`tests/import-dedup.test.ts`).
 *
 * Three layers, all of which must stay:
 *   1. `collapseOverlap`  — the same charge printed by two overlapping statement
 *                           files is one charge;
 *   2. `dedupAgainstExisting` phase 1 (exact key) + phase 2 (merchant-blind key);
 *   3. the mirrored-twin guard — a row whose only DB counterpart has the OPPOSITE
 *      type is a sign correction, not a new transaction.
 */

import { HEADER_LINE_ARTEFACTS, allLanguages, wordsRegex } from "./l10n-keywords";

export type TxnType = "EXPENSE" | "INCOME";

/** Exact identity: date | amount | normalised merchant | type | currency. */
export function strictKey(
  date: string,
  amount: number,
  merchant: string,
  type: string,
  currency: string,
): string {
  return `${date.slice(0, 10)}|${amount.toFixed(2)}|${merchant.trim().replace(/\s+/g, " ").toLowerCase()}|${type}|${currency}`;
}

/**
 * Merchant-blind identity: one charge on one account, however the merchant text
 * happens to be rendered. The same charge comes back with different text across
 * parser generations and across overlapping statement exports ("Card transaction
 * of 5.62 EUR issued by Spotify STOCKHOLM" → "Spotify STOCKHOLM"), and a
 * merchant-keyed check calls those two different transactions — which is what
 * would re-import phantom rows on every run.
 */
export function looseKey(date: string, amount: number, type: string, currency: string): string {
  return `${date.slice(0, 10)}|${amount.toFixed(2)}|${type}|${currency}`;
}

const opposite = (t: string): TxnType => (t === "INCOME" ? "EXPENSE" : "INCOME");

// The word-cluster parsers sometimes emit the statement's column-header line or a
// bare cardholder name instead of a merchant. Those renderings must never win a
// collapse against the real merchant text. Set CARDHOLDER_NAME (e.g. "SMITH") to
// let a line that is nothing but the cardholder's name rank below a real merchant.
const JUNK = [wordsRegex(allLanguages(HEADER_LINE_ARTEFACTS)), /^\(unknown\)$/i, /^card transaction of\s*$/i];

/** 0 = a real merchant, 1 = cardholder-name bleed, 2 = parser artefact / empty. */
export function junkRank(m: string | undefined): number {
  const t = (m ?? "").trim();
  if (!t) return 2;
  if (JUNK.some((re) => re.test(t))) return 2;
  // "SMITH", "XX SMITH XX", "CITY XX SMITH CITY XX" - cardholder column bleed, no
  // merchant left in it once the name and short location codes are removed.
  const holder = (process.env.CARDHOLDER_NAME ?? "").trim().toLowerCase();
  if (holder && t.toLowerCase().includes(holder)) {
    const rest = t.toLowerCase().split(holder).join("");
    if (!/[a-z]{5}/.test(rest)) return 1;
  }
  return 0;
}

/** One parsed statement row: Date(YYYY-MM-DD), Merchant, Amount(signed), Currency, Source. */
export type ParsedCsvRow = Record<string, string>;

export interface CollapseResult {
  rows: ParsedCsvRow[];
  collapsed: number;
  /**
   * Loose keys that WERE collapsed on a day no source file fully covers (it is the
   * first or last date of every file that lists it). Informational only — see the
   * note on `collapseOverlap` for why these are still collapsed.
   */
  boundaryCollapsed: string[];
}

/**
 * Collapse overlapping statement coverage.
 *
 * A bank's monthly PDF statements and its rolling 90-day export can cover the
 * same weeks, and the parsers render the same charge differently in each
 * ("MC DONALDS - MAIN ST 12 EXAMPLE CITY Visa B A" vs "McDonald's"), so a merchant-keyed
 * dedup sees two distinct rows and re-imports hundreds of phantoms on every run.
 *
 * Two rows sharing (date, amount, type, ccy) are the SAME charge when they come
 * from DIFFERENT source files, and two GENUINE charges when they come from the
 * same file (a statement really can list two €1.60 coffees on one day). So per
 * loose key, keep as many rows as the single most detailed source file lists —
 * preferring the real, longest merchant string.
 *
 * 🚨 Statement-EDGE days are collapsed exactly like any other day. A file cut
 * mid-day could in theory hide a second genuine charge, and ADDING the counts when
 * every file only touches the day at its edge looks safer — but measured against
 * real statements that rule injects phantom rows: banks print the WHOLE boundary
 * day in both files. The balance chain reconciles those accounts at the collapsed
 * count. So the edge keys
 * are only REPORTED (`boundaryCollapsed`) — if a reconciliation ever comes up one
 * charge short, that list is where to look.
 *
 * Rows with no Source column are passed through untouched.
 */
export function collapseOverlap(rows: ParsedCsvRow[]): CollapseResult {
  if (!rows.some((r) => r.Source)) return { rows, collapsed: 0, boundaryCollapsed: [] };

  const range = new Map<string, { min: string; max: string }>();
  for (const r of rows) {
    if (!r.Date) continue;
    const d = r.Date.slice(0, 10);
    const cur = range.get(r.Source ?? "");
    if (!cur) range.set(r.Source ?? "", { min: d, max: d });
    else {
      if (d < cur.min) cur.min = d;
      if (d > cur.max) cur.max = d;
    }
  }

  const groups = new Map<string, ParsedCsvRow[]>();
  for (const r of rows) {
    const signed = parseFloat(r.Amount);
    if (!r.Date || !Number.isFinite(signed) || signed === 0) continue;
    const k = looseKey(
      r.Date,
      Math.abs(signed),
      signed < 0 ? "EXPENSE" : "INCOME",
      (r.Currency || "EUR").toUpperCase(),
    );
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }

  const kept: ParsedCsvRow[] = [];
  const boundaryCollapsed: string[] = [];
  let collapsed = 0;
  for (const [k, g] of groups) {
    if (g.length === 1) {
      kept.push(g[0]);
      continue;
    }
    const perSource = new Map<string, number>();
    for (const r of g) perSource.set(r.Source ?? "", (perSource.get(r.Source ?? "") ?? 0) + 1);
    if (perSource.size === 1) {
      kept.push(...g); // one file, genuine repeats
      continue;
    }
    const day = k.slice(0, 10);
    const n = Math.max(...perSource.values());
    const anyInterior = [...perSource.keys()].some((src) => {
      const rg = range.get(src);
      return !!rg && rg.min < day && day < rg.max;
    });
    if (!anyInterior && n < g.length) boundaryCollapsed.push(k);
    if (n >= g.length) {
      kept.push(...g);
      continue;
    }
    // Best rendering of the charge wins: real name over parser artefact, then longest.
    const ranked = [...g].sort(
      (a, b) =>
        junkRank(a.Merchant) - junkRank(b.Merchant) ||
        (b.Merchant ?? "").length - (a.Merchant ?? "").length,
    );
    kept.push(...ranked.slice(0, n));
    collapsed += g.length - n;
  }
  return { rows: kept, collapsed, boundaryCollapsed };
}

export interface DedupRow {
  date: string; // YYYY-MM-DD (or an ISO timestamp — only the first 10 chars count)
  amount: number; // always positive
  merchant: string;
  type: string;
  currency: string;
}

export interface DedupResult {
  /** Indices into `cands` that are genuinely new and safe to insert. */
  insert: number[];
  /** Exact (date|amount|merchant|type|ccy) matches already in the DB. */
  duplicates: number;
  /** Same charge, different merchant rendering. */
  variantDuplicates: number;
  /**
   * Indices into `cands` whose only unclaimed DB counterpart has the OPPOSITE
   * type. NOT in `insert` — see `dedupAgainstExisting`.
   */
  suspectedMirrors: number[];
}

/**
 * Two-phase, occurrence-aware dedup of a candidate batch against the rows the
 * account already holds over the same date span.
 *
 *  Phase 1 — exact match: already in the DB, character for character. A statement
 *            can genuinely list the same charge twice in a day, so keys are
 *            COUNTED, never treated as a boolean, and candidates are never
 *            deduped against each other.
 *  Phase 2 — merchant-blind match against whatever DB rows phase 1 did not claim.
 *            Run as a whole-batch second pass, never inline, so an early junk
 *            rendering cannot eat the budget an exact match needs.
 *  Phase 3 — mirrored-twin guard. Both keys above contain `type`, so when a
 *            parser fix finally reads a credit as INCOME, the old row that read
 *            the same credit as EXPENSE matches nothing and the corrected row was
 *            inserted BESIDE it: a charge/refund pair rendered as two charges + one
 *            refund (phantom spend). A
 *            survivor whose (date|amount|ccy) matches a still-unclaimed DB row of
 *            the opposite type is therefore reported, not inserted. A genuine
 *            same-day pair (a pre-auth and its reversal, both legs of an
 *            own-account transfer) is unaffected: the statement lists both legs,
 *            and the leg already in the DB is claimed by its own twin in phase 1/2.
 *            `allowMirrors` inserts them anyway, for the case a human has looked.
 */
export function dedupAgainstExisting(
  cands: DedupRow[],
  existing: DedupRow[],
  opts: { allowMirrors?: boolean; skip?: ReadonlySet<number> } = {},
): DedupResult {
  const strictLeft = new Map<string, number>();
  const looseLeft = new Map<string, number>();
  for (const e of existing) {
    const sk = strictKey(e.date, e.amount, e.merchant, e.type, e.currency);
    const lk = looseKey(e.date, e.amount, e.type, e.currency);
    strictLeft.set(sk, (strictLeft.get(sk) ?? 0) + 1);
    looseLeft.set(lk, (looseLeft.get(lk) ?? 0) + 1);
  }

  const keys = cands.map((c) => ({
    sk: strictKey(c.date, c.amount, c.merchant, c.type, c.currency),
    lk: looseKey(c.date, c.amount, c.type, c.currency),
  }));
  const done = new Set<number>(opts.skip ?? []);
  let duplicates = 0;
  let variantDuplicates = 0;

  keys.forEach((k, i) => {
    if (done.has(i)) return;
    const n = strictLeft.get(k.sk) ?? 0;
    if (n > 0) {
      strictLeft.set(k.sk, n - 1);
      looseLeft.set(k.lk, (looseLeft.get(k.lk) ?? 1) - 1);
      done.add(i);
      duplicates++;
    }
  });
  keys.forEach((k, i) => {
    if (done.has(i)) return;
    const n = looseLeft.get(k.lk) ?? 0;
    if (n > 0) {
      looseLeft.set(k.lk, n - 1);
      done.add(i);
      variantDuplicates++;
    }
  });

  const suspectedMirrors: number[] = [];
  const insert: number[] = [];
  cands.forEach((c, i) => {
    if (done.has(i)) return;
    const mk = looseKey(c.date, c.amount, opposite(c.type), c.currency);
    const n = looseLeft.get(mk) ?? 0;
    if (n > 0) {
      looseLeft.set(mk, n - 1); // one wrong-signed DB row explains one candidate
      suspectedMirrors.push(i);
      if (opts.allowMirrors) insert.push(i);
      return;
    }
    insert.push(i);
  });

  return { insert, duplicates, variantDuplicates, suspectedMirrors };
}
