/**
 * Rule engine — PURE: no Prisma, no I/O, so the import routes, the rule preview and
 * the tests share one copy (the same reason `suggestCategoryId` lives in
 * categorise.ts).
 *
 * Two tiers, one table (`txn_rules`):
 *   USER    — ordered rules you write on /rules. Evaluated by `priority` (then id);
 *             each match applies the fields its actions name (a later rule overrides,
 *             tags merge); `stopProcessing` ends the USER chain.
 *   LEARNED — the old `merchant_rules` rows, copied 1:1 (payee.op = word, matchText
 *             verbatim). They go through the UNCHANGED `suggestCategoryId` (exact,
 *             then longest whole-word match, 60-char edge rule) and only fill the
 *             category when no USER rule set one. That is what keeps the migration
 *             behaviour-neutral — `tests/rules-migration.test.ts`.
 *
 * Precedence outside this file stays: parser `Category` > rules > keyword map.
 *
 * Actions never touch date/amount/type/currency/account/merchant: a rename writes
 * `displayMerchant`, the raw `merchant` is a dedup key. "Exclude from totals" is a
 * category with `excludeFromTotals`, not a flag here.
 */
import { normalizeMerchant, suggestCategoryId, type RuleLite } from "./categorise";

export type RuleTier = "USER" | "LEARNED";
export type PayeeOp = "contains" | "word" | "exact" | "regex";

export interface RuleConditions {
  payee?: { op: PayeeOp; value: string };
  amountMin?: number;
  amountMax?: number;
  type?: "EXPENSE" | "INCOME";
  accountIds?: string[];
  currency?: string;
}

export interface RuleActions {
  categoryId?: string | null;
  displayMerchant?: string | null;
  note?: string | null;
  tags?: string[];
}

export interface TxnRuleLite {
  id: string;
  tier: RuleTier;
  priority: number;
  active: boolean;
  stopProcessing: boolean;
  /** LEARNED rows: the old merchant_rules.match_text, verbatim. Null on USER rules. */
  matchText: string | null;
  conditions: RuleConditions;
  actions: RuleActions;
}

export interface RuleInput {
  merchant: string;
  amount: number;
  type: "EXPENSE" | "INCOME";
  accountId: string | null | undefined;
  currency: string;
}

export interface RuleOutcome {
  categoryId: string | null;
  displayMerchant: string | null;
  note: string | null;
  tags: string[];
  /** Rule ids that fired, in order. */
  matched: string[];
}

export const REGEX_MAX = 200; // pattern length
export const REGEX_TEXT_MAX = 300; // merchant chars a regex may see

const regexCache = new Map<string, RegExp | null>();
function compile(pattern: string): RegExp | null {
  if (pattern.length > REGEX_MAX) return null;
  if (regexCache.has(pattern)) return regexCache.get(pattern)!;
  let re: RegExp | null = null;
  try {
    re = new RegExp(pattern, "i");
  } catch {
    re = null;
  }
  if (regexCache.size > 500) regexCache.clear();
  regexCache.set(pattern, re);
  return re;
}

function payeeMatches(merchant: string, p: { op: PayeeOp; value: string }): boolean {
  if (p.op === "regex") {
    const re = compile(p.value);
    return !!re && re.test(merchant.slice(0, REGEX_TEXT_MAX));
  }
  const key = normalizeMerchant(merchant);
  const text = normalizeMerchant(p.value);
  if (!text) return false;
  if (p.op === "exact") return key === text;
  if (p.op === "contains") return key.includes(text);
  return ` ${key} `.includes(` ${text} `); // word
}

/** True when every condition given holds. An empty condition set matches nothing. */
export function matchesConditions(input: RuleInput, c: RuleConditions): boolean {
  let any = false;
  if (c.payee && c.payee.value !== undefined) {
    any = true;
    if (!payeeMatches(input.merchant, c.payee)) return false;
  }
  if (typeof c.amountMin === "number") {
    any = true;
    if (input.amount < c.amountMin) return false;
  }
  if (typeof c.amountMax === "number") {
    any = true;
    if (input.amount > c.amountMax) return false;
  }
  if (c.type) {
    any = true;
    if (input.type !== c.type) return false;
  }
  if (c.accountIds && c.accountIds.length) {
    any = true;
    if (!input.accountId || !c.accountIds.includes(input.accountId)) return false;
  }
  if (c.currency) {
    any = true;
    if ((input.currency || "").toUpperCase() !== c.currency.toUpperCase()) return false;
  }
  return any;
}

