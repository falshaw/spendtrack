/**
 * Keyword → category-slug map for auto-categorising imported transactions.
 *
 * Single source of truth for the browser import routes (statement upload, CSV
 * import). A learned or user-written rule always wins over this map; it is the
 * fallback for merchants the app has never seen.
 *
 * Deliberately generic: plain words plus a handful of globally known brands.
 * Local shops and chains belong in your own rules on /rules, not in here.
 *
 * Order matters: first match wins.
 */
export const KEYWORDS: [RegExp, string][] = [
  // Loan/mortgage repayment + insurance must win BEFORE the transfers rule — a
  // loan instalment often names your own company or account as the payee. Match
  // the noun alone: PDF word-clustering can reorder wrapped cells, so a
  // contiguous-phrase match is fragile.
  [/loan repay|mortgage/i, "loan"],
  [/insurance/i, "insurance"],
  // Cash BEFORE transfers. The transfers rule matches the bare word "withdrawal",
  // so the parsers' "Cash withdrawal at <ATM>" label would otherwise be routed to
  // Transfers — EXCLUDED from every total, so real cash would vanish. An ATM row is
  // spend, and nothing in this pattern can match an own-account transfer.
  [/\batm\b|cash withdrawal/i, "cash"],
  // Transfers = money moving between your OWN accounts, nothing else — the
  // category is EXCLUDED from every total, so whatever lands here vanishes. A bare
  // payment label such as `sent money` must NOT match: that is every outgoing
  // payment to anyone, and real costs would hide as "internal movement".
  // Only exchanges, top-ups, broker funding and card repayments count; "Sent money
  // to <anyone else>" falls through to the keyword map below, or to uncategorised —
  // which is visible.
  [
    /top.?up|exchange|transfer between own|to own account|converted|withdrawal|money added|trading ?212|\bbroker|american exp|payment received - thank you|card repayment/i,
    "transfers",
  ],
  [/tax office|tax authority|tax payment|income tax|dividend tax/i, "tax"],
  [/rent payment|\brent\b|landlord|lettings/i, "rent"],
  [/electricity|\benergy\b|water supply|\bwater\b|broadband|internet|mobile plan|telecom/i, "utilities"],
  [/attorney|lawyer|solicitor|notary|law firm/i, "legal"],
  [/contractor|freelancer payout/i, "contractors"],
  // retail — ahead of dining/groceries so the brand names win
  [/amazon(?! ?prime)|\bamzn\b|ikea|clothing|department store|bookshop|bookstore|hardware store|electronics/i, "shopping"],
  [/airbnb|booking\.?com|\bhotel\b|hostel|resort|travel agency/i, "travel"],
  [
    /interest charge|late payment|overlimit|annual fee|bank fee|service charge|\bfee\b/i,
    "fees",
  ],
  // entertainment: streaming + cinema + going out — BEFORE dining (a "…bar &
  // grill" is going out, not a meal) and BEFORE subscriptions (streaming is
  // leisure, not a software tool).
  [/netflix|spotify|streaming|cinema|theatre|theater|concert|\bbar\b|\bpub\b|nightclub/i, "entertainment"],
  // fuel stations — BEFORE transport (its own category)
  [/\bshell\b|\bbp\b|petrol|\bfuel\b|gas station|filling station/i, "fuel"],
  [/supermarket|hypermarket|minimarket|grocery|groceries|fresh market/i, "groceries"],
  // dining = food, incl. delivery
  [
    /restaurant|cafe|coffee|starbucks|mcdonald|burger|pizza|sushi|bakery|grill|takeaway|uber ?eats|food delivery|\bfood\b/i,
    "dining",
  ],
  // `taxi(?![a-z])`: a bare `taxi` would match inside company names that merely
  // start with "taxi…" (a taxidermist, say).
  [/\buber\b|taxi(?![a-z])|\btaxis\b|parking|car park|airline|railway|\btrain\b|\bbus\b|\bmetro\b|public transport/i, "transport"],
  // subscriptions = software / cloud tools only (streaming → entertainment)
  [/icloud|apple\.com|google ?(?:one|play|storage|workspace)|subscription|cloud storage|software/i, "subscriptions"],
  [/consulting|professional services/i, "services"],
  [/pharmacy|drugstore|\bgym\b|fitness|doctor|hospital|clinic|dental|dentist|optic/i, "health"],
];

/** Lowercase, strip noise (card refs, punctuation), collapse whitespace. */
export function normalizeMerchant(m: string): string {
  return m
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export interface RuleLite {
  matchText: string;
  categoryId: string;
}

/**
 * Best-guess category id for a merchant, given the user's learned rules: an
 * exact normalised match first, then the LONGEST rule whose text appears in the
 * merchant as whole words. Lives here, not in `rules.ts`, because that module
 * opens the Prisma client at import time and pure callers (the rule engine,
 * tests) must share THIS function without dragging the database singleton in.
 *
 * Three things this deliberately does NOT do:
 *  - match the other way round (`rule.includes(merchant)`): the Trading 212 merchant
 *    `Deposit` would match any rule containing "deposit", so a broker deposit could
 *    be filed as spend under, say, a "car hire deposit" → Transport rule;
 *  - take the first hit in whatever order the DB returned the rules — with
 *    overlapping rules the winner would change between runs. Longest text wins,
 *    ties break on the text itself, so the result is a function of the rules alone;
 *  - match inside a word ("acme" in "acmeville").
 */
const RULE_TEXT_MAX = 60; // learnMerchantRule() slices here — may cut mid-word

export function suggestCategoryId(merchant: string, rules: RuleLite[]): string | null {
  const key = normalizeMerchant(merchant);
  if (!key) return null;
  for (const r of rules) if (r.matchText.trim() === key) return r.categoryId;
  const padded = ` ${key} `;
  let best: RuleLite | null = null;
  for (const r of rules) {
    const text = r.matchText.trim();
    if (!text) continue;
    // A rule cut at the 60-char limit may end mid-word, so only its left edge
    // can be held to a word boundary.
    const needle = r.matchText.length >= RULE_TEXT_MAX ? ` ${text}` : ` ${text} `;
    if (!padded.includes(needle)) continue;
    const bt = best?.matchText.trim() ?? "";
    if (!best || text.length > bt.length || (text.length === bt.length && text < bt)) best = r;
  }
  return best?.categoryId ?? null;
}

/** Category slug for a merchant string, or null when nothing matches. */
export function categoriseSlug(merchant: string): string | null {
  const m = (merchant || "").toLowerCase();
  for (const [re, slug] of KEYWORDS) if (re.test(m)) return slug;
  return null;
}

/**
 * Resolve a keyword slug to one of the user's category ids. Seeded categories
 * carry the id `seed-cat-<slug>`; a user who renamed or rebuilt them is matched
 * on name instead, so categorisation degrades to "uncategorised" rather than
 * throwing a foreign category id at the commit route.
 */
export function slugToCategoryId(
  slug: string | null,
  categories: { id: string; name: string }[],
): string | null {
  if (!slug) return null;
  const seeded = categories.find((c) => c.id === `seed-cat-${slug}`);
  if (seeded) return seeded.id;
  const byName = categories.find(
    (c) => c.name.toLowerCase().replace(/[^a-z]/g, "") === slug.replace(/[^a-z]/g, ""),
  );
  return byName?.id ?? null;
}
