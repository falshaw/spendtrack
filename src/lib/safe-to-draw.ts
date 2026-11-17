/**
 * "Safe to draw" — pure, so it is testable. One number: what you can take out
 * NOW without breaking a simple money plan:
 *
 *   1. a share of every unpaid invoice set aside for tax (`taxRate`)
 *   2. a monthly all-in living budget (`monthlyBudget`)
 *   3. an optional reserve BUILT INVOICE BY INVOICE — the steps are data
 *      (`reserve_steps`), not constants: today's reserve is the level of the last
 *      step whose invoices have been received. No steps = no reserve held back.
 *
 *     drawable cash           real balances of every non-investment account that is
 *                             NOT earmarked (an earmark, e.g. "VAT reserve", holds
 *                             the money back; it is shown, never drawn)
 *   + money owed to you       business invoices already earned and not yet paid
 *   − tax set-aside           on those UNPAID invoices only; for invoices already
 *                             received the reserve level is already net of it
 *   − reserve due now         per the schedule, keyed to invoices received
 *   − this month's budget     the monthly budget less what this month's personal
 *                             spending used
 *   = safe to draw            (never more than the drawable cash less this month's budget)
 *
 * Investment accounts are NOT cash and are left out on purpose.
 *
 * A balance that is not in the database is MISSING — never guessed, and the net
 * flow of imported rows is not a balance. With a drawable account's balance
 * missing the number cannot be computed honestly, so `safe` is null and `floor`
 * says what the drawable cash has to exceed instead.
 *
 * The plan's numbers come from the environment (SAFE_TO_DRAW_TAX_RATE,
 * SAFE_TO_DRAW_MONTHLY_BUDGET, SAFE_TO_DRAW_SINCE) with the defaults below.
 */

import { balanceState } from "./balances";

const envNumber = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name]?.trim() ? v : fallback;
};
const envDate = (name: string, fallback: string): string => {
  const v = process.env[name]?.trim();
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : fallback;
};

export const MONEY_RULES = {
  /** Share of each unpaid invoice set aside for tax. */
  taxRate: envNumber("SAFE_TO_DRAW_TAX_RATE", 0.25),
  /** All-in monthly living budget, ≈EUR. */
  monthlyBudget: envNumber("SAFE_TO_DRAW_MONTHLY_BUDGET", 2000),
  /** The day the plan was set — invoice money received from here on counts toward the reserve steps (default: all of it). */
  since: envDate("SAFE_TO_DRAW_SINCE", "2000-01-01"),
} as const;

/**
 * A step counts as reached once the invoice money received covers this share of the
 * steps' planned gross. The planned amounts are hour estimates; a slightly smaller
 * real invoice must not hold the reserve one step behind for ever.
 */
export const RESERVE_MATCH = 0.95;

export interface CashInput {
  name: string;
  /** ≈EUR, null when no statement balance is in the database. */
  amount: number | null;
  asOf: string | null;
  /** Non-null = held back (not drawable); the text says why, e.g. "VAT reserve". */
  earmark?: string | null;
}

export interface ReceivableInput {
  label: string;
  /** Expected payment date, YYYY-MM-DD. */
  date: string;
  amount: number; // ≈EUR, positive
}

export interface ReserveStepInput {
  payDate: string;
  label: string;
  /** Gross of the invoices this step brings, ≈EUR. */
  invoicesGross: number;
  /** The reserve level once those invoices are in, ≈EUR. */
  reserveAfter: number;
}

export interface ReserveDue {
  /** The reserve that must be held today. */
  level: number;
  reached: ReserveStepInput | null;
  next: ReserveStepInput | null;
  /** The final level of the schedule. */
  target: number;
}

/** Today's reserve level: the last step whose invoices (cumulatively) have been received. */
export function reserveDue(steps: ReserveStepInput[], invoicesReceived: number, match: number = RESERVE_MATCH): ReserveDue {
  const sorted = [...steps].sort((a, b) => (a.payDate < b.payDate ? -1 : 1));
  const received = Math.max(0, invoicesReceived);
  let cum = 0;
  let reached: ReserveStepInput | null = null;
  let next: ReserveStepInput | null = null;
  for (const st of sorted) {
    cum += st.invoicesGross;
    if (received >= cum * match - 0.005) {
      reached = st;
    } else {
      next = st;
      break;
    }
  }
  return {
    level: reached?.reserveAfter ?? 0,
    reached,
    next,
    target: sorted.length ? sorted[sorted.length - 1].reserveAfter : 0,
  };
}

