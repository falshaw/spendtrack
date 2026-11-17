import { z } from "zod";
import { NextResponse } from "next/server";
import { SUPPORTED_CURRENCIES, hasRate } from "./currency";

/**
 * Parse + validate a JSON request body against a Zod schema. Returns a
 * discriminated union: either `{ success: true, data }` or
 * `{ success: false, response }` with a ready-to-return 400.
 */
export async function parseRequest<T extends z.ZodTypeAny>(
  schema: T,
  request: Request,
): Promise<
  | { success: true; data: z.infer<T> }
  | { success: false; response: NextResponse }
> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return {
      success: false,
      response: NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }),
    };
  }

  const result = schema.safeParse(body);
  if (!result.success) {
    return {
      success: false,
      response: NextResponse.json(
        { error: "Validation failed", details: result.error.flatten() },
        { status: 400 },
      ),
    };
  }
  return { success: true, data: result.data };
}

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const TxnType = z.enum(["EXPENSE", "INCOME"]);
const Cadence = z.enum(["WEEKLY", "MONTHLY", "QUARTERLY", "YEARLY"]);
const CategoryGroup = z.enum(["INCOME", "NEEDS", "WANTS", "SAVINGS"]);
const Currency = z.enum(SUPPORTED_CURRENCIES);
const AccountType = z.enum([
  "BANK",
  "CARD",
  "CASH",
  "SAVINGS",
  "INVESTMENT",
  "OTHER",
]);
const AccountBiz = z.enum(["PERSONAL", "BUSINESS"]);

export const AccountCreateSchema = z.object({
  name: z.string().min(1, "Name is required").max(60),
  institution: z.string().max(60).nullable().optional(),
  type: AccountType.default("BANK"),
  biz: AccountBiz.default("PERSONAL"),
  currency: Currency.default("EUR"),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "Must be a hex colour")
    .default("#10b981"),
});

export const AccountUpdateSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  institution: z.string().max(60).nullable().optional(),
  type: AccountType.optional(),
  biz: AccountBiz.optional(),
  currency: Currency.optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  isArchived: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  // Held back from "safe to draw" (e.g. "VAT reserve"); "" or null clears it.
  earmark: z
    .preprocess(
      (v) => (typeof v === "string" ? (v.trim() === "" ? null : v.trim()) : v),
      z.string().max(60, "Keep the reason under 60 characters").nullable(),
    )
    .optional(),
});

// Accept "2026-06-02" or full ISO; coerce to Date.
const DateString = z
  .string()
  .min(1)
  .refine((s) => !Number.isNaN(Date.parse(s)), "Invalid date");

// Import rows: the dedup key slices the raw string and compares it with the DB
// side's toISOString(), so anything but YYYY-MM-DD silently misses its twin and
// re-imports as a duplicate. Every producer (dialog, parsers, CSV mapper) sends
// YYYY-MM-DD already; this makes it a contract.
const ImportDateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
  .refine((s) => !Number.isNaN(Date.parse(s)), "Invalid date");

export const TransactionCreateSchema = z.object({
  type: TxnType.default("EXPENSE"),
  amount: z.number().positive("Amount must be greater than 0").max(9_999_999_999.99, "Amount too large"),
  // Any code with a EUR rate, like the statement import — a receipt in any rated currency
  // must not be refused by a short fixed list.
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .default("EUR")
    .refine((c) => hasRate(c), { message: "Currency has no EUR rate (see RATES_TO_EUR in src/lib/currency.ts)" }),
  date: DateString,
  merchant: z.string().min(1, "Merchant is required").max(200),
  accountId: z.string().nullable().optional(),
  categoryId: z.string().nullable().optional(),
  note: z.string().max(500).nullable().optional(),
  reviewed: z.boolean().optional(),
});