/** LEARNED rows → the shape the old matcher reads. matchText stays verbatim. */
export function learnedToRuleLite(rules: TxnRuleLite[]): RuleLite[] {
  const out: RuleLite[] = [];
  for (const r of rules) {
    if (r.tier !== "LEARNED" || !r.active) continue;
    const matchText = r.matchText ?? r.conditions.payee?.value ?? "";
    const categoryId = r.actions.categoryId;
    if (!categoryId) continue;
    out.push({ matchText, categoryId });
  }
  return out;
}

const byOrder = (a: TxnRuleLite, b: TxnRuleLite) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function evaluateRules(input: RuleInput, rules: TxnRuleLite[]): RuleOutcome {
  const out: RuleOutcome = { categoryId: null, displayMerchant: null, note: null, tags: [], matched: [] };
  const user = rules.filter((r) => r.tier === "USER" && r.active).sort(byOrder);
  for (const r of user) {
    if (!matchesConditions(input, r.conditions)) continue;
    out.matched.push(r.id);
    const a = r.actions;
    if (a.categoryId !== undefined && a.categoryId !== null) out.categoryId = a.categoryId;
    if (a.displayMerchant !== undefined && a.displayMerchant !== null && a.displayMerchant.trim()) out.displayMerchant = a.displayMerchant.trim();
    if (a.note !== undefined && a.note !== null && a.note.trim()) out.note = a.note.trim();
    if (a.tags) for (const t of a.tags) if (t && !out.tags.includes(t)) out.tags.push(t);
    if (r.stopProcessing) break;
  }
  if (out.categoryId === null) {
    const learned = rules.filter((r) => r.tier === "LEARNED" && r.active);
    const lite = learnedToRuleLite(learned);
    const cat = suggestCategoryId(input.merchant, lite);
    if (cat) {
      out.categoryId = cat;
      // Report the row that won: the one whose matchText the matcher chose.
      const key = normalizeMerchant(input.merchant);
      const winner =
        learned.find((r) => (r.matchText ?? "").trim() === key && r.actions.categoryId === cat) ??
        learned
          .filter((r) => r.actions.categoryId === cat && ` ${key} `.includes(` ${(r.matchText ?? "").trim()}${(r.matchText ?? "").length >= 60 ? "" : " "}`))
          .sort((x, y) => (y.matchText ?? "").trim().length - (x.matchText ?? "").trim().length)[0];
      if (winner) out.matched.push(winner.id);
    }
  }
  return out;
}

/** The exact shape the 9_txn_rules migration writes for one merchant_rules row. */
export function migrateMerchantRule(r: { id: string; matchText: string; categoryId: string }): TxnRuleLite {
  return {
    id: `lrn_${r.id}`,
    tier: "LEARNED",
    priority: 0,
    active: true,
    stopProcessing: true,
    matchText: r.matchText,
    conditions: { payee: { op: "word", value: r.matchText } },
    actions: { categoryId: r.categoryId },
  };
}

/** Parse a stored jsonb column defensively — a hand-edited row must not crash an import. */
export function toRuleLite(row: {
  id: string;
  tier: string;
  priority: number;
  active: boolean;
  stopProcessing: boolean;
  matchText: string | null;
  conditions: unknown;
  actions: unknown;
}): TxnRuleLite {
  const c = (row.conditions && typeof row.conditions === "object" ? row.conditions : {}) as RuleConditions;
  const a = (row.actions && typeof row.actions === "object" ? row.actions : {}) as RuleActions;
  return {
    id: row.id,
    tier: row.tier === "LEARNED" ? "LEARNED" : "USER",
    priority: row.priority,
    active: row.active,
    stopProcessing: row.stopProcessing,
    matchText: row.matchText,
    conditions: c,
    actions: a,
  };
}
