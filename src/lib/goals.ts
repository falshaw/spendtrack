/**
 * F5 goals — pure maths (no Prisma). A goal is DISPLAY ONLY: it never enters safe
 * to draw (the account earmark stays the one exclusion there).
 *
 * Progress comes from the goal's source:
 *   ACCOUNT — the latest balance of an earmarked account, rolled forward by the rows
 *             imported since (same figure the safe-to-draw tile holds back);
 *   RESERVE — the reserve level due now from `reserve_steps` (`reserveDue()`); the
 *             target defaults to the schedule's final level;
 *   MANUAL  — an amount typed on the goal.
 */

export type GoalSource = "ACCOUNT" | "RESERVE" | "MANUAL";
export type GoalStatus = "reached" | "on-track" | "behind" | "no-date" | "no-data";

export interface GoalInput {
  /** ≈EUR; null when the source has no figure (account without a balance, no schedule). */
  current: number | null;
  target: number;
  /** YYYY-MM-DD or null. */
  targetDate: string | null;
  /** YYYY-MM-DD — when the goal was set; the start of the on-track line. */
  startDate: string;
  today: string;
  /** RESERVE only: the schedule's next step is past its date and not yet received. */
  behindSchedule?: boolean;
}

export interface GoalProgress {
  current: number | null;
  target: number;
  /** current / target, NOT capped (1.2 = 120 %); null without a figure or target. */
  pct: number | null;
  remaining: number | null;
  /** Calendar months from today to the target date (fractional), ≥ 0; null without a date. */
  monthsLeft: number | null;
  /** What has to go in per month from now to land on the date; null without a date or once reached. */
  perMonthNeeded: number | null;
  /** Where a straight line from start to target says the goal should be today. */
  expectedNow: number | null;
  status: GoalStatus;
}

const DAY = 86_400_000;
const AVG_MONTH_DAYS = 365.25 / 12;
const toDay = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
const round2 = (n: number) => Math.round(n * 100) / 100;

export function monthsBetween(fromIso: string, toIso: string): number {
  return (toDay(toIso) - toDay(fromIso)) / DAY / AVG_MONTH_DAYS;
}

export function computeGoal(g: GoalInput): GoalProgress {
  const target = Math.max(0, g.target);
  const monthsLeft = g.targetDate ? Math.max(0, monthsBetween(g.today, g.targetDate)) : null;

  if (g.current == null) {
    return { current: null, target, pct: null, remaining: null, monthsLeft, perMonthNeeded: null, expectedNow: null, status: "no-data" };
  }
  const current = round2(g.current);
  const pct = target > 0 ? current / target : null;
  const remaining = round2(Math.max(0, target - current));

  if (target > 0 && current >= target) {
    return { current, target, pct, remaining: 0, monthsLeft, perMonthNeeded: null, expectedNow: target, status: "reached" };
  }

  let perMonthNeeded: number | null = null;
  let expectedNow: number | null = null;
  let status: GoalStatus = "no-date";
  if (g.targetDate) {
    // Overdue (or due this very day): all of what is left is needed now.
    perMonthNeeded = round2(monthsLeft! < 1 ? remaining : remaining / monthsLeft!);
    const span = toDay(g.targetDate) - toDay(g.startDate);
    const elapsed = toDay(g.today) - toDay(g.startDate);
    const frac = span <= 0 ? 1 : Math.min(1, Math.max(0, elapsed / span));
    expectedNow = round2(target * frac);
    status = current + 0.005 >= expectedNow ? "on-track" : "behind";
  }
  // A reserve is on track when the schedule is: a step past its date and not yet
  // received is behind, whatever the straight line says.
  // The reserve grows in steps, so the straight line would read "behind" between them.
  if (g.behindSchedule !== undefined) status = g.behindSchedule ? "behind" : "on-track";
  return { current, target, pct, remaining, monthsLeft: monthsLeft == null ? null : round2(monthsLeft), perMonthNeeded, expectedNow, status };
}