export const TransactionUpdateSchema = z.object({
  type: TxnType.optional(),
  amount: z.number().positive().max(9_999_999_999.99, "Amount too large").optional(),
  currency: Currency.optional(),
  date: DateString.optional(),
  merchant: z.string().min(1).max(200).optional(),
  accountId: z.string().nullable().optional(),
  categoryId: z.string().nullable().optional(),
  note: z.string().max(500).nullable().optional(),
  reviewed: z.boolean().optional(),
  // The period the spend belongs to when that differs from the charge date —
  // a flight bought in August for an October holiday. Null = same as `date`.
  accrualDate: DateString.nullable().optional(),
  // Where the receipt for this cost lives (path, link or reference). Null = none on file.
  receiptRef: z.string().max(500).nullable().optional(),
});

// ─── BALANCES, FX ────────────────────────────────────────────────────

const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
  .refine((s) => !Number.isNaN(Date.parse(s)), "Invalid date");

// A statement closing balance. Negative is normal — a card's balance is what you owe.
const BalanceAmount = z
  .number()
  .finite()
  .refine((n) => Math.abs(n) <= 999_999_999_999.99, "Amount too large");

// Typed on /balances. The server records it as origin MANUAL, source "manual" —
// a statement figure only ever comes from scripts/import-balances.ts.
export const AccountBalanceCreateSchema = z.object({
  accountId: z.string().min(1, "Account is required"),
  asOf: IsoDate,
  balance: BalanceAmount,
  currency: Currency.default("EUR"),
});

export const AccountBalanceUpdateSchema = z.object({
  asOf: IsoDate.optional(),
  balance: BalanceAmount.optional(),
  currency: Currency.optional(),
  source: z.string().max(200).nullable().optional(),
});

export const FxUpdateSchema = z.object({
  mode: z.enum(["daily", "hist90"]).default("daily"),
});

export const CategoryCreateSchema = z.object({
  name: z.string().min(1, "Name is required").max(60),
  group: CategoryGroup.default("WANTS"),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "Must be a hex colour")
    .default("#10b981"),
  icon: z.string().max(40).nullable().optional(),
  monthlyBudget: z.number().nonnegative().nullable().optional(),
  excludeFromTotals: z.boolean().optional(),
});

export const CategoryUpdateSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  group: CategoryGroup.optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  excludeFromTotals: z.boolean().optional(),
  icon: z.string().max(40).nullable().optional(),
  monthlyBudget: z.number().nonnegative().nullable().optional(),
  isArchived: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export const RecurringCreateSchema = z.object({
  merchant: z.string().min(1).max(200),
  amount: z.number().positive().max(9_999_999_999.99, "Amount too large"),
  currency: Currency.default("EUR"),
  type: TxnType.default("EXPENSE"),
  cadence: Cadence.default("MONTHLY"),
  nextDate: DateString,
  endDate: DateString.nullable().optional(),
  categoryId: z.string().nullable().optional(),
  accountId: z.string().nullable().optional(),
  active: z.boolean().optional(),
});

export const RecurringUpdateSchema = z.object({
  merchant: z.string().min(1).max(200).optional(),
  amount: z.number().positive().max(9_999_999_999.99, "Amount too large").optional(),
  currency: Currency.optional(),
  type: TxnType.optional(),
  cadence: Cadence.optional(),
  nextDate: DateString.optional(),
  endDate: DateString.nullable().optional(),
  categoryId: z.string().nullable().optional(),
  accountId: z.string().nullable().optional(),
  active: z.boolean().optional(),
});

// F4 recurring detect: a suggestion is addressed by the detector's group key.
const SuggestionKey = z.string().min(3).max(400);
export const RecurringConfirmSchema = z.object({
  key: SuggestionKey,
  merchant: z.string().trim().min(1).max(200).optional(),
  categoryId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).nullable().optional(),
});
export const RecurringDismissSchema = z.object({ key: SuggestionKey });

