/**
 * F2 rule engine — pure, no Prisma. USER rules run by priority (then id), each
 * one setting the fields its actions name; `stopProcessing` ends the USER chain.
 * The LEARNED tier is the old merchant_rules matcher, `suggestCategoryId`, byte
 * for byte, and only runs when no USER rule chose a category.
 */
import { describe, expect, it } from "vitest";
import { evaluateRules, matchesConditions, learnedToRuleLite, type TxnRuleLite } from "@/lib/rule-engine";
import { suggestCategoryId } from "@/lib/categorise";

const base = (over: Partial<TxnRuleLite> = {}): TxnRuleLite => ({
  id: "r1",
  tier: "USER",
  priority: 0,
  active: true,
  stopProcessing: true,
  matchText: null,
  conditions: { payee: { op: "contains", value: "spotify" } },
  actions: { categoryId: "cat-subs" },
  ...over,
});

const input = (over: Partial<Parameters<typeof evaluateRules>[0]> = {}) => ({
  merchant: "Card transaction of 5.62 EUR issued by Spotify STOCKHOLM",
  amount: 5.62,
  type: "EXPENSE" as const,
  accountId: "acc-bank-b",
  currency: "EUR",
  ...over,
});

describe("matchesConditions — payee operators", () => {
  it("contains: substring on the normalised merchant, case-insensitive", () => {
    expect(matchesConditions(input(), { payee: { op: "contains", value: "SPOTIFY stock" } })).toBe(true);
    expect(matchesConditions(input(), { payee: { op: "contains", value: "netflix" } })).toBe(false);
  });
  it("word: whole words only", () => {
    expect(matchesConditions(input({ merchant: "Acmeville Council" }), { payee: { op: "word", value: "acme" } })).toBe(false);
    expect(matchesConditions(input({ merchant: "ACME.EXO/2026" }), { payee: { op: "word", value: "acme" } })).toBe(true);
  });
  it("exact: the whole normalised merchant", () => {
    expect(matchesConditions(input({ merchant: "Spotify  STOCKHOLM" }), { payee: { op: "exact", value: "spotify stockholm" } })).toBe(true);
    expect(matchesConditions(input(), { payee: { op: "exact", value: "spotify stockholm" } })).toBe(false);
  });
  it("regex: case-insensitive on the raw merchant; a bad pattern never matches; the pattern is capped at 200 chars", () => {
    expect(matchesConditions(input(), { payee: { op: "regex", value: "spotify\\s+stock" } })).toBe(true);
    expect(matchesConditions(input(), { payee: { op: "regex", value: "(" } })).toBe(false);
    expect(matchesConditions(input(), { payee: { op: "regex", value: "a".repeat(201) } })).toBe(false);
  });
  it("regex sees at most 300 chars of merchant text", () => {
    const m = "x".repeat(300) + "ZZZ";
    expect(matchesConditions(input({ merchant: m }), { payee: { op: "regex", value: "ZZZ" } })).toBe(false);
    expect(matchesConditions(input({ merchant: m }), { payee: { op: "contains", value: "zzz" } })).toBe(true);
  });
});

describe("matchesConditions — amount, type, accounts, currency", () => {
  it("amount bounds are inclusive", () => {
    expect(matchesConditions(input({ amount: 10 }), { amountMin: 10, amountMax: 10 })).toBe(true);
    expect(matchesConditions(input({ amount: 10.01 }), { amountMax: 10 })).toBe(false);
    expect(matchesConditions(input({ amount: 9.99 }), { amountMin: 10 })).toBe(false);
  });
  it("type, accounts and currency must all agree when given", () => {
    expect(matchesConditions(input(), { type: "INCOME" })).toBe(false);
    expect(matchesConditions(input(), { accountIds: ["acc-card-a"] })).toBe(false);
    expect(matchesConditions(input(), { accountIds: ["acc-card-a", "acc-bank-b"] })).toBe(true);
    expect(matchesConditions(input(), { currency: "gbp" })).toBe(false);
    expect(matchesConditions(input(), { currency: "eur" })).toBe(true);
    expect(matchesConditions(input({ accountId: null }), { accountIds: ["acc-card-a"] })).toBe(false);
  });
  it("an empty condition set matches nothing (a rule must say something)", () => {
    expect(matchesConditions(input(), {})).toBe(false);
  });
});

