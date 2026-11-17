/** Tailwind-friendly className joiner. */
export function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

const EUR = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "EUR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const EUR0 = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "EUR",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/** Format a number as EUR, e.g. €1,234.56. Pass `whole` to drop the cents. */
export function formatMoney(amount: number, whole = false): string {
  return (whole ? EUR0 : EUR).format(amount);
}

const fmtCache = new Map<string, Intl.NumberFormat>();

/** Format an amount in its native currency, e.g. $500, CHF 30.00. */
export function formatAmount(
  amount: number,
  currency = "EUR",
  whole = false,
): string {
  const key = `${currency}:${whole}`;
  let fmt = fmtCache.get(key);
  if (!fmt) {
    try {
      fmt = new Intl.NumberFormat("en-US", {
        style: "currency",
        currency,
        minimumFractionDigits: whole ? 0 : 2,
        maximumFractionDigits: whole ? 0 : 2,
      });
    } catch {
      fmt = whole ? EUR0 : EUR; // unknown code → EUR fallback
    }
    fmtCache.set(key, fmt);
  }
  return fmt.format(amount);
}

/** Convert a Prisma Decimal (or null) to a plain number. */
export function dec(value: { toString(): string } | null | undefined): number {
  if (value == null) return 0;
  return Number(value.toString());
}

export function formatDate(date: Date | string | null | undefined): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleDateString("en-US", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function formatDateShort(date: Date | string | null | undefined): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleDateString("en-US", { day: "2-digit", month: "short" });
}

/** First instant of the month containing `ref` (UTC, midnight). */
export function monthStart(ref: Date = new Date()): Date {
  return new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), 1));
}

/** First instant of the month AFTER the one containing `ref` (exclusive end). */
export function nextMonthStart(ref: Date = new Date()): Date {
  return new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + 1, 1));
}

export function addMonthsUTC(ref: Date, months: number): Date {
  return new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + months, 1));
}

export function daysInMonth(ref: Date = new Date()): number {
  return new Date(
    Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + 1, 0),
  ).getUTCDate();
}

/** "June 2026" */
export function monthLabel(ref: Date = new Date()): string {
  return ref.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Advance a date by one cadence step (used to roll a recurring rule forward).
 *
 * Month steps go by month INDEX with the day clamped to the target month's
 * length — `setUTCMonth(+1)` on the 31st overflows (31 Jan → 3 Mar skips
 * February outright, 31 Aug → 1 Oct and the rule then sits on the 1st for good).
 * Same rule as `occurrenceMonths` in finance.ts. `anchorDay` lets a caller that
 * knows the rule's intended day-of-month restore it after a short month
 * (28 Feb → 31 Mar); without it the clamped day carries forward.
 */
export function advanceByCadence(
  date: Date,
  cadence: "WEEKLY" | "MONTHLY" | "QUARTERLY" | "YEARLY",
  anchorDay?: number,
): Date {
  if (cadence === "WEEKLY") {
    const d = new Date(date);
    d.setUTCDate(d.getUTCDate() + 7);
    return d;
  }
  const step = cadence === "MONTHLY" ? 1 : cadence === "QUARTERLY" ? 3 : 12;
  const monthIdx = date.getUTCFullYear() * 12 + date.getUTCMonth() + step;
  const y = Math.floor(monthIdx / 12);
  const m = monthIdx % 12;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const day = Math.min(anchorDay ?? date.getUTCDate(), lastDay);
  return new Date(
    Date.UTC(
      y,
      m,
      day,
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
}

/** Default palette for new categories (by index). */
export const CATEGORY_COLORS = [
  // Sunset categorical order (validated for colour-blind separation and 3:1 on white)
  "#e2553c",
  "#008a9e",
  "#b97800",
  "#7d4fb0",
  "#5a9a2c",
  "#d64f8a",
  "#2f62b8",
  "#9a5a2a",
];