// ─── F5 GOALS ───────────────────────────────────────────
// Display only. The source decides which extra field is needed: ACCOUNT needs an
// (earmarked — checked in the route) account, MANUAL a manual amount, RESERVE
// neither (its target may be left out = the schedule's final level).
const GoalSource = z.enum(["ACCOUNT", "RESERVE", "MANUAL"]);
const GoalMoney = z.number().min(0).max(9_999_999_999.99, "Amount too large");
const goalShape = {
  name: z.string().trim().min(1, "Name is required").max(80),
  source: GoalSource,
  target: GoalMoney.nullable().optional(),
  targetDate: DateString.nullable().optional(),
  accountId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).nullable().optional(),
  manualAmount: GoalMoney.nullable().optional(),
  note: z.string().max(500).nullable().optional(),
  archived: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
};
type GoalFields = { source?: string; target?: number | null; accountId?: string | null; manualAmount?: number | null };
const goalNeeds = (g: GoalFields, ctx: z.RefinementCtx) => {
  if (g.source === "ACCOUNT" && !g.accountId) ctx.addIssue({ code: "custom", path: ["accountId"], message: "An account goal needs an account" });
  if (g.source === "MANUAL" && g.manualAmount == null) ctx.addIssue({ code: "custom", path: ["manualAmount"], message: "A manual goal needs the amount saved so far" });
  if (g.source !== "RESERVE" && (g.target == null || g.target <= 0)) ctx.addIssue({ code: "custom", path: ["target"], message: "Set a target greater than 0" });
};
export const GoalCreateSchema = z.object(goalShape).superRefine(goalNeeds);
/** PATCH: any subset; the route re-checks the merged goal with GoalCreateSchema. */
export const GoalUpdateSchema = z.object({
  ...goalShape,
  name: goalShape.name.optional(),
  source: GoalSource.optional(),
});

// ─── F1 NET WORTH ───────────────────────────────────────
const NetWorthItemKind = z.enum(["CAR", "ASSET", "LIABILITY"]);
export const NetWorthItemCreateSchema = z.object({
  kind: NetWorthItemKind,
  name: z.string().trim().min(1, "Name is required").max(120),
  amount: z.number().min(0).max(999_999_999_999.99, "Amount too large"),
  currency: Currency.default("EUR"),
  asOf: DateString,
  note: z.string().max(500).nullable().optional(),
});
export const NetWorthItemUpdateSchema = z.object({
  kind: NetWorthItemKind.optional(),
  name: z.string().trim().min(1).max(120).optional(),
  amount: z.number().min(0).max(999_999_999_999.99, "Amount too large").optional(),
  currency: Currency.optional(),
  asOf: DateString.optional(),
  note: z.string().max(500).nullable().optional(),
});
/** POST /api/net-worth/snapshot — a month as YYYY-MM; omitted = the last complete month. */
export const NetWorthSnapshotSchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Month as YYYY-MM").optional(),
});

export const ImportCommitSchema = z.object({
  accountId: z.string().nullable().optional(),
  rows: z
    .array(
      z.object({
        date: ImportDateString,
        merchant: z.string().min(1).max(200),
        amount: z.number().positive().max(9_999_999_999.99, "Amount too large"),
        currency: Currency.default("EUR"),
        type: TxnType,
        categoryId: z.string().nullable().optional(),
        note: z.string().max(500).nullable().optional(),
      }),
    )
    .min(1, "No rows to import")
    .max(5000, "Too many rows in one import"),
});

// ─── F2 RULE ENGINE ─────────────────────────────────────
// Shapes stored as jsonb on `txn_rules`; the pure engine (src/lib/rule-engine.ts)
// reads exactly these. A rule must carry at least one condition and one action.

export const RuleConditionsSchema = z
  .object({
    payee: z
      .object({
        op: z.enum(["contains", "word", "exact", "regex"]),
        value: z.string().min(1).max(200),
      })
      .optional(),
    amountMin: z.number().min(0).max(9_999_999_999.99).optional(),
    amountMax: z.number().min(0).max(9_999_999_999.99).optional(),
    type: TxnType.optional(),
    accountIds: z.array(z.string().max(64)).max(20).optional(),
    currency: z.string().min(3).max(3).optional(),
  })
  .refine(
    (c) =>
      c.payee !== undefined ||
      c.amountMin !== undefined ||
      c.amountMax !== undefined ||
      c.type !== undefined ||
      (c.accountIds !== undefined && c.accountIds.length > 0) ||
      c.currency !== undefined,
    { message: "A rule needs at least one condition" },
  )
  .refine((c) => c.amountMin === undefined || c.amountMax === undefined || c.amountMin <= c.amountMax, {
    message: "amountMin must not exceed amountMax",
  })
  .refine(
    (c) => {
      if (!c.payee || c.payee.op !== "regex") return true;
      try {
        new RegExp(c.payee.value, "i");
        return true;
      } catch {
        return false;
      }
    },
    { message: "Invalid regular expression" },
  );

