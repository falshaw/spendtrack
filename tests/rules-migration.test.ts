/**
 * F2 parity gate: moving merchant_rules into txn_rules (tier LEARNED, payee.op =
 * word) must not change a single category. For every fixture merchant the new
 * engine, fed the migrated rows, returns what `suggestCategoryId` returned on the
 * old rows.
 */
import { describe, expect, it } from "vitest";
import { suggestCategoryId, type RuleLite } from "@/lib/categorise";
import { evaluateRules, migrateMerchantRule } from "@/lib/rule-engine";

const OLD: (RuleLite & { id: string })[] = [
  { id: "m1", matchText: "acme", categoryId: "seed-cat-dining" },
  { id: "m2", matchText: "spotify", categoryId: "seed-cat-subscriptions" },
  { id: "m3", matchText: "spotify stockholm", categoryId: "seed-cat-entertainment" },
  { id: "m4", matchText: "alice landlord", categoryId: "seed-cat-rent" },
  { id: "m5", matchText: "sent money to example accounting ltd", categoryId: "seed-cat-tax" },
  { id: "m6", matchText: "car hire deposit", categoryId: "seed-cat-transport" },
  { id: "m7", matchText: "card transaction of 5 62 eur issued by spotify stockholm ab s", categoryId: "seed-cat-gaming" }, // 60 chars, cut mid-word
  { id: "m8", matchText: "acme rent", categoryId: "cat-business-travel" },
  { id: "m9", matchText: "b example", categoryId: "seed-cat-groceries" },
  { id: "m10", matchText: "  ", categoryId: "seed-cat-misc" },
];

const MERCHANTS = [
  "ACME.EXO/2026-01-01 Example City",
  "Acmeville Council",
  "Card transaction of 5.62 EUR issued by Spotify STOCKHOLM",
  "Card transaction of 5.62 EUR issued by Spotify STOCKHOLM AB Sweden",
  "Spotify",
  "Sent money to EXAMPLE ACCOUNTING LTD",
  "Deposit",
  "Car hire deposit Springfield",
  "ACME RENT A CAR",
  "B EXAMPLE & SONS LTD",
  "B. Example",
  "Alice Landlord",
  "Carol Example",
  "",
  "   ",
  "!!!",
];

describe("rules-migration parity (fixtures)", () => {
  const migrated = OLD.map(migrateMerchantRule);

  it("every merchant_rules row becomes a LEARNED word rule carrying its matchText verbatim", () => {
    for (const [i, r] of migrated.entries()) {
      expect(r).toMatchObject({
        tier: "LEARNED",
        active: true,
        stopProcessing: true,
        matchText: OLD[i].matchText,
        conditions: { payee: { op: "word", value: OLD[i].matchText } },
        actions: { categoryId: OLD[i].categoryId },
      });
    }
  });

  it("old vs new category is identical for every fixture merchant (diff = 0)", () => {
    const diffs: string[] = [];
    for (const m of MERCHANTS) {
      const oldCat = suggestCategoryId(m, OLD);
      const newCat = evaluateRules({ merchant: m, amount: 1, type: "EXPENSE", accountId: null, currency: "EUR" }, migrated).categoryId;
      if (oldCat !== newCat) diffs.push(`${JSON.stringify(m)}: ${oldCat} -> ${newCat}`);
    }
    expect(diffs).toEqual([]);
    // and the fixtures actually exercise the matcher: at least one hit per class
    expect(suggestCategoryId("ACME.EXO/2026-01-01 Example City", OLD)).toBe("seed-cat-dining");
    expect(suggestCategoryId("Card transaction of 5.62 EUR issued by Spotify STOCKHOLM AB Sweden", OLD)).toBe("seed-cat-gaming");
  });
});
