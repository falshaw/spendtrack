/**
 * ECB euro foreign exchange reference rates — the parser, and nothing else.
 *
 * Kept free of imports on purpose: `scripts/update-fx.mjs` imports this exact file
 * on the host (Node 24 strips the types), and the in-app `POST /api/fx/update`
 * route imports it too, so there is ONE parser for both feeds.
 *
 * Feeds (free, public, no key):
 *   daily  https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml
 *   90-day https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml
 *
 * Shape: <Cube time="2026-09-18"><Cube currency="USD" rate="1.1481"/>…</Cube>. The
 * rate is units of the currency per 1 EUR, published around 16:00 CET on TARGET
 * business days only — so weekends and holidays simply have no <Cube time>.
 */

export const ECB_DAILY_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
export const ECB_HIST_90D_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml";

export interface EcbRate {
  currency: string; // ISO 4217, upper case
  date: string; // YYYY-MM-DD
  perEur: number; // units of `currency` per 1 EUR
}

/**
 * Every (date, currency, rate) in an ECB eurofxref XML document. Throws when the
 * document holds no fixing at all — an HTML error page or a truncated download
 * must not be mistaken for "no rates today".
 */
export function parseEcbXml(xml: string): EcbRate[] {
  const out: EcbRate[] = [];
  const dayRe = /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]\s*>([\s\S]*?)<\/Cube>/g;
  const rateRe = /<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([0-9]+(?:\.[0-9]+)?)['"]\s*\/>/g;
  for (const day of xml.matchAll(dayRe)) {
    const date = day[1];
    for (const r of day[2].matchAll(rateRe)) {
      const perEur = Number(r[2]);
      if (Number.isFinite(perEur) && perEur > 0) out.push({ currency: r[1], date, perEur });
    }
  }
  if (out.length === 0) throw new Error("ECB feed contained no rates — refusing to treat it as empty");
  return out;
}

// ─── Staleness (F8) ──────────────────────────────────────
// The ECB publishes on TARGET2 business days only: Mon–Fri except New Year's Day,
// Good Friday, Easter Monday, 1 May, 25 and 26 December. A gap in `fx_rates`
// over a weekend or one of those days is not staleness.

/** Easter Sunday (Gregorian, anonymous algorithm) as YYYY-MM-DD. */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const DAY_MS = 86_400_000;

/** The TARGET closing days of a year (the weekdays the ECB does not fix). */
export function targetHolidays(year: number): Set<string> {
  const easter = Date.parse(easterSunday(year) + "T00:00:00Z");
  return new Set([
    `${year}-01-01`,
    isoDay(easter - 2 * DAY_MS), // Good Friday
    isoDay(easter + DAY_MS), // Easter Monday
    `${year}-05-01`,
    `${year}-12-25`,
    `${year}-12-26`,
  ]);
}

/** Is `iso` (YYYY-MM-DD) a day the ECB publishes a fixing? */
export function isTargetBusinessDay(iso: string): boolean {
  const d = new Date(iso.slice(0, 10) + "T00:00:00Z");
  const wd = d.getUTCDay();
  if (wd === 0 || wd === 6) return false;
  return !targetHolidays(d.getUTCFullYear()).has(iso.slice(0, 10));
}

/**
 * TARGET business days after `latestIso` up to and including `todayIso` — how many
 * fixings the table is missing. 0 = up to date. Today counts even before the
 * ~16:00 CET publication, which the threshold below absorbs.
 */
export function businessDaysSince(latestIso: string, todayIso: string): number {
  let n = 0;
  let t = Date.parse(latestIso.slice(0, 10) + "T00:00:00Z") + DAY_MS;
  const end = Date.parse(todayIso.slice(0, 10) + "T00:00:00Z");
  for (let guard = 0; t <= end && guard < 4000; guard++, t += DAY_MS) {
    if (isTargetBusinessDay(isoDay(t))) n++;
  }
  return n;
}

/** Rates older than this many business days trigger a refresh. */
export const ECB_STALE_BUSINESS_DAYS = 3;

/**
 * Which feed closes a gap: none while ≤ 3 business days are missing, the daily
 * feed for 4–5, the 90-day history beyond that (the daily feed holds one day only).
 */
export function refreshModeFor(gap: number): "daily" | "hist90" | null {
  if (gap <= ECB_STALE_BUSINESS_DAYS) return null;
  return gap <= 5 ? "daily" : "hist90";
}
