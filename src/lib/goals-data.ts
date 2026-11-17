/**
 * F5 — loads every goal with its progress figure. Reads only; the maths is in
 * goals.ts. ACCOUNT figures are the same rolled-forward balances the safe-to-draw
 * tile uses (`getForecastAccounts`); RESERVE is the level due now from the same
 * `getSafeToDraw` computation, so the goals page and the tile can never disagree.
 */
import { prisma } from "./prisma";
import { toEur } from "./currency";
import { dec } from "./utils";
import { getForecastAccounts, getSafeToDraw } from "./money-data";
import { computeGoal, type GoalProgress, type GoalSource } from "./goals";

export interface GoalRow extends GoalProgress {
  id: string;
  name: string;
  source: GoalSource;
  targetDate: string | null;
  startDate: string;
  accountId: string | null;
  accountName: string | null;
  /** ACCOUNT goals: the account's earmark text; null = the account is no longer earmarked. */
  earmark: string | null;
  manualAmount: number | null;
  /** The target stored on the goal; null on a RESERVE goal that follows the schedule. */
  ownTarget: number | null;
  note: string | null;
  archived: boolean;
  sortOrder: number;
  /** ACCOUNT: as-of of the balance used. RESERVE: the next schedule step. */
  asOf: string | null;
  nextStep: { label: string; payDate: string; reserveAfter: number } | null;
  /** Why there is no figure, when there is none. */
  missing: string | null;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

export async function getGoals(userId: string, now: Date = new Date()): Promise<GoalRow[]> {
  const today = iso(now);
  const goals = await prisma.goal.findMany({
    where: { userId },
    orderBy: [{ archived: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }],
    include: { account: { select: { id: true, name: true, earmark: true } } },
  });
  if (!goals.length) return [];

  const needAccounts = goals.some((g) => g.source === "ACCOUNT");
  const needReserve = goals.some((g) => g.source === "RESERVE");
  const [accounts, safe] = await Promise.all([
    needAccounts ? getForecastAccounts(userId) : Promise.resolve([]),
    needReserve ? getSafeToDraw(userId, now) : Promise.resolve(null),
  ]);
  const acct = new Map(accounts.map((a) => [a.id, a]));

  return goals.map((g) => {
    let current: number | null = null;
    let asOf: string | null = null;
    let missing: string | null = null;
    let nextStep: GoalRow["nextStep"] = null;
    let target = g.target == null ? null : dec(g.target);
    let behindSchedule: boolean | undefined;

    if (g.source === "MANUAL") {
      current = g.manualAmount == null ? null : dec(g.manualAmount);
      if (current == null) missing = "No amount entered";
    } else if (g.source === "ACCOUNT") {
      const a = g.accountId ? acct.get(g.accountId) : undefined;
      if (!g.accountId || !a) missing = "The account is gone";
      else if (!a.latest) missing = `No balance stored for ${a.name}`;
      else {
        current = toEur(a.latest.balance, a.latest.currency, new Date(`${a.latest.asOf}T00:00:00Z`)) + a.flowSinceEur;
        asOf = a.latest.asOf;
      }
    } else if (safe) {
      if (safe.reserveMissing) missing = "No reserve schedule";
      else {
        current = safe.reserve;
        if (target == null) target = safe.reserveTarget;
        if (safe.reserveNext) {
          nextStep = { label: safe.reserveNext.label, payDate: safe.reserveNext.payDate, reserveAfter: safe.reserveNext.reserveAfter };
          asOf = safe.reserveNext.payDate;
        }
        behindSchedule = !!safe.reserveNext && safe.reserveNext.payDate < today;
      }
    }

    const progress = computeGoal({
      current,
      target: target ?? 0,
      targetDate: g.targetDate ? iso(g.targetDate) : null,
      startDate: iso(g.createdAt),
      today,
      behindSchedule,
    });
    return {
      ...progress,
      id: g.id,
      name: g.name,
      source: g.source,
      targetDate: g.targetDate ? iso(g.targetDate) : null,
      startDate: iso(g.createdAt),
      accountId: g.accountId,
      accountName: g.account?.name ?? null,
      earmark: g.account?.earmark ?? null,
      manualAmount: g.manualAmount == null ? null : dec(g.manualAmount),
      ownTarget: g.target == null ? null : dec(g.target),
      note: g.note,
      archived: g.archived,
      sortOrder: g.sortOrder,
      asOf,
      nextStep,
      missing,
    };
  });
}
