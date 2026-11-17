import { prisma } from "./prisma";
import { toEur } from "./currency";
import { expandSplits } from "./splits";
import {
  dec,
  monthStart,
  nextMonthStart,
  addMonthsUTC,
  daysInMonth,
} from "./utils";

/**
 * F3: the parts of a split row, selected beside the row so `expandSplits` can turn
 * one reconciled row into one row per part (own category, own exclusion). Grand
 * totals do not move; only the per-category spread does.
 */
const SPLITS = { splits: { select: { amount: true, categoryId: true } } } as const;

// All aggregate figures are in the EUR base (native amounts converted via
// src/lib/currency). Per-row displays use the native `currency`.

export interface CategorySlice {
  id: string;
  name: string;
  color: string;
  group: string;
  budget: number | null; // EUR
  spent: number; // EUR
  pct: number | null;
}

export interface PacePoint {
  day: number;
  ideal: number | null;
  actual: number | null;
}

export interface RecentTxn {
  id: string;
  date: string;
  merchant: string;
  amount: number; // native
  currency: string;
  type: "EXPENSE" | "INCOME";
  reviewed: boolean;
  categoryName: string | null;
  categoryColor: string | null;
}

export interface UpcomingItem {
  id: string;
  merchant: string;
  amount: number; // native
  currency: string;
  type: "EXPENSE" | "INCOME";
  nextDate: string;
  daysUntil: number;
  categoryName: string | null;
  categoryColor: string | null;
}

export interface DashboardData {
  monthLabelRef: string;
  income: number;
  spent: number;
  net: number;
  lastIncome: number;
  lastSpent: number;
  totalBudget: number;
  freeToSpend: number;
  hasBudget: boolean;
  dayOfMonth: number;
  daysInMonth: number;
  pace: PacePoint[];
  categories: CategorySlice[];
  donut: { name: string; value: number; color: string }[];
  recent: RecentTxn[];
  toReviewCount: number;
  upcoming: UpcomingItem[];
}

const UNCATEGORISED_COLOR = "#64748b";
/** Slice id + group for spend that has no category — never a real category id. */
export const UNCATEGORISED_ID = "__uncat__";
export const UNCATEGORISED_GROUP = "UNCATEGORISED";

/**
 * A refund = an INCOME txn sitting in a spend category (NEEDS/WANTS/SAVINGS):
 * it nets against that category's spend instead of counting as income. INCOME
 * in an income-group category, or uncategorised income (salary, client
 * payments), is real income. One definition — every aggregate must use it.
 */
export const makeIsRefund =
  (groupById: Map<string, string>) =>
  (type: string, categoryId: string | null): boolean => {
    if (type !== "INCOME" || !categoryId) return false;
    const g = groupById.get(categoryId);
    return g != null && g !== "INCOME";
  };

/**
 * The mirror image of a refund: an EXPENSE sitting in an INCOME-group category
 * (an overpaid salary handed back to the employer) is income handed back, so it
 * reduces income instead of counting as spend. Every income/spend split uses it.
 */
export const makeIsIncomeReversal =
  (groupById: Map<string, string>) =>
  (type: string, categoryId: string | null): boolean =>
    type === "EXPENSE" && !!categoryId && groupById.get(categoryId) === "INCOME";

