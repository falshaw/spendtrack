/**
 * The keyword map is first-match-wins, so its ORDER is behaviour. The parsers
 * label ATM rows "Cash withdrawal at <ATM>" and the transfers rule contains the
 * bare word "withdrawal" — if transfers ranked first, real cash would land in an
 * excluded category. A fix in one layer is only a fix once the next layer agrees.
 */
import { describe, expect, it } from "vitest";
import { KEYWORDS, categoriseSlug, normalizeMerchant, suggestCategoryId } from "@/lib/categorise";

describe("categoriseSlug", () => {
  it("routes an ATM row to cash even though the transfers rule matches 'withdrawal'", () => {
    expect(categoriseSlug("Cash withdrawal at Atm 0001 Main Street EXAMPLE CITY")).toBe("cash");
    expect(categoriseSlug("Atm 0002 Central Station")).toBe("cash");
  });

  it("still sends a broker withdrawal and own-account moves to transfers", () => {
    expect(categoriseSlug("Withdrawal")).toBe("transfers");
    expect(categoriseSlug("TRANSFER BETWEEN OWN ACCOUNTS")).toBe("transfers");
    expect(categoriseSlug("Sent money to own account")).toBe("transfers");
  });

  it("keeps loan, insurance and cash ahead of transfers in the precedence list", () => {
    const order = KEYWORDS.map(([, slug]) => slug);
    for (const slug of ["loan", "insurance", "cash"]) {
      expect(order.indexOf(slug)).toBeLessThan(order.indexOf("transfers"));
    }
  });

  it("files tax authorities as tax", () => {
    expect(categoriseSlug("TAX OFFICE SELF ASSESSMENT")).toBe("tax");
    expect(categoriseSlug("Example City Tax Authority")).toBe("tax");
  });

  // Transfers is EXCLUDED from every total. A bare payment label such as
  // "sent money" must not send every outgoing payment there.
  it("only calls a payment a transfer for exchanges, top-ups, brokers and card repayments", () => {
    for (const own of [
      "Sent money to Trading 212",
      "Received money from Example Broker Ltd with reference",
      "Exchanged to USD",
      "Top-Up by *1234",
      "To AMERICAN EXP 0000",
      "PAYMENT RECEIVED - THANK YOU",
      "Credit card repayment",
    ]) {
      expect(categoriseSlug(own), own).toBe("transfers");
    }
  });

  it("lets a payment to anyone else fall through instead of hiding it in transfers", () => {
    for (const thirdParty of [
      "Sent money to Example Ltd",
      "Sent money to Alice Landlord",
      "Sent money to Example Media Studio",
    ]) {
      expect(categoriseSlug(thirdParty), thirdParty).not.toBe("transfers");
    }
    // …and the fall-through must not land somewhere silly: "taxi" inside a company name.
    expect(categoriseSlug("Sent money to TAXIDERMY SUPPLIES LTD")).toBeNull();
    expect(categoriseSlug("EXAMPLE TAXI EXAMPLE CITY")).toBe("transport");
  });

  it("routes a loan instalment to loan, ahead of transfers", () => {
    expect(categoriseSlug("MORTGAGE PAYMENT REF 123 EXAMPLE LTD")).toBe("loan");
    expect(categoriseSlug("Loan repayment 04/2026")).toBe("loan");
  });

  it("knows the generic words for everyday spending", () => {
    const cases: [string, string][] = [
      ["CORNER SUPERMARKET 12", "groceries"],
      ["Example Grocery Store", "groceries"],
      ["City Pharmacy", "health"],
      ["EXAMPLE FUEL 0001", "fuel"],
      ["Central Parking Garage", "transport"],
      ["Harbour Restaurant", "dining"],
      ["Corner Cafe", "dining"],
      ["Home Insurance Premium", "insurance"],
      ["Rent payment March", "rent"],
      ["Example Electricity Co", "utilities"],
    ];
    for (const [merchant, slug] of cases) expect(categoriseSlug(merchant), merchant).toBe(slug);
  });

  it("knows a short list of global brands", () => {
    const cases: [string, string][] = [
      ["AMAZON MARKETPLACE", "shopping"],
      ["IKEA", "shopping"],
      ["NETFLIX.COM", "entertainment"],
      ["Spotify", "entertainment"],
      ["UBER *TRIP", "transport"],
      ["UBER EATS", "dining"],
      ["AIRBNB * HMXXXXXXXX", "travel"],
      ["BOOKING.COM", "travel"],
      ["APPLE.COM/BILL", "subscriptions"],
      ["GOOGLE ONE", "subscriptions"],
      ["McDonald's", "dining"],
      ["STARBUCKS 0001", "dining"],
      ["SHELL 0001", "fuel"],
      ["BP 0001", "fuel"],
    ];
    for (const [merchant, slug] of cases) expect(categoriseSlug(merchant), merchant).toBe(slug);
  });

  it("has no control bytes hiding inside a pattern", () => {
    for (const [re, slug] of KEYWORDS) {
      expect(new RegExp("[\x00-\x1f]").test(re.source), slug).toBe(false);
    }
  });

  it("returns null for an unknown merchant", () => {
    expect(categoriseSlug("SOME SMALL SHOP 42")).toBeNull();
  });
});