export interface SafeToDrawInput {
  cash: CashInput[];
  receivables: ReceivableInput[];
  /** Business invoice money already received since `MONEY_RULES.since`, ≈EUR. */
  invoicesReceived: number;
  /** The reserve plan; empty = no schedule = no reserve held back. */
  reserveSteps: ReserveStepInput[];
  /** Personal spending already booked this calendar month, ≈EUR. */
  spentThisMonth: number;
  /** YYYY-MM-DD. With it, a balance whose as-of is older than STALE_DAYS is listed in `cashStale`. */
  today?: string;
  rules?: { taxRate: number; monthlyBudget: number };
}

export interface SafeToDrawResult {
  /** The number. Null while a drawable balance is missing. */
  safe: number | null;
  /** What the drawable cash has to exceed (before the clamps). Always computable. */
  floor: number;
  /** Known balances of every cash account, earmarked ones included. */
  cashKnown: number;
  /** Known balances of the accounts that are NOT earmarked. */
  cashDrawable: number;
  /** Earmarked accounts: shown on the tile, left out of the drawable cash. */
  held: { name: string; amount: number | null; label: string }[];
  /** Drawable accounts with no balance. */
  cashMissing: string[];
  /** Balances that are present but older than STALE_DAYS — still counted, flagged on the tile. */
  cashStale: { name: string; asOf: string }[];
  cashAccounts: number;
  receivables: number;
  taxSetAside: number;
  /** Reserve due now per the schedule. */
  reserve: number;
  reserveTarget: number;
  reserveReached: ReserveStepInput | null;
  reserveNext: ReserveStepInput | null;
  reserveMissing: boolean;
  budgetLeft: number;
  rules: { taxRate: number; monthlyBudget: number };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const isHeld = (c: CashInput) => c.earmark != null && c.earmark.trim() !== "";

export function computeSafeToDraw(i: SafeToDrawInput): SafeToDrawResult {
  const rules = i.rules ?? MONEY_RULES;
  const known = i.cash.filter((c) => c.amount != null);
  const drawable = i.cash.filter((c) => !isHeld(c));
  const cashKnown = round2(known.reduce((s, c) => s + (c.amount as number), 0));
  const cashDrawable = round2(drawable.reduce((s, c) => s + (c.amount ?? 0), 0));
  const held = i.cash.filter(isHeld).map((c) => ({ name: c.name, amount: c.amount, label: (c.earmark as string).trim() }));
  const cashMissing = drawable.filter((c) => c.amount == null).map((c) => c.name);
  const today = i.today;
  const cashStale = today
    ? known
        .filter((c) => c.asOf != null && balanceState(c.asOf, today) === "stale")
        .map((c) => ({ name: c.name, asOf: c.asOf as string }))
    : [];
  const receivables = round2(i.receivables.reduce((s, r) => s + r.amount, 0));
  const taxSetAside = round2(rules.taxRate * receivables);
  const res = reserveDue(i.reserveSteps, i.invoicesReceived);
  const reserveMissing = i.reserveSteps.length === 0;
  const budgetLeft = round2(Math.max(0, rules.monthlyBudget - Math.max(0, i.spentThisMonth)));
  const floor = round2(taxSetAside + res.level + budgetLeft - receivables);

  let safe: number | null = null;
  if (drawable.length > 0 && cashMissing.length === 0) {
    const headroom = cashDrawable - floor;
    // Money still owed to you counts toward the floor, but it cannot be drawn
    // today — the draw never exceeds the drawable cash less this month's budget.
    safe = round2(Math.max(0, Math.min(headroom, cashDrawable - budgetLeft)));
  }

  return {
    safe,
    floor,
    cashKnown,
    cashDrawable,
    held,
    cashMissing,
    cashStale,
    cashAccounts: i.cash.length,
    receivables,
    taxSetAside,
    reserve: res.level,
    reserveTarget: res.target,
    reserveReached: res.reached,
    reserveNext: res.next,
    reserveMissing,
    budgetLeft,
    rules,
  };
}

/**
 * Has an expected payment already arrived? Same rule as the Upcoming widget:
 * an imported INCOME row on the same account within ±7 days and ±10 % of it.
 */
export function isSettled(
  r: { date: string; amount: number; accountId: string | null },
  rows: { date: string; amount: number; accountId: string | null }[],
): boolean {
  const at = Date.parse(r.date + "T00:00:00Z");
  return rows.some(
    (t) =>
      (r.accountId == null || t.accountId === r.accountId) &&
      Math.abs(Date.parse(t.date + "T00:00:00Z") - at) <= 7 * 86_400_000 &&
      Math.abs(t.amount - r.amount) <= r.amount * 0.1,
  );
}

/**
 * An invoice is EARNED once the month it bills has ended: a client that pays ~30 days
 * after month end means a payment due within 30 days of today is for finished work.
 * Payments further out are future work and are not money owed yet.
 */
export function isEarned(paymentIso: string, todayIso: string): boolean {
  return Date.parse(paymentIso + "T00:00:00Z") - 30 * 86_400_000 <= Date.parse(todayIso + "T00:00:00Z");
}
