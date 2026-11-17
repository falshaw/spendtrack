/**
 * src/lib/import-dedup.ts — the three dedup layers behind the app import route.
 * Each case is a bug that really happened.
 */
import { describe, expect, it } from "vitest";
import {
  collapseOverlap,
  dedupAgainstExisting,
  junkRank,
  looseKey,
  strictKey,
  type DedupRow,
} from "@/lib/import-dedup";

const row = (over: Partial<DedupRow> = {}): DedupRow => ({
  date: "2026-05-17",
  amount: 20,
  merchant: "SEASIDE BEACH BAR",
  type: "EXPENSE",
  currency: "EUR",
  ...over,
});

describe("keys", () => {
  it("strictKey normalises whitespace and case (SHOP.EXAMPLE    INTERNET twins)", () => {
    expect(strictKey("2026-01-02", 10, "SHOP.EXAMPLE     INTERNET", "EXPENSE", "EUR")).toBe(
      strictKey("2026-01-02T00:00:00.000Z", 10, "shop.example internet", "EXPENSE", "EUR"),
    );
  });
  it("looseKey ignores the merchant", () => {
    expect(looseKey("2026-01-02", 5.62, "EXPENSE", "EUR")).toBe("2026-01-02|5.62|EXPENSE|EUR");
  });
});

describe("dedupAgainstExisting", () => {
  it("re-importing the same batch is a no-op", () => {
    const batch = [row(), row({ amount: 10 }), row({ amount: 10 })];
    const v = dedupAgainstExisting(batch, batch);
    expect(v.insert).toEqual([]);
    expect(v.duplicates).toBe(3);
  });

  it("keeps a genuine same-day double: DB holds one, statement lists two", () => {
    const v = dedupAgainstExisting([row(), row()], [row()]);
    expect(v.insert).toHaveLength(1);
    expect(v.duplicates).toBe(1);
  });

  it("never dedups candidates against each other", () => {
    const v = dedupAgainstExisting([row(), row(), row()], []);
    expect(v.insert).toEqual([0, 1, 2]);
  });

  it("dedups a merchant-variant rendering of the same charge", () => {
    const v = dedupAgainstExisting(
      [row({ amount: 5.62, merchant: "Spotify STOCKHOLM" })],
      [row({ amount: 5.62, merchant: "Card transaction of 5.62 EUR issued by Spotify STOCKHOLM" })],
    );
    expect(v.insert).toEqual([]);
    expect(v.variantDuplicates).toBe(1);
  });

  it("an exact match keeps its DB row — a junk rendering cannot eat it first", () => {
    // DB: one real row. Batch: junk rendering first, exact match second, both same loose key.
    const v = dedupAgainstExisting(
      [row({ merchant: "(unknown)" }), row()],
      [row()],
    );
    expect(v.duplicates).toBe(1); // the exact one claimed the DB row
    expect(v.insert).toEqual([0]); // the junk one is the genuinely new second charge
  });

  it("holds back a mirrored twin: DB has the credit wrongly stored as EXPENSE", () => {
    const v = dedupAgainstExisting(
      [row({ amount: 300, merchant: "EXAMPLE STAYS * REF0001 EXAMPLE CITY", type: "INCOME" })],
      [row({ amount: 300, merchant: "EXAMPLE STAYS * REF0001     EXAMPLE CITY", type: "EXPENSE" })],
    );
    expect(v.insert).toEqual([]);
    expect(v.suspectedMirrors).toEqual([0]);
  });

  it("allowMirrors inserts them once a human has looked", () => {
    const v = dedupAgainstExisting(
      [row({ type: "INCOME" })],
      [row({ type: "EXPENSE" })],
      { allowMirrors: true },
    );
    expect(v.insert).toEqual([0]);
    expect(v.suspectedMirrors).toEqual([0]);
  });

  it("a genuine same-day pair (pre-auth + reversal) is not flagged when both legs are listed", () => {
    const pair = [row({ amount: 100, type: "EXPENSE" }), row({ amount: 100, type: "INCOME" })];
    // first import: nothing in the DB
    expect(dedupAgainstExisting(pair, []).suspectedMirrors).toEqual([]);
    // re-import: both legs already there, each claimed by its own twin
    const again = dedupAgainstExisting(pair, pair);
    expect(again.insert).toEqual([]);
    expect(again.suspectedMirrors).toEqual([]);
  });

  it("skip indices are left alone entirely (known date-shift twins)", () => {
    const v = dedupAgainstExisting([row(), row({ amount: 7 })], [], { skip: new Set([0]) });
    expect(v.insert).toEqual([1]);
  });
});