/** Per-category EUR spend + budget for the month containing `ref`. */
export async function getBudgetStatus(
  userId: string,
  ref: Date = new Date(),
  scope: Scope = "all",
): Promise<CategorySlice[]> {
  const start = monthStart(ref);
  const end = nextMonthStart(ref);
  const acctWhere = await scopeAccountFilter(userId, scope);

  const [allCategories, txns] = await Promise.all([
    // EVERY category, then filtered in code: the refund rule needs the group of an
    // archived category too, and archived spend still has to reach the total —
    // building this from the live list left it out of "Spent this month" while
    // the dashboard beside it counted it (getDashboard has the same fix).
    prisma.category.findMany({
      where: { userId },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
    prisma.transaction.findMany({
      where: { userId, ...periodWhere(start, end), ...acctWhere },
      select: { amount: true, currency: true, categoryId: true, type: true, ...SPLITS },
    }).then(expandSplits),
  ]);
  const excluded = new Set(allCategories.filter((c) => c.excludeFromTotals).map((c) => c.id));

  // Net refunds: an INCOME txn in a *spend* category subtracts from that
  // category's spend (a return came back), an EXPENSE adds. Real income
  // (INCOME-group category) is not negative spend — same rule as getDashboard.
  const groupById = new Map(allCategories.map((c) => [c.id, c.group]));
  const isRefund = makeIsRefund(groupById);
  const spentByCat = new Map<string, number>();
  for (const t of txns) {
    if (t.categoryId && excluded.has(t.categoryId)) continue;
    // Uncategorised income is real income (salary before it is tagged), not spend.
    if (t.type === "INCOME" && !isRefund(t.type, t.categoryId)) continue;
    const eur = toEur(dec(t.amount), t.currency);
    const signed = t.type === "EXPENSE" ? eur : -eur;
    const key = t.categoryId ?? UNCATEGORISED_ID;
    spentByCat.set(key, (spentByCat.get(key) ?? 0) + signed);
  }

  // Live categories always get a row (so a cap can be set before anything is
  // spent); an archived one only while it still carries spend this month.
  const slices: CategorySlice[] = allCategories
    .filter((c) => !c.excludeFromTotals)
    .filter((c) => !c.isArchived || Math.abs(spentByCat.get(c.id) ?? 0) >= 0.005)
    .map((c) => {
      const budget = c.monthlyBudget == null ? null : dec(c.monthlyBudget);
      const spent = spentByCat.get(c.id) ?? 0;
      return {
        id: c.id,
        name: c.name,
        color: c.color,
        group: c.group,
        budget,
        spent,
        pct: budget && budget > 0 ? spent / budget : null,
      };
    });
  // Uncategorised spend belongs to no cap but IS spend: it rides along in its own
  // group, so it reaches "Spent this month" without becoming an editable budget row.
  const uncat = spentByCat.get(UNCATEGORISED_ID) ?? 0;
  if (Math.abs(uncat) >= 0.005) {
    slices.push({
      id: UNCATEGORISED_ID,
      name: "Uncategorised",
      color: UNCATEGORISED_COLOR,
      group: UNCATEGORISED_GROUP,
      budget: null,
      spent: uncat,
      pct: null,
    });
  }
  return slices;
}

/**
 * The most recent month with *meaningful* activity (≥5 transactions),
 * start-of-month. Skips a stray single transaction in a near-empty latest
 * month (e.g. one income posting) so the app lands on a month that actually
 * shows spending. Falls back to the latest txn, then the current month.
 */
export async function latestTxnMonth(userId: string): Promise<Date> {
  const rows = await prisma.$queryRaw<{ m: Date; n: bigint }[]>`
    SELECT date_trunc('month', "date") AS m, count(*) AS n
    FROM "transactions"
    WHERE "user_id" = ${userId}
    GROUP BY 1
    ORDER BY 1 DESC
  `;
  const meaningful = rows.find((r) => Number(r.n) >= 5);
  if (meaningful) return monthStart(meaningful.m);
  if (rows.length > 0) return monthStart(rows[0].m);
  return monthStart(new Date());
}

export interface MonthCoverage {
  complete: boolean;
  note: string | null; // e.g. "Bank A ends 7 May, Amex ends 20 May"
}

const MAJOR_ACCOUNT_MIN_TXNS = 50;

/**
 * Is the month of `ref` fully covered? A month is "partial" when a *major*
 * account's all-time last transaction falls inside it, several days before
 * month-end — i.e. that account's statement stops mid-month (a bank
 * "ends May 7" case), so later spend on it isn't imported yet.
 */
export async function getMonthCoverage(userId: string, ref: Date): Promise<MonthCoverage> {
  const start = monthStart(ref);
  const end = nextMonthStart(ref);
  const prev1 = addMonthsUTC(ref, -1);
  const prev2 = addMonthsUTC(ref, -2);
  const rows = await prisma.$queryRaw<
    {
      name: string;
      total: bigint;
      in_month: bigint;
      in_prev1: bigint;
      in_prev2: bigint;
      last_date: Date | null;
      last_in_month: Date | null;
      balance_in_month: Date | null;
    }[]
  >`
    SELECT a.name AS name,
      count(t.*) AS total,
      count(t.*) FILTER (WHERE t."date" >= ${start} AND t."date" < ${end}) AS in_month,
      count(t.*) FILTER (WHERE t."date" >= ${prev1} AND t."date" < ${start}) AS in_prev1,
      count(t.*) FILTER (WHERE t."date" >= ${prev2} AND t."date" < ${prev1}) AS in_prev2,
      max(t."date") AS last_date,
      max(t."date") FILTER (WHERE t."date" >= ${start} AND t."date" < ${end}) AS last_in_month,
      (SELECT max(b."as_of") FROM "account_balances" b
        WHERE b."account_id" = a.id AND b."as_of" >= ${start} AND b."as_of" < ${end}) AS balance_in_month
    FROM "accounts" a
    LEFT JOIN "transactions" t ON t."account_id" = a.id AND t."user_id" = ${userId}
    WHERE a."user_id" = ${userId}
    GROUP BY a.id, a.name
  `;
  const graceMs = 4 * 86_400_000;
  const cutoff = end.getTime() - graceMs;
  // The "data frontier" = newest transaction across all accounts. A statement-cycle
  // card (e.g. Amex closes on the 20th) always ends a week or so before month-end,
  // which is NOT a gap — it's just its cycle. So only treat an account as cutting the
  // month short if it is ALSO materially behind the frontier (a genuinely missing
  // chunk, like a bank that "ends May 7" while other accounts already reach month-end).
  // Measure the frontier WITHIN the month being judged. Using the global newest
  // transaction let a single row dated in a LATER month (e.g. an August tax payment
  // entered by hand) drag the frontier forward and false-flag every statement-cycle
  // card in the month you are actually looking at.
  const frontierMs = rows.reduce(
    (mx, r) => (r.last_in_month ? Math.max(mx, new Date(r.last_in_month).getTime()) : mx),
    0,
  );
  const frontierCutoff = frontierMs - 12 * 86_400_000;
  const partial: { name: string; date: Date; missing: boolean }[] = [];
  for (const r of rows) {
    if (!r.last_date) continue;
    // A balance dated at month end proves the statement reached it: the account was
    // just quiet after its last row (statement to 31.10, last row on 07.10).
    if (r.balance_in_month && new Date(r.balance_in_month).getTime() >= cutoff) continue;
    const ld = new Date(r.last_date).getTime();
    // A WHOLE statement missing: the account was live in each of the two months
    // before, has nothing in this one, and its data stops before the month starts.
    // The cut-off check below cannot see this (there is no last-row-in-month to
    // measure), so a month with an entire account absent would read "complete".
    // No row-count gate here: a low-volume account with ~5 rows a month would never
    // qualify as "major". A dormant
    // account (a second card, a savings account) has empty previous months, so it never flags;
    // nor does a quiet month in the middle of an account's history (later rows
    // exist, so its statements were imported and the month was simply empty).
    if (
      Number(r.in_month) === 0 &&
      Number(r.in_prev1) > 0 &&
      Number(r.in_prev2) > 0 &&
      ld < start.getTime() &&
      frontierMs > 0
    ) {
      partial.push({ name: r.name, date: new Date(r.last_date), missing: true });
      continue;
    }
    if (Number(r.total) < MAJOR_ACCOUNT_MIN_TXNS || Number(r.in_month) === 0) continue;
    if (ld >= start.getTime() && ld < end.getTime() && ld < cutoff && ld < frontierCutoff) {
      partial.push({ name: r.name, date: new Date(r.last_date), missing: false });
    }
  }
  if (partial.length === 0) return { complete: true, note: null };
  const fmt = (d: Date) =>
    d.toLocaleDateString("en-US", { day: "numeric", month: "short", timeZone: "UTC" });
  partial.sort((a, b) => a.date.getTime() - b.date.getTime());
  return {
    complete: false,
    note: partial
      .map((p) => (p.missing ? `${p.name} not imported (last ${fmt(p.date)})` : `${p.name} ends ${fmt(p.date)}`))
      .join(", "),
  };
}

/** Most recent month with real activity that is also fully covered (no mid-month statement cut-off). */
export async function defaultDashboardMonth(userId: string): Promise<Date> {
  const rows = await prisma.$queryRaw<{ m: Date; n: bigint }[]>`
    SELECT date_trunc('month', "date") AS m, count(*) AS n
    FROM "transactions"
    WHERE "user_id" = ${userId}
    GROUP BY 1
    ORDER BY 1 DESC
  `;
  const candidates = rows.filter((r) => Number(r.n) >= 5).map((r) => monthStart(r.m));
  for (const m of candidates) {
    const cov = await getMonthCoverage(userId, m);
    if (cov.complete) return m;
  }
  return candidates[0] ?? monthStart(new Date());
}

// Scope classification lives on the Account row (`biz` column): PERSONAL or
// BUSINESS. Set per account on /accounts.
export type Scope = "all" | "personal" | "business";

/** All business account ids. */
export async function businessAccountIds(userId: string): Promise<string[]> {
  const accts = await prisma.account.findMany({
    where: { userId, biz: { not: "PERSONAL" } },
    select: { id: true },
  });
  return accts.map((a) => a.id);
}

/** Prisma `where` fragment selecting the accounts for a scope. */
export type ScopeWhere =
  | Record<string, never>
  | { accountId: { in: string[] } }
  | { OR: [{ accountId: null }, { accountId: { notIn: string[] } }] };

/**
 * Period filter used by EVERY total. A transaction counts in the month it BELONGS to:
 * `accrualDate` when set, otherwise the date the bank charged it.
 *
 * Why a second column instead of just moving `date`: statement reconciliation and the
 * two-phase import dedup (`src/lib/import-dedup.ts`) both key on `date`, so editing it
 * makes the row fail to match its own statement line and re-import as a duplicate.
 *
 * The case this exists for: travel bought in one month for a trip in the next. Flights
 * charged on 25 August for a trip on 7 September are September's cost, and August
 * should not carry them.
 *
 * Wrapped in AND, never spread as a bare OR — `scopeAccountFilter` can itself return an
 * `OR` for the Personal scope, and two `OR` keys in one object silently overwrite.
 */
export function periodWhere(start: Date, end: Date) {
  return {
    AND: [
      {
        OR: [
          { accrualDate: null, date: { gte: start, lt: end } },
          { accrualDate: { gte: start, lt: end } },
        ],
      },
    ],
  };
}

/**
 * The date a row COUNTS on — the same rule `periodWhere` filters by. Every
 * month/day bucket must use this, never `date`: filtering by accrual and then
 * bucketing by charge date put September-accrued travel (charged
 * 25.08) in the August trend bar, and dropped it outright when the charge month
 * fell outside the chart window.
 */
export function periodDate(t: { date: Date; accrualDate?: Date | null }): Date {
  return t.accrualDate ?? t.date;
}

export async function scopeAccountFilter(
  userId: string,
  scope: Scope,
): Promise<ScopeWhere> {
  if (scope === "all") return {};
  const accts = await prisma.account.findMany({
    where: { userId },
    select: { id: true, biz: true },
  });
  const allBiz = accts.filter((a) => a.biz !== "PERSONAL").map((a) => a.id);
  // Personal must keep account-less (manually entered) transactions — Prisma
  // `notIn` compiles to SQL NOT IN, which silently drops accountId = NULL rows.
  if (scope === "personal")
    return { OR: [{ accountId: null }, { accountId: { notIn: allBiz } }] };
  if (scope === "business") return { accountId: { in: allBiz } };
  return {};
}

export interface YearSummary {
  year: number;
  total: number; // EUR, expenses excl transfers (refunds netted)
  income: number; // EUR, income excl transfers/refunds
  net: number; // income − total
  months: number; // months with expense activity
  avgPerMonth: number; // mean — distorted by one-offs (a car purchase)
  typicalPerMonth: number; // median month — robust to one-offs
  categories: { name: string; color: string; total: number }[]; // yearly spend per category, desc
  // Money through the categories flagged `excludeFromTotals` (a car purchase as a
  // capitalised asset, an asset sale, transfers to own accounts and brokers): gross out,
  // gross in and the net, per category. Never part of `total` — shown under the top-bills
  // list so a big one-off purchase does not simply vanish from "where the year went".
  // Out and in are both kept because an asset sale nets to a large inflow and Transfers
  // to a small one; neither reads right as a single number.
  excluded: { name: string; color: string; out: number; inflow: number; net: number }[];
  // "The real number": the year total with the one-off and work-only money
  // named, so the per-month figure that matters for next year can be read off the dashboard.
  // Both are category totals by NAME ("Tax", "Business travel"), same netting as `categories`.
  taxTotal: number; // EUR inside `total`
  businessTravelTotal: number; // EUR inside `total` — falls away without a contract
  elapsedMonths: number; // months the mean divides by (incomplete viewed month left out)
}

/** Year-to-date spend + per-month mean & median + per-category totals, scoped. */
export async function getYearSummary(
  userId: string,
  ref: Date = new Date(),
  scope: Scope = "all",
): Promise<YearSummary> {
  const year = ref.getUTCFullYear();
  const start = new Date(Date.UTC(year, 0, 1));
  // "So far" ends with the month being viewed. Running to year-end let a later
  // month (pre-booked September travel accrued forward) into August's mean and
  // median as a tiny €439 month.
  const end = new Date(Math.min(Date.UTC(year + 1, 0, 1), nextMonthStart(ref).getTime()));
  const acctWhere = await scopeAccountFilter(userId, scope);
  const [txns, excludedCatRows, cats, coverage] = await Promise.all([
    prisma.transaction.findMany({
      where: { userId, ...acctWhere, ...periodWhere(start, end) },
      select: { amount: true, currency: true, date: true, accrualDate: true, categoryId: true, type: true, ...SPLITS },
    }).then(expandSplits),
    prisma.category.findMany({ where: { userId, excludeFromTotals: true }, select: { id: true } }),
    prisma.category.findMany({ where: { userId }, select: { id: true, name: true, color: true, group: true } }),
    getMonthCoverage(userId, ref),
  ]);
  const excluded = new Set(excludedCatRows.map((c) => c.id));
  const catInfo = new Map(cats.map((c) => [c.id, { name: c.name, color: c.color }]));
  const groupById = new Map(cats.map((c) => [c.id, c.group]));
  const isRefund = makeIsRefund(groupById);
  const isReversal = makeIsIncomeReversal(groupById);
  const byMonth = new Map<number, number>();
  const byCat = new Map<string, number>();
  const byExcluded = new Map<string, { out: number; inflow: number }>();
  let income = 0;
  for (const t of txns) {
    if (t.categoryId && excluded.has(t.categoryId)) {
      // Tallied per category, both directions; kept out of every total below.
      const eurX = toEur(dec(t.amount), t.currency);
      const acc = byExcluded.get(t.categoryId) ?? { out: 0, inflow: 0 };
      if (t.type === "EXPENSE") acc.out += eurX;
      else acc.inflow += eurX;
      byExcluded.set(t.categoryId, acc);
      continue;
    }
    const eur = toEur(dec(t.amount), t.currency);
    if (t.type === "INCOME" && !isRefund(t.type, t.categoryId)) {
      income += eur;
      continue;
    }
    if (isReversal(t.type, t.categoryId)) {
      income -= eur;
      continue;
    }
    const signed = t.type === "EXPENSE" ? eur : -eur; // refund subtracts from spend
    const mo = periodDate(t).getUTCMonth();
    byMonth.set(mo, (byMonth.get(mo) ?? 0) + signed);
    const key = t.categoryId ?? "__uncat__";
    byCat.set(key, (byCat.get(key) ?? 0) + signed);
  }
  const total = [...byMonth.values()].reduce((s, x) => s + x, 0);
  // Mean and median describe a FULL month. A viewed month whose statements stop
  // half-way (or are missing outright) is in `total` — that money was spent — but
  // it would drag both figures down as if it were a cheap month.
  const refMonth = ref.getUTCFullYear() === year ? ref.getUTCMonth() : 11;
  const skipRef = !coverage.complete;
  const vals = [...byMonth.entries()]
    .filter(([mo]) => !(skipRef && mo === refMonth))
    .map(([, v]) => v)
    .sort((a, b) => a - b);
  // Mean over the months ELAPSED, not the months that happened to have spend: a
  // scope with spend in 3 of 9 months was reporting total/3 as its monthly average.
  const elapsed = Math.max(1, refMonth + 1 - (skipRef ? 1 : 0));
  const meanTotal = vals.reduce((s, x) => s + x, 0);
  const median =
    vals.length === 0
      ? 0
      : vals.length % 2
        ? vals[(vals.length - 1) / 2]
        : (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2;
  const categories = [...byCat.entries()]
    .map(([id, t]) => ({
      name: id === "__uncat__" ? "Uncategorised" : (catInfo.get(id)?.name ?? "Other"),
      color: id === "__uncat__" ? "#64748b" : (catInfo.get(id)?.color ?? "#64748b"),
      total: t,
    }))
    .filter((c) => c.total > 0)
    .sort((a, b) => b.total - a.total);
  const catByName = (name: string) =>
    [...byCat.entries()].reduce((sum, [id, t]) => (catInfo.get(id)?.name === name ? sum + t : sum), 0);
  const excludedOut = [...byExcluded.entries()]
    .map(([id, t]) => ({
      name: catInfo.get(id)?.name ?? "Other",
      color: catInfo.get(id)?.color ?? "#64748b",
      out: t.out,
      inflow: t.inflow,
      net: t.out - t.inflow,
    }))
    .filter((c) => c.out > 0 || c.inflow > 0)
    .sort((a, b) => b.out - a.out);
  return {
    year,
    total,
    income,
    net: income - total,
    months: byMonth.size,
    // Nothing but the incomplete month to go on → fall back to it rather than print 0.
    avgPerMonth: vals.length ? meanTotal / elapsed : total,
    typicalPerMonth: vals.length ? median : total,
    categories,
    excluded: excludedOut,
    taxTotal: catByName("Tax"),
    businessTravelTotal: catByName("Business travel"),
    elapsedMonths: elapsed,
  };
}

/**
 * Does a recurring bill count toward the CURRENT monthly total? A rule recurs, so
 * a past `nextDate` is normal; only a start genuinely in the future — more than
 * one cadence away, i.e. a replacement bill that has not begun — is left out.
 * One definition for `/income` fixed outgoings and the `/recurring` totals: they
 * disagreed during a lease handover, when `/recurring` counted both rents.
 */
export function recurringHasStarted(nextDate: Date, cadence: string, today: Date): boolean {
  if (nextDate <= today) return true;
  const leadDays = (nextDate.getTime() - today.getTime()) / 86_400_000;
  return leadDays <= (cadence === "YEARLY" ? 366 : cadence === "QUARTERLY" ? 93 : 31);
}

export const SETTLE_WINDOW_MS = 7 * 86_400_000;

/**
 * Does an imported row settle a rule's occurrence at `occurrenceMs`? THE matching
 * rule — same type, within ±7 days, within 10 % of the rule's amount (EUR-compared),
 * on the rule's account (an unlinked rule matches any account). Shared by the
 * Upcoming widget and the /recurring status chips so the two can never disagree.
 */
export function settlesOccurrence(
  rule: { amount: { toString(): string }; currency: string; type: string; accountId: string | null },
  t: { amount: { toString(): string }; currency: string; type: string; date: Date | string; accountId: string | null },
  occurrenceMs: number,
): boolean {
  const want = toEur(dec(rule.amount), rule.currency);
  return (
    t.type === rule.type &&
    (rule.accountId == null || t.accountId === rule.accountId) &&
    Math.abs(new Date(t.date).getTime() - occurrenceMs) <= SETTLE_WINDOW_MS &&
    Math.abs(toEur(dec(t.amount), t.currency) - want) <= want * 0.1
  );
}

/**
 * The first occurrence of a recurring rule that no imported row has settled yet,
 * starting from its stored `nextDate`. An occurrence counts as settled per
 * `settlesOccurrence`. Future occurrences are returned untouched; a past one with
 * no match stays where it is, because that bill genuinely is overdue.
 *
 * Steps by month INDEX with the day clamped (31 Jan → 28 Feb → 31 Mar); mutating
 * a Date with setUTCMonth skips February entirely.
 */
export function nextUnsettledOccurrence(
  rule: { nextDate: Date; cadence: string; amount: { toString(): string }; currency: string; type: string; accountId: string | null },
  rows: { amount: { toString(): string }; currency: string; type: string; date: Date; accountId: string | null }[],
  todayMs: number,
): Date {
  const first = new Date(rule.nextDate);
  const day = first.getUTCDate();
  const step = rule.cadence === "QUARTERLY" ? 3 : rule.cadence === "YEARLY" ? 12 : 1;
  const used = new Set<number>(); // one bank row settles one occurrence
  let occ = first;
  for (let i = 1; i <= 60 && occ.getTime() < todayMs; i++) {
    const at = occ.getTime();
    const hit = rows.findIndex((t, idx) => !used.has(idx) && settlesOccurrence(rule, t, at));
    if (hit < 0) break;
    used.add(hit);
    if (rule.cadence === "WEEKLY") {
      occ = new Date(first.getTime() + i * 7 * 86_400_000);
    } else {
      const idx = first.getUTCFullYear() * 12 + first.getUTCMonth() + i * step;
      const y = Math.floor(idx / 12);
      const m = idx % 12;
      const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      occ = new Date(Date.UTC(y, m, Math.min(day, lastDay)));
    }
  }
  return occ;
}

export async function getDashboard(
  userId: string,
  ref: Date = new Date(),
  scope: Scope = "all",
): Promise<DashboardData> {
  const now = new Date();
  const start = monthStart(ref);
  const end = nextMonthStart(ref);
  const lastStart = addMonthsUTC(ref, -1);
  const lastEnd = start;
  const dim = daysInMonth(ref);
  // Live current month → progress to today; a past month is complete.
  const isCurrentMonth =
    ref.getUTCFullYear() === now.getUTCFullYear() &&
    ref.getUTCMonth() === now.getUTCMonth();
  const dayOfMonth = isCurrentMonth ? now.getUTCDate() : dim;

  // Scope → account filter (personal = non-business accounts; business = the rest).
  const acctWhere = await scopeAccountFilter(userId, scope);

  const [monthTxns, lastTxns, categories, excludedCatRows, recentRows, toReviewCount, recurringRows, allCatRows] =
    await Promise.all([
      prisma.transaction.findMany({
        where: { userId, ...acctWhere, ...periodWhere(start, end) },
        select: { amount: true, currency: true, type: true, date: true, accrualDate: true, categoryId: true, ...SPLITS },
      }).then(expandSplits),
      prisma.transaction.findMany({
        where: { userId, ...acctWhere, ...periodWhere(lastStart, lastEnd) },
        select: { amount: true, currency: true, type: true, categoryId: true, ...SPLITS },
      }).then(expandSplits),
      prisma.category.findMany({
        where: { userId, isArchived: false, excludeFromTotals: false },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      }),
      prisma.category.findMany({
        where: { userId, excludeFromTotals: true },
        select: { id: true },
      }),
      prisma.transaction.findMany({
        where: { userId, ...acctWhere },
        orderBy: [{ date: "desc" }, { createdAt: "desc" }],
        take: 8,
        include: { category: true },
      }),
      prisma.transaction.count({ where: { userId, reviewed: false, ...acctWhere } }),
      prisma.recurringRule.findMany({
        where: { userId, active: true },
        include: { category: true },
        orderBy: { nextDate: "asc" },
        take: 8,
      }),
      // EVERY category, archived included: a row in an archived category still
      // has a group (refund-vs-income) and a name/colour (donut). Using only the
      // live list made an INCOME row in an archived spend category count as
      // income here but as a refund in getYearSummary, and left archived spend
      // out of the donut while it stayed in `spent`.
      prisma.category.findMany({
        where: { userId },
        select: { id: true, name: true, color: true, group: true },
      }),
    ]);

  // Money-movement categories (transfers/investments) don't count as spend/income.
  const excluded = new Set(excludedCatRows.map((c) => c.id));
  const groupById = new Map(allCatRows.map((c) => [c.id, c.group]));

  const isRefund = makeIsRefund(groupById);
  const isReversal = makeIsIncomeReversal(groupById);

  let income = 0;
  let spent = 0;
  const spentByCat = new Map<string, number>();
  const cumulativeByDay = new Array<number>(dim + 1).fill(0);

  for (const t of monthTxns) {
    if (t.categoryId && excluded.has(t.categoryId)) continue;
    const eur = toEur(dec(t.amount), t.currency);
    if (t.type === "INCOME" && !isRefund(t.type, t.categoryId)) {
      income += eur;
    } else if (isReversal(t.type, t.categoryId)) {
      income -= eur; // pay handed back — less income, not spend
    } else {
      const signed = t.type === "EXPENSE" ? eur : -eur; // refund subtracts
      spent += signed;
      const key = t.categoryId ?? "__uncat__";
      spentByCat.set(key, (spentByCat.get(key) ?? 0) + signed);
      const d = periodDate(t).getUTCDate();
      if (d >= 1 && d <= dim) cumulativeByDay[d] += signed;
    }
  }

  let lastIncome = 0;
  let lastSpent = 0;
  for (const t of lastTxns) {
    if (t.categoryId && excluded.has(t.categoryId)) continue;
    const eur = toEur(dec(t.amount), t.currency);
    if (t.type === "INCOME" && !isRefund(t.type, t.categoryId)) lastIncome += eur;
    else if (isReversal(t.type, t.categoryId)) lastIncome -= eur;
    else lastSpent += t.type === "EXPENSE" ? eur : -eur;
  }

  const catSlices: CategorySlice[] = categories.map((c) => {
    const budget = c.monthlyBudget == null ? null : dec(c.monthlyBudget);
    const s = spentByCat.get(c.id) ?? 0;
    return {
      id: c.id,
      name: c.name,
      color: c.color,
      group: c.group,
      budget,
      spent: s,
      pct: budget && budget > 0 ? s / budget : null,
    };
  });

  // Spend outside the live list — an archived category, or no category at all — is
  // in `spent` and in the donut, so it must be in this list too or "All categories"
  // does not add up to the Spent card above it. No budget: nothing can cap it.
  const liveIds = new Set(categories.map((c) => c.id));
  for (const [catId, s] of spentByCat.entries()) {
    if (liveIds.has(catId) || Math.abs(s) < 0.005) continue;
    const info = allCatRows.find((c) => c.id === catId);
    if (catId !== UNCATEGORISED_ID && !info) continue;
    catSlices.push({
      id: catId,
      name: info?.name ?? "Uncategorised",
      color: info?.color ?? UNCATEGORISED_COLOR,
      group: info?.group ?? UNCATEGORISED_GROUP,
      budget: null,
      spent: s,
      pct: null,
    });
  }

  const totalBudget = catSlices.reduce((sum, c) => sum + (c.budget ?? 0), 0);
  const hasBudget = totalBudget > 0;
  const freeToSpend = hasBudget ? totalBudget - spent : income - spent;

  const pace: PacePoint[] = [];
  let running = 0;
  for (let d = 1; d <= dim; d++) {
    running += cumulativeByDay[d];
    pace.push({
      day: d,
      ideal: hasBudget ? Math.round((totalBudget * d) / dim) : null,
      actual: d <= dayOfMonth ? Math.round(running) : null,
    });
  }

  const catInfo = new Map(allCatRows.map((c) => [c.id, { name: c.name, color: c.color }]));
  const donutAll: { name: string; value: number; color: string }[] = [];
  for (const [catId, value] of spentByCat.entries()) {
    if (value <= 0) continue;
    if (catId === "__uncat__") {
      donutAll.push({ name: "Uncategorised", value, color: UNCATEGORISED_COLOR });
    } else {
      const info = catInfo.get(catId);
      if (info) donutAll.push({ name: info.name, value, color: info.color });
    }
  }
  donutAll.sort((a, b) => b.value - a.value);
  // No folding here — CategoryDonut folds the tail (and every neutral-colour
  // category) into ONE "Other" slice. Folding twice showed "Other" and "Other (7)".
  const donut = donutAll;

  const recent: RecentTxn[] = recentRows.map((t) => ({
    id: t.id,
    date: t.date.toISOString(),
    merchant: t.merchant,
    amount: dec(t.amount),
    currency: t.currency,
    type: t.type,
    reviewed: t.reviewed,
    categoryName: t.category?.name ?? null,
    categoryColor: t.category?.color ?? null,
  }));

  const todayMidnight = new Date(now.toISOString().slice(0, 10)).getTime();
  // `nextDate` only rolls when "log now" is pressed, but real payments arrive by
  // statement import — so a paid bill sat here as overdue for ever. For DISPLAY,
  // an occurrence that a matching imported row has settled is skipped and the
  // next one shown. The stored rule is not touched.
  const stale = recurringRows.filter((r) => new Date(r.nextDate).getTime() < todayMidnight);
  const settleRows =
    stale.length === 0
      ? []
      : await prisma.transaction.findMany({
          where: {
            userId,
            date: {
              gte: new Date(
                Math.min(...stale.map((r) => new Date(r.nextDate).getTime())) - SETTLE_WINDOW_MS,
              ),
            },
          },
          select: { amount: true, currency: true, type: true, date: true, accountId: true },
        });
  const upcoming: UpcomingItem[] = recurringRows.flatMap((r) => {
    const nd = nextUnsettledOccurrence(r, settleRows, todayMidnight);
    if (r.endDate && nd.getTime() > new Date(r.endDate).getTime()) return []; // ran out
    const daysUntil = Math.round((nd.getTime() - todayMidnight) / 86_400_000);
    return [{
      id: r.id,
      merchant: r.merchant,
      amount: dec(r.amount),
      currency: r.currency,
      type: r.type,
      nextDate: nd.toISOString(),
      daysUntil,
      categoryName: r.category?.name ?? null,
      categoryColor: r.category?.color ?? null,
    }];
  });
  upcoming.sort((a, b) => a.daysUntil - b.daysUntil);

  return {
    monthLabelRef: ref.toISOString(),
    income,
    spent,
    net: income - spent,
    lastIncome,
    lastSpent,
    totalBudget,
    freeToSpend,
    hasBudget,
    dayOfMonth,
    daysInMonth: dim,
    pace,
    categories: catSlices,
    donut,
    recent,
    toReviewCount,
    upcoming,
  };
}

export interface TrendPoint {
  label: string;
  monthRef: string;
  income: number;
  expense: number;
}

/**
 * EUR income vs expense per month for the `months` months ending at `ref`'s
 * month (oldest first). Anchor to the *viewed* month, not "now" — with
 * imported history the newest data is usually in the past, and the chart
 * should follow the month picker instead of showing empty trailing months.
 */
export async function getMonthlyTrend(
  userId: string,
  months = 12,
  scope: Scope = "all",
  ref: Date = new Date(),
): Promise<TrendPoint[]> {
  const start = addMonthsUTC(ref, -(months - 1));
  const end = nextMonthStart(ref);
  const acctWhere = await scopeAccountFilter(userId, scope);

  const [txns, catRows] = await Promise.all([
    prisma.transaction.findMany({
      where: { userId, ...acctWhere, ...periodWhere(start, end) },
      select: { amount: true, currency: true, type: true, date: true, accrualDate: true, categoryId: true, ...SPLITS },
    }).then(expandSplits),
    prisma.category.findMany({
      where: { userId },
      select: { id: true, group: true, excludeFromTotals: true },
    }),
  ]);
  const excluded = new Set(
    catRows.filter((c) => c.excludeFromTotals).map((c) => c.id),
  );
  const groupById = new Map(catRows.map((c) => [c.id, c.group]));
  const isRefund = makeIsRefund(groupById);
  const isReversal = makeIsIncomeReversal(groupById);

  const buckets = new Map<string, { income: number; expense: number }>();
  for (let i = 0; i < months; i++) {
    const m = addMonthsUTC(ref, -(months - 1) + i);
    buckets.set(m.toISOString().slice(0, 7), { income: 0, expense: 0 });
  }

  for (const t of txns) {
    if (t.categoryId && excluded.has(t.categoryId)) continue;
    const key = periodDate(t).toISOString().slice(0, 7);
    const b = buckets.get(key);
    if (!b) continue;
    const eur = toEur(dec(t.amount), t.currency);
    if (t.type === "INCOME" && !isRefund(t.type, t.categoryId)) b.income += eur;
    else if (isReversal(t.type, t.categoryId)) b.income -= eur; // pay handed back
    else b.expense += t.type === "EXPENSE" ? eur : -eur; // refund nets expense
  }

  return Array.from(buckets.entries()).map(([key, v]) => {
    const d = new Date(key + "-01T00:00:00Z");
    return {
      label: d.toLocaleDateString("en-US", {
        month: "short",
        year: "2-digit",
        timeZone: "UTC",
      }),
      monthRef: key,
      income: Math.round(v.income),
      expense: Math.round(v.expense),
    };
  });
}

export interface MerchantSpend {
  name: string;
  total: number; // EUR
  count: number;
}

/** Collapse a raw merchant string to a recognisable name (groups Amazon, ATM rows, etc.). */
function normaliseMerchant(m: string): string {
  const s = m.toLowerCase();
  const map: [RegExp, string][] = [
    [/amazon|\bamzn\b/, "Amazon"],
    [/\buber\b/, "Uber"],
    [/cash withdrawal|\batm\b/, "Cash (ATM)"],
    [/airbnb/, "Airbnb"],
    [/spotify/, "Spotify"],
    [/netflix/, "Netflix"],
    [/\bshell\b|\bbp\b|petrol|\bfuel\b/, "Fuel station"],
  ];
  for (const [re, label] of map) if (re.test(s)) return label;
  // Transfer boilerplate hides the payee — "Sent money to" was showing as a merchant.
  const bare = m.replace(/^(sent money to|received money from|transfer to|money added from)\s+/i, "");
  return bare.split(/\s+/).slice(0, 3).join(" ").slice(0, 28);
}

/** Top spending merchants for the month of `ref`, scoped, excl transfers. */
export async function getTopMerchants(
  userId: string,
  ref: Date = new Date(),
  scope: Scope = "all",
  limit = 8,
): Promise<MerchantSpend[]> {
  const start = monthStart(ref);
  const end = nextMonthStart(ref);
  const acctWhere = await scopeAccountFilter(userId, scope);
  const [txns, cats] = await Promise.all([
    prisma.transaction.findMany({
      where: { userId, ...acctWhere, ...periodWhere(start, end) },
      select: { id: true, amount: true, currency: true, merchant: true, categoryId: true, type: true, ...SPLITS },
    }).then(expandSplits),
    prisma.category.findMany({
      where: { userId },
      select: { id: true, group: true, excludeFromTotals: true },
    }),
  ]);
  const excluded = new Set(cats.filter((c) => c.excludeFromTotals).map((c) => c.id));
  const groupById = new Map(cats.map((c) => [c.id, c.group]));
  const isRefund = makeIsRefund(groupById);
  const isReversal = makeIsIncomeReversal(groupById);
  const byM = new Map<string, { total: number; count: number }>();
  const counted = new Set<string>(); // a split row is one charge, however many parts
  for (const t of txns) {
    if (t.categoryId && excluded.has(t.categoryId)) continue;
    // Spend only. Real income and pay handed back are not merchants you spent at;
    // a refund nets against the merchant it came from (a deposit that came back).
    const refund = isRefund(t.type, t.categoryId);
    if (t.type === "INCOME" && !refund) continue;
    if (isReversal(t.type, t.categoryId)) continue;
    const key = normaliseMerchant(t.merchant);
    const cur = byM.get(key) ?? { total: 0, count: 0 };
    const eur = toEur(dec(t.amount), t.currency);
    cur.total += refund ? -eur : eur;
    if (!refund && !counted.has(t.id)) {
      cur.count += 1;
      counted.add(t.id);
    }
    byM.set(key, cur);
  }
  return [...byM.entries()]
    .map(([name, v]) => ({ name, total: v.total, count: v.count }))
    .filter((x) => x.total >= 0.5)
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}

export interface IncomeSource {
  name: string; // account name
  color: string;
  value: number; // EUR, year-to-date
}

export interface IncomeSalary {
  merchant: string;
  net: number; // monthly net (EUR), from the recurring rule
  nextPayDate: string; // ISO
  daysUntil: number;
}

/** One active recurring INCOME rule, resolved for projection. */
export interface IncomeStream {
  id: string;
  merchant: string;
  amount: number; // EUR per occurrence
  cadence: string;
  nextPayDate: string; // ISO
  daysUntil: number;
  endDate: string | null; // ISO, null = open-ended
  ended: boolean; // past its end date — resolved here, not during render
  accountName: string | null;
  accountColor: string | null;
  remainingPayments: number; // occurrences left this year
  remainingTotal: number; // EUR still due this year
}

export interface IncomeMonth {
  label: string; // "Jul"
  monthIndex: number; // 0-11
  actual: number; // EUR income actually received that month
  projected: number; // EUR expected salary (future months only)
}

export interface IncomeProjection {
  receivedYtd: number; // EUR received Jan → now
  remainingSalary: number; // EUR income still due before year-end (all streams)
  remainingPayments: number; // number of pay-days left this year (all streams)
  projectedTotal: number; // receivedYtd + remainingSalary
}

export interface FixedOutgoing {
  merchant: string;
  monthly: number; // EUR, normalised to per-month
  cadence: string; // WEEKLY | MONTHLY | QUARTERLY | YEARLY
  isTax: boolean; // Tax-category rule (income tax, contributions) — shown as its own sub-group
}

export interface IncomeOverview {
  year: number;
  totalYtd: number; // EUR real income this year (excl transfers + refunds)
  monthsWithIncome: number;
  bySource: IncomeSource[];
  byMonth: IncomeMonth[]; // 12 calendar months of `year`: actual + projected
  projection: IncomeProjection | null; // income to year-end (actual + future streams)
  trend: TrendPoint[]; // 12-month income vs expense
  salary: IncomeSalary | null; // the soonest active income rule (back-compat)
  streams: IncomeStream[]; // every active income rule in scope, soonest first
  fixedOutgoings: FixedOutgoing[]; // active recurring EXPENSE rules, monthly-normalised
  fixedOutgoingsTotal: number; // EUR per month
}

const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * Which months of `year` a non-weekly recurring rule still pays into, given it
 * starts at `nextDate`, stops after `endDate` (null = open-ended), and that
 * months before `firstOpenMonth` are already closed (their actuals are
 * imported, so projecting them would double-count).
 *
 * Steps by month INDEX with the day clamped to the target month's length —
 * mutating a Date on the 31st (31 Aug + 1 month → 1 Oct) silently skips a
 * month, which would drop occurrences from the forecast.
 */
export function occurrenceMonths(
  nextDate: Date,
  endDate: Date | null,
  cadence: string,
  year: number,
  firstOpenMonth: number,
  today: Date | null = null,
): number[] {
  const step = cadence === "QUARTERLY" ? 3 : cadence === "YEARLY" ? 12 : 1;
  const day = nextDate.getUTCDate();
  const endIdx = year * 12 + 11;
  const minIdx = year * 12;
  let idx = nextDate.getUTCFullYear() * 12 + nextDate.getUTCMonth();
  // A stale rule left in the past resumes on-cadence at/after January of `year`.
  if (idx < minIdx) idx += Math.ceil((minIdx - idx) / step) * step;

  const months: number[] = [];
  for (; idx <= endIdx; idx += step) {
    const y = Math.floor(idx / 12);
    const m = idx % 12;
    const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const occurrence = new Date(Date.UTC(y, m, Math.min(day, lastDay)));
    if (endDate && occurrence > endDate) break;
    // An occurrence already behind `today` inside the open month has either
    // arrived by statement import (projecting it again double-counts the
    // month) or was missed (the actual will show that). Either way it is
    // not a forecast any more.
    if (today && occurrence < today) continue;
    if (y === year && m >= firstOpenMonth) months.push(m);
  }
  return months;
}

/**
 * All-income overview for `ref`'s year: real income (same definition the
 * dashboard uses — INCOME txns that aren't refunds and aren't in a
 * transfer/excluded category), grouped by account, plus the salary recurring
 * rule and the 12-month trend.
 */
export async function getIncomeOverview(
  userId: string,
  ref: Date = new Date(),
  scope: Scope = "all",
): Promise<IncomeOverview> {
  const year = ref.getUTCFullYear();
  const start = new Date(Date.UTC(year, 0, 1));
  const end = new Date(Date.UTC(year + 1, 0, 1));
  const acctWhere = await scopeAccountFilter(userId, scope);

  const [txns, cats, incomeRules, trend, expenseRules] = await Promise.all([
    prisma.transaction.findMany({
      // EXPENSE too: pay handed back (an EXPENSE in an income category) reduces income.
      where: { userId, type: { in: ["INCOME", "EXPENSE"] }, ...periodWhere(start, end), ...acctWhere },
      select: {
        amount: true,
        currency: true,
        type: true,
        categoryId: true,
        date: true,
        accrualDate: true,
        accountId: true,
        account: { select: { name: true, color: true } },
        ...SPLITS,
      },
    }).then(expandSplits),
    prisma.category.findMany({
      where: { userId },
      select: { id: true, group: true, excludeFromTotals: true },
    }),
    prisma.recurringRule.findMany({
      where: { userId, type: "INCOME", active: true },
      orderBy: { nextDate: "asc" },
      include: { account: { select: { name: true, color: true, biz: true } } },
    }),
    getMonthlyTrend(userId, 12, scope, ref),
    prisma.recurringRule.findMany({
      where: { userId, type: "EXPENSE", active: true },
      include: { account: { select: { biz: true } }, category: { select: { name: true } } },
    }),
  ]);

  const excluded = new Set(
    cats.filter((c) => c.excludeFromTotals).map((c) => c.id),
  );
  const groupById = new Map(cats.map((c) => [c.id, c.group]));
  const isRefund = makeIsRefund(groupById);
  const isReversal = makeIsIncomeReversal(groupById);

  const bySourceMap = new Map<string, { color: string; value: number }>();
  const monthsSet = new Set<number>();
  const actualByMonth = new Array<number>(12).fill(0);
  // Income already received per account and month — lets the open month tell a
  // payment that has ARRIVED from one still to come (see the projection below).
  const receivedByAcctMonth = new Map<string, number>();
  let totalYtd = 0;
  for (const t of txns) {
    if (t.categoryId && excluded.has(t.categoryId)) continue;
    const reversal = isReversal(t.type, t.categoryId);
    if (t.type === "EXPENSE" && !reversal) continue; // ordinary spend
    // A refund (income sitting in a spend category) is not real income.
    if (t.type === "INCOME" && isRefund("INCOME", t.categoryId)) continue;
    const eur = toEur(dec(t.amount), t.currency) * (reversal ? -1 : 1);
    totalYtd += eur;
    const mIdx = periodDate(t).getUTCMonth();
    if (eur > 0) monthsSet.add(mIdx);
    actualByMonth[mIdx] += eur;
    if (t.accountId) {
      const k = `${t.accountId}|${mIdx}`;
      receivedByAcctMonth.set(k, (receivedByAcctMonth.get(k) ?? 0) + eur);
    }
    const name = t.account?.name ?? "Unknown";
    const cur = bySourceMap.get(name) ?? {
      color: t.account?.color ?? "#5E6B4F",
      value: 0,
    };
    cur.value += eur;
    bySourceMap.set(name, cur);
  }

  const bySource = [...bySourceMap.entries()]
    .map(([name, v]) => ({ name, color: v.color, value: v.value }))
    .filter((s) => s.value >= 0.5) // a €0 row (refund-only account) is noise
    .sort((a, b) => b.value - a.value);

  // An income rule belongs to a scope via its linked account (invoice payments
  // land in a business account, a salary in a personal one). A rule with no account is treated as personal — that's
  // what an unlinked, hand-entered rule has always meant here.
  const ruleInScope = (biz: string | undefined): boolean => {
    const b = biz ?? "PERSONAL";
    if (scope === "all") return true;
    if (scope === "personal") return b === "PERSONAL";
    if (scope === "business") return b !== "PERSONAL";
    return true;
  };

  // Never project into months that are already over: if a rule's nextDate goes
  // stale (income arrives via statement import but "log now" was never
  // pressed), past months would carry BOTH the imported actual and a projected
  // bar — double-counting the projection total.
  const now = new Date();
  const firstOpenMonth =
    now.getUTCFullYear() > year ? 12 : now.getUTCFullYear() === year ? now.getUTCMonth() : 0;
  const today = new Date(new Date().toISOString().slice(0, 10));

  // Walk each rule forward from its nextDate to year-end, stopping at endDate.
  // A rule that has ended (a salary after the contract ended) must
  // contribute nothing, or the forecast invents income that never arrives.
  const projectedByMonth = new Array<number>(12).fill(0);
  const streams: IncomeStream[] = [];
  for (const r of incomeRules) {
    if (!ruleInScope(r.account?.biz)) continue;
    const amountEur = toEur(dec(r.amount), r.currency);
    const nd = new Date(r.nextDate);
    const ruleEnd = r.endDate ? new Date(r.endDate) : null;

    let remainingPayments = 0;
    let remainingTotal = 0;
    if (r.cadence === "WEEKLY") {
      // Weekly rules pay ~4.33×/month; project a monthly-equivalent instead of
      // walking 52 dates — the forecast is month-resolution anyway.
      const monthly = (amountEur * 52) / 12;
      // A rule whose nextDate went stale in a PRIOR year is still running — start
      // it in January. (It used to fall through to month 12 and project nothing.)
      const firstRuleMonth =
        nd.getUTCFullYear() < year ? 0 : nd.getUTCFullYear() === year ? nd.getUTCMonth() : 12;
      for (let m = Math.max(firstOpenMonth, firstRuleMonth); m < 12; m++) {
        const monthEnd = new Date(Date.UTC(year, m + 1, 0));
        if (ruleEnd && monthEnd > ruleEnd && new Date(Date.UTC(year, m, 1)) > ruleEnd) break;
        // The open month is only owed the days still ahead of today — the weeks
        // behind it have already arrived as actuals.
        const isOpenMonth = now.getUTCFullYear() === year && m === now.getUTCMonth();
        const dim = monthEnd.getUTCDate();
        const share = isOpenMonth ? (dim - today.getUTCDate() + 1) / dim : 1;
        projectedByMonth[m] += monthly * share;
        remainingTotal += monthly * share;
        remainingPayments += Math.round(4 * share);
      }
    } else {
      for (const m of occurrenceMonths(nd, ruleEnd, r.cadence, year, firstOpenMonth, today)) {
        // Paid early: the rule says the 30th, the money landed on the 25th and is
        // already imported. Until the 30th passes the occurrence is still "ahead of
        // today", so the month carried it twice — once as actual, once as forecast.
        // Each received euro can settle one rule only, hence the running pool.
        if (r.accountId && now.getUTCFullYear() === year && m === now.getUTCMonth()) {
          const k = `${r.accountId}|${m}`;
          const pool = receivedByAcctMonth.get(k) ?? 0;
          if (amountEur > 0 && pool >= amountEur * 0.9) {
            receivedByAcctMonth.set(k, pool - amountEur);
            continue;
          }
        }
        projectedByMonth[m] += amountEur;
        remainingTotal += amountEur;
        remainingPayments += 1;
      }
    }

    streams.push({
      id: r.id,
      merchant: r.merchant,
      amount: amountEur,
      cadence: r.cadence,
      nextPayDate: nd.toISOString(),
      daysUntil: Math.round((nd.getTime() - today.getTime()) / 86_400_000),
      endDate: ruleEnd ? ruleEnd.toISOString() : null,
      ended: ruleEnd != null && ruleEnd < today,
      accountName: r.account?.name ?? null,
      accountColor: r.account?.color ?? null,
      remainingPayments,
      remainingTotal,
    });
  }
  streams.sort((a, b) => new Date(a.nextPayDate).getTime() - new Date(b.nextPayDate).getTime());

  // Back-compat: `salary` = the soonest still-running stream in scope.
  const soonest = streams.find((s) => !s.ended) ?? null;
  const salary: IncomeSalary | null = soonest
    ? {
        merchant: soonest.merchant,
        net: soonest.amount,
        nextPayDate: soonest.nextPayDate,
        daysUntil: soonest.daysUntil,
      }
    : null;

  const byMonth: IncomeMonth[] = MONTH_LABELS.map((label, m) => ({
    label,
    monthIndex: m,
    actual: actualByMonth[m],
    projected: projectedByMonth[m],
  }));

  let projection: IncomeProjection | null = null;
  if (streams.length > 0) {
    const remainingSalary = streams.reduce((s, x) => s + x.remainingTotal, 0);
    const remainingPayments = streams.reduce((s, x) => s + x.remainingPayments, 0);
    projection = {
      receivedYtd: totalYtd,
      remainingSalary,
      remainingPayments,
      projectedTotal: totalYtd + remainingSalary,
    };
  }

  const perMonth = (amount: number, cadence: string) =>
    cadence === "WEEKLY"
      ? (amount * 52) / 12
      : cadence === "QUARTERLY"
        ? amount / 3
        : cadence === "YEARLY"
          ? amount / 12
          : amount;
  // Expense rules scope by their linked account's `biz` (unlinked = personal),
  // the same rule income streams use. A bill that has ended (an expiring lease)
  // or has not started yet (its replacement) must not count toward the CURRENT
  // monthly fixed total — otherwise the overlap double-counts the same cost.
  const fixedOutgoings: FixedOutgoing[] = expenseRules
    .filter((r) => ruleInScope(r.account?.biz))
    .filter((r) => !r.endDate || new Date(r.endDate) >= today)
    .filter((r) => recurringHasStarted(new Date(r.nextDate), r.cadence, today))
    .map((r) => ({
      merchant: r.merchant,
      monthly: perMonth(toEur(dec(r.amount), r.currency), r.cadence),
      cadence: r.cadence,
      isTax: r.category?.name === "Tax",
    }))
    .sort((a, b) => b.monthly - a.monthly);
  const fixedOutgoingsTotal = fixedOutgoings.reduce((s, o) => s + o.monthly, 0);

  return {
    year,
    totalYtd,
    monthsWithIncome: monthsSet.size,
    bySource,
    byMonth,
    projection,
    trend,
    salary,
    streams,
    fixedOutgoings,
    fixedOutgoingsTotal,
  };
}