describe("evaluateRules — USER tier", () => {
  it("applies the matching rule's actions and reports which rule fired", () => {
    const out = evaluateRules(input(), [base({ actions: { categoryId: "cat-subs", displayMerchant: "Spotify", note: "music", tags: ["sub"] } })]);
    expect(out).toEqual({ categoryId: "cat-subs", displayMerchant: "Spotify", note: "music", tags: ["sub"], matched: ["r1"] });
  });
  it("runs by priority, then id; stopProcessing ends the chain; a later rule overrides a field, tags merge", () => {
    const rules = [
      base({ id: "b", priority: 1, stopProcessing: false, actions: { categoryId: "cat-b", tags: ["two"] } }),
      base({ id: "a", priority: 0, stopProcessing: false, actions: { categoryId: "cat-a", tags: ["one"] } }),
      base({ id: "c", priority: 2, stopProcessing: true, actions: { displayMerchant: "Spotify" } }),
      base({ id: "d", priority: 3, actions: { categoryId: "cat-d" } }),
    ];
    const out = evaluateRules(input(), rules);
    expect(out.matched).toEqual(["a", "b", "c"]);
    expect(out.categoryId).toBe("cat-b");
    expect(out.displayMerchant).toBe("Spotify");
    expect(out.tags).toEqual(["one", "two"]);
  });
  it("skips inactive rules and rules that do not match", () => {
    const out = evaluateRules(input(), [base({ active: false }), base({ id: "r2", conditions: { payee: { op: "contains", value: "netflix" } } })]);
    expect(out).toEqual({ categoryId: null, displayMerchant: null, note: null, tags: [], matched: [] });
  });
});

describe("evaluateRules — LEARNED tier is the old matcher", () => {
  const learned: TxnRuleLite[] = [
    { id: "l1", tier: "LEARNED", priority: 0, active: true, stopProcessing: true, matchText: "spotify", conditions: { payee: { op: "word", value: "spotify" } }, actions: { categoryId: "cat-learned" } },
    { id: "l2", tier: "LEARNED", priority: 0, active: true, stopProcessing: true, matchText: "spotify stockholm", conditions: { payee: { op: "word", value: "spotify stockholm" } }, actions: { categoryId: "cat-learned-long" } },
  ];
  it("picks the longest learned rule exactly as suggestCategoryId does", () => {
    const out = evaluateRules(input(), learned);
    expect(out.categoryId).toBe(suggestCategoryId(input().merchant, learnedToRuleLite(learned)));
    expect(out.categoryId).toBe("cat-learned-long");
    expect(out.matched).toEqual(["l2"]);
  });
  it("a USER category outranks the learned tier; a USER rule without a category lets the learned tier fill it", () => {
    expect(evaluateRules(input(), [...learned, base({ actions: { categoryId: "cat-user" } })]).categoryId).toBe("cat-user");
    const out = evaluateRules(input(), [...learned, base({ actions: { displayMerchant: "Spotify" } })]);
    expect(out.categoryId).toBe("cat-learned-long");
    expect(out.displayMerchant).toBe("Spotify");
    expect(out.matched).toEqual(["r1", "l2"]);
  });
  it("learnedToRuleLite keeps the stored matchText verbatim (the 60-char edge rule reads its length)", () => {
    const long = "a".repeat(60);
    const lite = learnedToRuleLite([{ ...learned[0], matchText: long, conditions: { payee: { op: "word", value: long } } }]);
    expect(lite).toEqual([{ matchText: long, categoryId: "cat-learned" }]);
  });
  it("an inactive learned rule is left out", () => {
    expect(evaluateRules(input(), [{ ...learned[1], active: false }, learned[0]]).categoryId).toBe("cat-learned");
  });
});
