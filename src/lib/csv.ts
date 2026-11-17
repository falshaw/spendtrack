/**
 * Dependency-free CSV import parser for bank/statement exports.
 *
 * Handles: comma / semicolon / tab delimiters, quoted fields, decimal-comma
 * (1.234,56) and decimal-dot (1,234.56) numbers, parentheses/sign negatives,
 * separate debit & credit columns, and day-first or ISO dates. Pure — no DB. The
 * import route applies learned merchant→category rules to the result. Header and
 * month words in other languages come from ./l10n-keywords.
 */

import { CSV_HEADER_WORDS, allLanguages, monthIndex, wordsRegex } from "./l10n-keywords";

export interface ParsedRow {
  date: string | null; // ISO yyyy-mm-dd
  merchant: string;
  amount: number; // always positive
  currency: string | null; // native currency code from the file, if present
  type: "EXPENSE" | "INCOME";
  rawCategory: string | null; // category text from the file, if any
  note: string | null;
  error?: string;
}

export interface ParseResult {
  delimiter: string;
  headers: string[];
  mapping: Record<string, number>;
  rows: ParsedRow[];
  skipped: number;
  /**
   * True when a single Amount column held no negative value at all, so the sign
   * carried no information and every row was read as an EXPENSE. Card exports
   * (Amex) print charges as positive numbers; reading positive as INCOME flipped
   * the whole file. The review step must say so — a file of pure income exists too.
   */
  signAssumed: boolean;
}

function detectDelimiter(line: string): string {
  const candidates = [";", "\t", ","];
  let best = ",";
  let bestCount = -1;
  for (const d of candidates) {
    const count = line.split(d).length - 1;
    if (count > bestCount) {
      bestCount = count;
      best = d;
    }
  }
  return best;
}

/** Split one CSV line on `delimiter`, honouring double-quote escaping. */
function splitLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/**
 * `decimal` is the file's decimal mark when the caller knows it (see
 * `detectDecimalMark`). Without it a lone separator is a guess, and the guess was
 * wrong for decimal-comma exports: "-3.000" parsed as EUR 3.00, not 3,000.
 */
export function parseAmount(raw: string, decimal?: "," | "."): number | null {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;

  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[^0-9.,\-]/g, "");
  if (s.includes("-")) {
    negative = true;
    s = s.replace(/-/g, "");
  }
  if (!s) return null;

  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  let normalized: string;

  if (decimal === ",") {
    normalized = s.replace(/\./g, "").replace(",", ".");
  } else if (decimal === ".") {
    normalized = s.replace(/,/g, "");
  } else if (lastComma > -1 && lastDot > -1) {
    normalized =
      lastComma > lastDot
        ? s.replace(/\./g, "").replace(",", ".") // comma is decimal
        : s.replace(/,/g, ""); // dot is decimal
  } else if (lastComma > -1) {
    const parts = s.split(",");
    normalized =
      parts.length === 2 && parts[1].length <= 2
        ? s.replace(",", ".") // decimal comma
        : s.replace(/,/g, ""); // thousands
  } else {
    const dots = (s.match(/\./g) || []).length;
    if (dots > 1) {
      const idx = s.lastIndexOf(".");
      normalized = s.slice(0, idx).replace(/\./g, "") + "." + s.slice(idx + 1);
    } else if (/^\d{1,3}\.\d{3}$/.test(s)) {
      // "1.234" / "3.000": money has two decimals, never three, so a lone dot
      // followed by exactly three digits is a thousands separator.
      normalized = s.replace(".", "");
    } else {
      normalized = s;
    }
  }

  const n = parseFloat(normalized);
  if (Number.isNaN(n)) return null;
  return negative ? -Math.abs(n) : n;
}

function toIso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(dt.getTime())) return null;
  // Date.UTC rolls a non-calendar date over (31 Feb -> 3 Mar) instead of failing.
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

export function parseDateFlexible(raw: string): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;

  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return toIso(+m[1], +m[2], +m[3]);

  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (m) {
    let d = +m[1];
    let mo = +m[2];
    let y = +m[3];
    if (y < 100) y += 2000;
    // Day-first default; only swap if it can't be a day-first date.
    if (mo > 12 && d <= 12) {
      [d, mo] = [mo, d];
    }
    return toIso(y, mo, d);
  }

  // Text dates ("27 Jul 2026", "27. <month name> 2026", "Jul 27, 2026"). Read by
  // hand: Date.parse() reads these in LOCAL time, so the ISO date slides back a day
  // on any host east of UTC — right in the container, wrong under `npm run dev`.
  m = s.match(/^(\d{1,2})\.?\s+(\p{L}{3,})\.?,?\s+(\d{4})/u);
  if (m) {
    const mo = monthIndex(m[2]);
    return mo ? toIso(+m[3], mo, +m[1]) : null;
  }
  m = s.match(/^(\p{L}{3,})\.?\s+(\d{1,2}),?\s+(\d{4})/u);
  if (m) {
    const mo = monthIndex(m[1]);
    return mo ? toIso(+m[3], mo, +m[2]) : null;
  }
  return null;
}

/**
 * The decimal mark a column of amounts uses, or undefined when the cells do not
 * settle it. One cell ending ",dd" makes it a comma file — and then every dot in
 * the column is a thousands separator, including the lone one in "3.000".
 */
export function detectDecimalMark(cells: string[]): "," | "." | undefined {
  let comma = 0;
  let dot = 0;
  for (const c of cells) {
    const t = c.replace(/[^0-9.,]/g, "");
    if (/,\d{1,2}$/.test(t)) comma++;
    else if (/\.\d{1,2}$/.test(t)) dot++;
  }
  if (comma > 0 && dot === 0) return ",";
  if (dot > 0 && comma === 0) return ".";
  return undefined;
}