export const RuleActionsSchema = z
  .object({
    categoryId: z.string().max(64).nullable().optional(),
    displayMerchant: z.string().max(200).nullable().optional(),
    note: z.string().max(500).nullable().optional(),
    tags: z.array(z.string().min(1).max(40)).max(10).optional(),
  })
  .refine(
    (a) => !!a.categoryId || !!(a.displayMerchant && a.displayMerchant.trim()) || !!(a.note && a.note.trim()) || !!(a.tags && a.tags.length),
    { message: "A rule needs at least one action" },
  );

export const RuleCreateSchema = z.object({
  name: z.string().max(80).default(""),
  active: z.boolean().optional(),
  stopProcessing: z.boolean().optional(),
  conditions: RuleConditionsSchema,
  actions: RuleActionsSchema,
});

export const RuleUpdateSchema = z.object({
  name: z.string().max(80).optional(),
  active: z.boolean().optional(),
  stopProcessing: z.boolean().optional(),
  conditions: RuleConditionsSchema.optional(),
  actions: RuleActionsSchema.optional(),
});

export const RuleReorderSchema = z.object({
  ids: z.array(z.string().max(64)).min(1).max(500),
});

/** Date window for preview/apply: inclusive, by charge `date`. */
export const RuleRangeSchema = z.object({
  from: DateString,
  to: DateString,
}).refine((r) => r.from <= r.to, { message: "from must not be after to" });

// ─── F3 SPLITS ──────────────────────────────────────────
// PUT replaces the whole set; [] unsplits. The sum-to-the-cent rule lives in
// src/lib/splits.ts (validateSplits) and in the deferred DB trigger.
export const SplitsPutSchema = z.object({
  parts: z
    .array(
      z.object({
        amount: z.number().positive("Every part must be greater than 0").max(9_999_999_999.99, "Amount too large"),
        categoryId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).nullable().optional(),
        note: z.string().max(200).nullable().optional(),
      }),
    )
    .max(20, "At most 20 parts"),
});

// ─── INVESTMENTS ────────────────────────────────────────
/** POST /api/investments/sync — one broker, or every configured one when omitted. */
export const InvestmentSyncSchema = z.object({
  broker: z.enum(["TRADING212", "IBKR"]).optional(),
});
/** PATCH /api/investments/connections — link a connection to an INVESTMENT account (null = unlink). */
export const InvestmentConnectionSchema = z.object({
  broker: z.enum(["TRADING212", "IBKR", "MANUAL"]),
  accountId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).nullable(),
});
const TickerSymbol = z
  .string()
  .trim()
  .min(1, "Symbol is required")
  .max(20)
  .regex(/^[A-Za-z0-9.\-:]+$/, "Letters, digits, '.', '-' or ':' only")
  .transform((s) => s.toUpperCase());
const Qty = z.number().positive("Must be more than 0").max(1_000_000_000);
const Price = z.number().min(0).max(100_000_000);
export const ManualHoldingCreateSchema = z.object({
  symbol: TickerSymbol,
  name: z.string().trim().max(120).nullable().optional(),
  quantity: Qty,
  avgCost: Price,
  price: Price.nullable().optional(),
  currency: Currency.default("EUR"),
});
export const ManualHoldingUpdateSchema = z.object({
  name: z.string().trim().max(120).nullable().optional(),
  quantity: Qty.optional(),
  avgCost: Price.optional(),
  price: Price.nullable().optional(),
  currency: Currency.optional(),
});

/** Row ids are Prisma cuids; anything else is a 400 before it reaches the database. */
export const IdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/** A ready-to-return 400 for an id that cannot exist, or null when it is well-formed. */
export function badId(id: string): NextResponse | null {
  return IdSchema.safeParse(id).success ? null : NextResponse.json({ error: "Invalid id" }, { status: 400 });
}