describe("collapseOverlap", () => {
  const csv = (Date: string, Amount: string, Merchant: string, Source: string) => ({
    Date,
    Amount,
    Merchant,
    Currency: "EUR",
    Source,
  });
  // Two files that both cover 10–20 June fully (interior days on both sides).
  const frame = (src: string) => [
    csv("2026-06-01", "-1.00", "frame start", src),
    csv("2026-06-30", "-1.00", "frame end", src),
  ];

  it("passes rows through untouched when there is no Source column", () => {
    const rows = [{ Date: "2026-06-15", Amount: "-5", Merchant: "x", Currency: "EUR" }];
    expect(collapseOverlap(rows).rows).toBe(rows);
  });

  it("the same charge from two overlapping files is one charge; the real merchant wins", () => {
    const out = collapseOverlap([
      ...frame("statement.pdf"),
      ...frame("activity.pdf"),
      csv("2026-06-15", "-12.40", "A N OTHER", "activity.pdf"),
      csv("2026-06-15", "-12.40", "FRESHMART - MAIN STREET 12 EXAMPLE CITY", "statement.pdf"),
    ]);
    const hit = out.rows.filter((r) => r.Amount === "-12.40");
    expect(hit).toHaveLength(1);
    expect(hit[0].Merchant).toContain("FRESHMART");
    // the charge + the two shared frame rows
    expect(out.collapsed).toBe(3);
    // the frame rows sit on both files' EDGES: collapsed all the same, but listed
    expect(out.boundaryCollapsed).toHaveLength(2);
  });

  it("genuine repeats inside one file are kept", () => {
    const out = collapseOverlap([
      ...frame("a.pdf"),
      csv("2026-06-15", "-1.60", "Coffee", "a.pdf"),
      csv("2026-06-15", "-1.60", "Coffee", "a.pdf"),
    ]);
    expect(out.rows.filter((r) => r.Amount === "-1.60")).toHaveLength(2);
  });

  it("a statement-EDGE day collapses like any other, and is reported", () => {
    // Both business statements start on the account-opening day and each prints
    // that whole day. ADDING the counts here injected phantom rows against real
    // statements — so: max, plus a note for a human.
    const out = collapseOverlap([
      csv("2026-03-12", "9000.00", "Money added", "stmt-mar.pdf"),
      csv("2026-03-12", "9000.00", "Money added", "stmt-mar.pdf"),
      csv("2026-03-12", "9000.00", "Money added", "stmt-mar-aug.pdf"),
      csv("2026-03-12", "9000.00", "Money added", "stmt-mar-aug.pdf"),
      csv("2026-08-26", "-10.00", "fee", "stmt-mar-aug.pdf"),
    ]);
    expect(out.rows.filter((r) => r.Amount === "9000.00")).toHaveLength(2);
    expect(out.boundaryCollapsed).toEqual(["2026-03-12|9000.00|INCOME|EUR"]);
  });

  it("a file with the day in its interior speaks for that day", () => {
    const out = collapseOverlap([
      ...frame("full.pdf"),
      csv("2026-06-15", "-1.50", "Parking", "full.pdf"),
      csv("2026-06-15", "-1.50", "Parking", "edge.pdf"), // edge.pdf's only row = an edge
    ]);
    expect(out.rows.filter((r) => r.Amount === "-1.50")).toHaveLength(1);
  });
});

describe("junkRank", () => {
  it("ranks a real merchant over cardholder bleed over a parser artefact", () => {
    const prev = process.env.CARDHOLDER_NAME;
    process.env.CARDHOLDER_NAME = "SMITH";
    expect(junkRank("McDonald's")).toBe(0);
    expect(junkRank("XX SMITH XX")).toBe(1);
    expect(junkRank("SMITHS HARDWARE STORE")).toBe(0);
    if (prev === undefined) delete process.env.CARDHOLDER_NAME;
    else process.env.CARDHOLDER_NAME = prev;
    expect(junkRank("(unknown)")).toBe(2);
    expect(junkRank("")).toBe(2);
    expect(junkRank("Reference number booking date")).toBe(2);
  });
});