const header = (key: keyof typeof CSV_HEADER_WORDS, extra?: string) =>
  wordsRegex(allLanguages(CSV_HEADER_WORDS[key]), extra);

const HEADER_PATTERNS: Record<string, RegExp> = {
  date: header("date"),
  amount: header("amount"),
  // bare "in"/"out" only as the WHOLE header: as a word anywhere they claimed
  // "Paid in full" or "Opt out" as the credit/debit column.
  debit: header("debit", "^\\s*out\\s*$"),
  credit: header("credit", "^\\s*in\\s*$"),
  merchant: header("merchant"),
  currency: header("currency"),
  category: header("category"),
  note: header("note"),
};
const BALANCE_HEADER = header("balance");

function detectColumns(headers: string[]): Record<string, number> {
  const map: Record<string, number> = {};
  // The date column first, and no other key may claim it: "Value Date" also
  // matches the amount pattern (`value`), which mapped amount → the date column
  // and skipped every row. A balance column is likewise
  // never an amount/debit/credit, and an exact header ("Amount") beats a
  // partial one ("Amount incl. fees").
  const dateIdx = headers.findIndex((h) => HEADER_PATTERNS.date.test(h));
  if (dateIdx > -1) map.date = dateIdx;
  const isBalance = (h: string) => BALANCE_HEADER.test(h);
  for (const [key, re] of Object.entries(HEADER_PATTERNS)) {
    if (key === "date") continue;
    const money = key === "amount" || key === "debit" || key === "credit";
    const ok = (h: string, i: number) => i !== dateIdx && !(money && isBalance(h)) && re.test(h);
    let idx = headers.findIndex((h, i) => ok(h, i) && /^\S+$/.test(h.trim()));
    if (idx === -1) idx = headers.findIndex((h, i) => ok(h, i));
    if (idx > -1) map[key] = idx;
  }
  return map;
}

export function parseCsv(text: string): ParseResult {
  const clean = text.replace(/^﻿/, ""); // strip BOM
  const lines = clean
    .split(/\r\n|\r|\n/)
    .filter((l) => l.trim().length > 0);

  if (lines.length < 2) {
    return { delimiter: ",", headers: [], mapping: {}, rows: [], skipped: 0, signAssumed: false };
  }

  const delimiter = detectDelimiter(lines[0]);
  const headers = splitLine(lines[0], delimiter);
  const mapping = detectColumns(headers);

  const hasAmount = mapping.amount != null;
  const hasDebitCredit = mapping.debit != null || mapping.credit != null;

  const rows: ParsedRow[] = [];
  let skipped = 0;

  const body = lines.slice(1).map((l) => splitLine(l, delimiter));
  const amountCols = [mapping.amount, mapping.debit, mapping.credit].filter(
    (c): c is number => c != null,
  );
  const decimal = detectDecimalMark(
    body.flatMap((cells) => amountCols.map((c) => cells[c] ?? "")).filter(Boolean),
  );
  // A single Amount column with no negative anywhere carries no sign information.
  const signAssumed =
    hasAmount &&
    body.length > 1 &&
    !body.some((cells) => (parseAmount(cells[mapping.amount] ?? "", decimal) ?? 0) < 0);

  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i], delimiter);
    const get = (idx: number | undefined) =>
      idx != null && idx < cells.length ? cells[idx] : "";

    const date = parseDateFlexible(get(mapping.date));
    const merchant =
      get(mapping.merchant) || get(mapping.note) || "(unknown)";

    let amount: number | null = null;
    let type: "EXPENSE" | "INCOME" = "EXPENSE";

    if (hasAmount) {
      const parsed = parseAmount(get(mapping.amount), decimal);
      if (parsed != null) {
        type = signAssumed ? "EXPENSE" : parsed >= 0 ? "INCOME" : "EXPENSE";
        amount = Math.abs(parsed);
      }
    } else if (hasDebitCredit) {
      const debit = parseAmount(get(mapping.debit), decimal);
      const credit = parseAmount(get(mapping.credit), decimal);
      if (credit != null && Math.abs(credit) > 0) {
        amount = Math.abs(credit);
        type = "INCOME";
      } else if (debit != null && Math.abs(debit) > 0) {
        amount = Math.abs(debit);
        type = "EXPENSE";
      }
    }

    if (amount == null || amount === 0 || !date) {
      skipped++;
      continue;
    }

    const rawCcy = mapping.currency != null ? get(mapping.currency) : "";
    rows.push({
      date,
      merchant: merchant.slice(0, 200),
      amount,
      currency: rawCcy ? rawCcy.trim().toUpperCase() : null,
      type,
      rawCategory: get(mapping.category) || null,
      note: mapping.note != null ? get(mapping.note) || null : null,
    });
  }

  return { delimiter, headers, mapping, rows, skipped, signAssumed };
}

// ─── Writing (F1 net-worth export) ───────────────────────

/**
 * One CSV cell: quoted when it holds a delimiter, quote or line break; a text cell
 * that starts like a formula (= + - @ tab CR) gets a leading apostrophe so a
 * spreadsheet never evaluates it. Numbers are written as-is (negatives stay numbers).
 */
export function csvCell(v: string | number | null | undefined): string {
  if (v == null) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  let s = v;
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows → CSV text (comma, CRLF). No BOM; the route adds one for Excel. */
export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}
