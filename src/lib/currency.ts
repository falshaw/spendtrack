/**
 * Multi-currency support. Transactions are stored in their native currency;
 * the dashboard/budgets show a unified EUR base using these static rates.
 *
 * This table is the FALLBACK: `toEur(amount, ccy, date)`
 * uses the ECB fixing for the transaction date when the server has loaded one
 * (fx_rates table, see the block further down and src/lib/fx.ts).
 *
 * The codes are EUR plus the ECB euro reference-rate currencies, in alphabetical
 * order. Rates are EUR per 1 unit of the currency, written as 1 / (units per
 * EUR) — approximate reference values, so the EUR figures are "≈": good for
 * trends and budgets, not accounting-exact. Adjust here; everything re-derives
 * from this map.
 *
 * 🚨 A code that is NOT in this map has no rate, and nothing may guess one. A 1:1
 * fallback would count a 5,000 JPY row as €5,000 (true value ≈ €30). `toEur`
 * throws instead, and every write path (`POST /api/transactions/import`, the
 * import dialog) refuses a row whose currency has no rate. Add the code + rate
 * here first, then import.
 */
export const RATES_TO_EUR: Record<string, number> = {
  AUD: 1 / 1.75,
  BRL: 1 / 6.3,
  CAD: 1 / 1.6,
  CHF: 1 / 0.9466,
  CNY: 1 / 8.2,
  CZK: 1 / 24.308,
  DKK: 1 / 7.4753,
  EUR: 1,
  GBP: 1 / 0.8583,
  HKD: 1 / 8.95,
  HUF: 1 / 362.98,
  IDR: 1 / 19000,
  ILS: 1 / 3.9,
  INR: 1 / 101,
  ISK: 1 / 142,
  JPY: 1 / 170,
  KRW: 1 / 1620,
  MXN: 1 / 21.3,
  MYR: 1 / 4.85,
  NOK: 1 / 10.825,
  NZD: 1 / 1.97,
  PHP: 1 / 72.006,
  PLN: 1 / 4.358,
  RON: 1 / 5.2624,
  SEK: 1 / 11.2715,
  SGD: 1 / 1.48,
  THB: 1 / 38.237,
  TRY: 1 / 55.8841,
  USD: 1 / 1.1481,
  ZAR: 1 / 20.2,
};

/** Currencies offered in the pickers: every rated code, alphabetical. */
export const SUPPORTED_CURRENCIES = [
  "AUD", "BRL", "CAD", "CHF", "CNY", "CZK", "DKK", "EUR", "GBP", "HKD",
  "HUF", "IDR", "ILS", "INR", "ISK", "JPY", "KRW", "MXN", "MYR", "NOK",
  "NZD", "PHP", "PLN", "RON", "SEK", "SGD", "THB", "TRY", "USD", "ZAR",
] as const;

export type CurrencyCode = (typeof SUPPORTED_CURRENCIES)[number];

export function isSupportedCurrency(code: string): code is CurrencyCode {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(code);
}

/** Every code that can be converted. */
export const RATED_CURRENCIES: readonly string[] = Object.keys(RATES_TO_EUR);

/** True when `code` (exact, upper-case ISO) has a rate and can be stored. */
export function hasRate(code: string | null | undefined): boolean {
  return !!code && Object.prototype.hasOwnProperty.call(RATES_TO_EUR, code);
}

export class UnknownCurrencyError extends Error {
  constructor(public readonly currency: string) {
    super(
      `No EUR rate for currency "${currency}" — add it to RATES_TO_EUR in src/lib/currency.ts. ` +
        `Refusing to count it 1:1 as EUR.`,
    );
    this.name = "UnknownCurrencyError";
  }
}

/**
 * Normalise an arbitrary currency string (e.g. from a CSV) to a known code.
 * A MISSING code defaults to EUR (a file with no currency column); an UNKNOWN
 * code is returned as-is, upper-cased, so the caller's `hasRate` check can refuse
 * it — relabelling "JPY" as "EUR" destroyed the evidence that the row was wrong.
 */
export function normalizeCurrency(code: string | null | undefined): string {
  if (!code || !code.trim()) return "EUR";
  return code.trim().toUpperCase();
}