describe("suggestCategoryId (shared by the app routes and the rule engine)", () => {
  const rules = [
    { matchText: "acme", categoryId: "c-dining" },
    { matchText: "alice landlord", categoryId: "c-rent" },
  ];

  it("prefers an exact normalised match, then a rule contained in the merchant", () => {
    expect(suggestCategoryId("Acme", rules)).toBe("c-dining");
    expect(suggestCategoryId("ACME DELIVERY LTD EXAMPLE CITY", rules)).toBe("c-dining");
    expect(suggestCategoryId("Sent money to alice landlord", rules)).toBe("c-rent");
    expect(suggestCategoryId("Corner Shop", rules)).toBeNull();
    expect(suggestCategoryId("", rules)).toBeNull();
  });

  // The reverse direction (rule text CONTAINS the merchant) would let the Trading 212
  // merchant "Deposit" match a "car hire deposit" rule — a broker deposit as spend.
  it("never matches a rule that merely contains the merchant", () => {
    const r = [{ matchText: "car hire deposit", categoryId: "c-transport" }];
    expect(suggestCategoryId("Deposit", r)).toBeNull();
    expect(suggestCategoryId("Alice", rules)).toBeNull();
  });

  it("matches whole words only", () => {
    expect(suggestCategoryId("ACMEVILLE SPORTS SHOP", rules)).toBeNull();
  });

  it("picks the longest matching rule, whatever order the DB returned them in", () => {
    const a = { matchText: "acme", categoryId: "c-dining" };
    const b = { matchText: "acme rides", categoryId: "c-transport" };
    expect(suggestCategoryId("ACME RIDES EXAMPLE CITY", [a, b])).toBe("c-transport");
    expect(suggestCategoryId("ACME RIDES EXAMPLE CITY", [b, a])).toBe("c-transport");
    const x = { matchText: "aaa shop", categoryId: "c-x" };
    const y = { matchText: "shop bbb", categoryId: "c-y" };
    expect(suggestCategoryId("aaa shop bbb", [x, y])).toBe(suggestCategoryId("aaa shop bbb", [y, x]));
  });

  it("still matches a rule that learnMerchantRule cut at 60 characters mid-word", () => {
    const cut = "received money from example payment services foundation with";
    expect(cut.length).toBe(60);
    expect(
      suggestCategoryId("Received money from Example Payment Services Foundation without reference X1", [
        { matchText: cut, categoryId: "c-transfers" },
      ]),
    ).toBe("c-transfers");
  });

  it("normalises punctuation and whitespace the way learnMerchantRule stores keys", () => {
    expect(normalizeMerchant("  SHOP.EXAMPLE    INTERNET ")).toBe("shop example internet");
  });
});
