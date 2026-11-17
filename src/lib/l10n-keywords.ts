/**
 * Localised keywords for the CSV importer and the receipt-split helper — the
 * TypeScript twin of scripts/l10n_keywords.py (the statement parser's table).
 *
 * A bank export or a receipt is printed in whatever language the issuer, or the
 * user's app, was set to. The code that reads them is language-neutral: every word
 * it looks for lives here, one entry per language. To support another language,
 * add one entry to each table — no parser code changes.
 *
 * Keys are ISO 639-1 language codes; English is the base.
 */

type Lang = "en" | "de" | "es" | "fr" | "it";

// ───────────────────────────── month names ─────────────────────────────
export const MONTH_NAMES: Record<Lang, string[]> = {
  en: ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"],
  de: ["januar", "februar", "märz", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "dezember"],
  es: ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"],
  fr: ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"],
  it: ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"],
};

/** Abbreviations that are not a prefix of the full name. */
export const MONTH_ALIASES: Record<string, number> = { mrz: 3 };

/**
 * Full names plus every 3- and 4-letter prefix that means ONE month across all
 * languages ("sept" → 9; a prefix shared by two different months is left out).
 */
const MONTH_LOOKUP: Record<string, number> = (() => {
  const full: Record<string, number> = {};
  const prefixes = new Map<string, Set<number>>();
  for (const names of Object.values(MONTH_NAMES)) {
    names.forEach((name, i) => {
      full[name] = i + 1;
      for (const n of [3, 4]) {
        if (name.length < n) continue;
        const p = name.slice(0, n);
        if (!prefixes.has(p)) prefixes.set(p, new Set());
        prefixes.get(p)!.add(i + 1);
      }
    });
  }
  const lookup: Record<string, number> = {};
  for (const [p, s] of prefixes) if (s.size === 1) lookup[p] = [...s][0];
  return { ...lookup, ...full, ...MONTH_ALIASES };
})();

/** 1-12 for a month name or abbreviation in any table language, else null. */
export function monthIndex(word: string): number | null {
  const w = word.toLowerCase().replace(/\.$/, "");
  return MONTH_LOOKUP[w] ?? MONTH_LOOKUP[w.slice(0, 4)] ?? MONTH_LOOKUP[w.slice(0, 3)] ?? null;
}

// ───────────────────────────── CSV column headers ─────────────────────────────
export type HeaderKey = "date" | "amount" | "debit" | "credit" | "merchant" | "currency" | "category" | "note" | "balance";

/** Regex fragments per column and language (matched as whole words, case-insensitive). */
export const CSV_HEADER_WORDS: Record<HeaderKey, Partial<Record<Lang, string[]>>> = {
  date: {
    en: ["date", "posted", "booking", "value\\s*date", "transaction\\s*date"],
    de: ["datum"], es: ["fecha"], it: ["data"],
  },
  amount: {
    en: ["amount", "value", "sum", "total", "gross"],
    de: ["betrag"], es: ["importe"], fr: ["montant"], it: ["importo"],
  },
  debit: {
    en: ["debit", "withdrawal", "paid\\s*out", "money\\s*out"],
    de: ["soll"], es: ["cargo"], fr: ["débit"], it: ["addebito"],
  },
  credit: {
    en: ["credit", "deposit", "paid\\s*in", "money\\s*in"],
    de: ["haben"], es: ["abono"], fr: ["crédit"], it: ["accredito"],
  },
  merchant: {
    en: ["merchant", "payee", "description", "name", "details", "reference", "narrative", "memo", "particulars"],
    de: ["beschreibung", "verwendungszweck"], es: ["concepto", "descripción"], fr: ["libellé"], it: ["descrizione"],
  },
  currency: {
    en: ["currency", "ccy"],
    de: ["währung", "waehrung"], es: ["divisa", "moneda"], fr: ["devise"], it: ["divisa"],
  },
  category: {
    en: ["category", "tag"],
    de: ["kategorie"], es: ["categoría"], fr: ["catégorie"], it: ["categoria"],
  },
  note: {
    en: ["note", "notes", "comment", "remark"],
    de: ["notiz"], es: ["nota"], fr: ["remarque"], it: ["nota"],
  },
  balance: {
    en: ["balance", "running"],
    de: ["saldo"], es: ["saldo"], fr: ["solde"], it: ["saldo"],
  },
};

// ───────────────────────────── parser artefacts ─────────────────────────────
/** A statement's column-header line that a PDF parser can emit in place of a merchant. */
export const HEADER_LINE_ARTEFACTS: Partial<Record<Lang, string[]>> = {
  en: ["reference\\s+number\\s+booking\\s+date"],
  de: ["referenznummer\\s+buchungsdatum"],
};

// ───────────────────────────── receipt labels ─────────────────────────────
/** Labels a receipt prints that are not items: totals, tax, tip, change, discounts. */
export const RECEIPT_NON_ITEM_WORDS: Record<Lang, string[]> = {
  en: ["total", "subtotal", "sub-total", "sum", "amount due", "due", "balance", "to pay", "paid", "payment", "cash", "card",
    "change", "vat", "tax", "tip", "service", "gratuity", "discount", "rounding"],
  de: ["summe", "gesamt", "gesamtpreis", "netto", "brutto", "zwischensumme", "bezahlt", "zahlung", "bar", "karte",
    "rückgeld", "wechselgeld", "mwst", "ust", "trinkgeld", "rabatt", "rundung"],
  es: ["subtotal", "iva", "propina", "descuento", "efectivo", "tarjeta", "cambio", "redondeo", "pagado"],
  fr: ["sous-total", "tva", "pourboire", "remise", "espèces", "carte", "monnaie", "arrondi", "payé"],
  it: ["totale", "subtotale", "iva", "mancia", "sconto", "contanti", "carta", "resto", "arrotondamento", "pagato"],
};

/**
 * A case-insensitive regex matching any of `words` as a whole word. Unicode-aware
 * boundaries, so a word ending in an accented letter ("libellé") still matches —
 * a plain `\b` only knows ASCII letters.
 */
export function wordsRegex(words: string[], extra?: string): RegExp {
  const alt = [...new Set(words)].join("|");
  const body = `(?<![\\p{L}\\p{N}_])(?:${alt})(?![\\p{L}\\p{N}_])`;
  return new RegExp(extra ? `${body}|${extra}` : body, "iu");
}

/** Every language's words for one table entry, flattened. */
export function allLanguages(byLang: Partial<Record<Lang, string[]>>): string[] {
  return Object.values(byLang).flatMap((w) => w ?? []);
}