// ─── ECB daily rates ────────────────────────────────────────────────
// The static table above is now the FALLBACK. When the server has loaded ECB
// reference rates (src/lib/fx.ts → `setDailyRates`), `toEur(amount, ccy, date)`
// uses the rate published for that date, or the nearest EARLIER business day
// (weekends and TARGET holidays have no fixing, so a Saturday charge takes
// Friday's rate). A date before the first loaded fixing — or a code the ECB does
// not publish — falls back to RATES_TO_EUR. Without a `date` the newest loaded
// fixing is used (that is what "today's rate" means for a forecast or a rule).
//
// `hasRate` deliberately stays tied to the STATIC table: which codes may be
// stored is a separate decision from how precisely they convert, and a code the
// importer has never been told about must still be refused.

type DailySeries = { dates: string[]; eurPerUnit: number[] };
let DAILY: Map<string, DailySeries> = new Map();
let DAILY_LATEST: string | null = null;

/** One ECB fixing: `perEur` units of `currency` per 1 EUR on `date` (YYYY-MM-DD). */
export interface DailyRate {
  currency: string;
  date: string;
  perEur: number;
}

/** Replace the loaded daily rates. Pass [] to go back to the static table only. */
export function setDailyRates(rows: DailyRate[]): void {
  const by = new Map<string, { date: string; eur: number }[]>();
  for (const r of rows) {
    if (!(r.perEur > 0) || !Number.isFinite(r.perEur)) continue;
    const list = by.get(r.currency) ?? [];
    list.push({ date: r.date.slice(0, 10), eur: 1 / r.perEur });
    by.set(r.currency, list);
  }
  const next = new Map<string, DailySeries>();
  let latest: string | null = null;
  for (const [ccy, list] of by) {
    list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    next.set(ccy, { dates: list.map((x) => x.date), eurPerUnit: list.map((x) => x.eur) });
    const last = list[list.length - 1].date;
    if (!latest || last > latest) latest = last;
  }
  DAILY = next;
  DAILY_LATEST = latest;
}

/** How many currencies have daily rates loaded, and the newest fixing date. */
export function dailyRatesInfo(): { currencies: number; latest: string | null } {
  return { currencies: DAILY.size, latest: DAILY_LATEST };
}

function isoOf(date: Date | string): string {
  return typeof date === "string" ? date.slice(0, 10) : date.toISOString().slice(0, 10);
}

/** Index of the last fixing on or before `iso`, or -1. */
function lastOnOrBefore(dates: string[], iso: string): number {
  let lo = 0;
  let hi = dates.length - 1;
  let hit = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] <= iso) {
      hit = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return hit;
}

export interface RateUsed {
  /** EUR per 1 unit of the currency. */
  eurPerUnit: number;
  /** "ECB" when a published fixing was used, "static" for the fallback table, "peg" for the base currency itself. */
  source: "ECB" | "static" | "peg";
  /** The fixing date actually used (ECB only). */
  date: string | null;
}

/**
 * The rate `toEur` would use for `currency` on `date`. Throws UnknownCurrencyError on
 * a code with no static rate — the same refusal as before daily rates existed.
 */
export function rateFor(currency: string, date?: Date | string | null): RateUsed {
  if (!hasRate(currency)) throw new UnknownCurrencyError(currency);
  if (currency === "EUR") return { eurPerUnit: 1, source: "peg", date: null };
  const series = DAILY.get(currency);
  if (series && series.dates.length) {
    const iso = date ? isoOf(date) : series.dates[series.dates.length - 1];
    const i = lastOnOrBefore(series.dates, iso);
    if (i >= 0) return { eurPerUnit: series.eurPerUnit[i], source: "ECB", date: series.dates[i] };
  }
  return { eurPerUnit: RATES_TO_EUR[currency], source: "static", date: null };
}

/**
 * Convert a native amount to the EUR base. Throws on a currency with no rate.
 * `date` (the day the money moved) picks the ECB fixing for that day or the
 * nearest earlier business day; see the block comment above.
 */
export function toEur(amount: number, currency: string, date?: Date | string | null): number {
  if (!hasRate(currency)) throw new UnknownCurrencyError(currency);
  if (currency === "EUR") return amount;
  return amount * rateFor(currency, date).eurPerUnit;
}
