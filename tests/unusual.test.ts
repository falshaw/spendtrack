import { describe, expect, it } from "vitest";
import { findUnusual, median, previousMonths, type UnusualRow } from "@/lib/unusual";

let n = 0;
const row = (month: string, categoryId: string | null, eur: number, merchant = "shop", day = "10"): UnusualRow => ({
  id: `t${++n}`,
  month,
  date: `${month}-${day}`,
  categoryId,
  eur,
  merchant,
  merchantKey: merchant.toLowerCase(),
});
const past12 = (fn: (m: string) => UnusualRow[]) => previousMonths("2026-10", 12).flatMap(fn);

describe("unusual — helpers", () => {
  it("median of odd, even and empty lists", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBe(0);
  });
  it("previous months cross the year", () => {
    expect(previousMonths("2026-02", 3)).toEqual(["2025-11", "2025-12", "2026-01"]);
  });
});

describe("unusual — category spike", () => {
  it("flags a category well above its monthly median", () => {
    const rows = [
      ...past12((m) => [row(m, "dining", 100, "bistro", "05"), row(m, "dining", 100, "bistro", "15"), row(m, "dining", 100, "bistro", "25")]),
      ...["03", "08", "12", "18", "22", "28"].map((d) => row("2026-10", "dining", 150, "bistro", d)),
    ];
    const f = findUnusual(rows, "2026-10");
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: "CATEGORY", categoryId: "dining", amount: 900, usual: 300, excess: 600 });
  });

  it("one charge that explains the jump replaces the category line", () => {
    const rows = [...past12((m) => [row(m, "dining", 300, "bistro")]), row("2026-10", "dining", 900, "bistro")];
    const f = findUnusual(rows, "2026-10");
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: "LARGE", amount: 900, usual: 300 });
  });

  it("does not flag normal variation or small totals", () => {
    const rows = [...past12((m) => [row(m, "dining", 300, "bistro")]), row("2026-10", "dining", 420, "bistro")];
    expect(findUnusual(rows, "2026-10")).toHaveLength(0);
    const small = [...past12((m) => [row(m, "coffee", 20, "cafe")]), row("2026-10", "coffee", 150, "cafe")];
    expect(findUnusual(small, "2026-10")).toHaveLength(0);
  });

  it("empty past months count as zero, so a twice-a-year category is judged against 0", () => {
    const rows = [row("2026-03", "tax", 3000, "tax office"), row("2026-07", "tax", 3000, "tax office"), row("2026-10", "tax", 3000, "tax office")];
    const f = findUnusual(rows, "2026-10");
    expect(f.find((x) => x.kind === "CATEGORY")).toMatchObject({ categoryId: "tax", usual: 0 });
  });

  it("a refund lowers the month total", () => {
    const rows = [
      ...past12((m) => [row(m, "shopping", 200, "store")]),
      row("2026-10", "shopping", 700, "store"),
      row("2026-10", "shopping", -500, "store"),
    ];
    expect(findUnusual(rows, "2026-10").filter((x) => x.kind === "CATEGORY")).toHaveLength(0);
  });
});

describe("unusual — large charge and new merchant", () => {
  it("flags one charge far above the category's usual charge", () => {
    const rows = [
      ...past12((m) => [row(m, "groceries", 60, "freshmart", "05"), row(m, "groceries", 70, "freshmart", "20")]),
      row("2026-10", "groceries", 450, "freshmart"),
    ];
    const large = findUnusual(rows, "2026-10").find((x) => x.kind === "LARGE");
    expect(large).toMatchObject({ amount: 450, merchant: "freshmart" });
  });

  it("needs five past charges before judging a charge", () => {
    const rows = [row("2026-08", "health", 50, "clinic"), row("2026-09", "health", 50, "clinic"), row("2026-10", "health", 600, "clinic")];
    expect(findUnusual(rows, "2026-10").some((x) => x.kind === "LARGE")).toBe(false);
  });

  it("flags a first-time merchant above the floor, once", () => {
    const rows = [
      ...past12((m) => [row(m, "dining", 300, "bistro")]),
      row("2026-10", "shopping", 180, "harbour grill"),
      row("2026-10", "shopping", 40, "kiosk"),
    ];
    const f = findUnusual(rows, "2026-10").filter((x) => x.kind === "NEW_MERCHANT");
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ merchant: "harbour grill", amount: 180 });
  });

  it("a charge flagged LARGE is not repeated as NEW_MERCHANT", () => {
    const rows = [
      ...past12((m) => [row(m, "groceries", 60, "freshmart", "05"), row(m, "groceries", 70, "freshmart", "20")]),
      row("2026-10", "groceries", 500, "new hypermarket"),
    ];
    const f = findUnusual(rows, "2026-10");
    expect(f.filter((x) => x.txnId === f.find((y) => y.kind === "LARGE")?.txnId)).toHaveLength(1);
  });

  it("merges repeat big charges to one merchant into one line", () => {
    const rows = [
      ...past12((m) => [row(m, "tax", 200, "tax office", "05"), row(m, "tax", 190, "tax office", "20")]),
      row("2026-10", "tax", 9000, "vat office", "02"),
      row("2026-10", "tax", 9000, "vat office", "09"),
      row("2026-10", "tax", 6660, "vat office", "16"),
    ];
    const big = findUnusual(rows, "2026-10").filter((x) => x.kind !== "CATEGORY");
    expect(big).toHaveLength(1);
    expect(big[0]).toMatchObject({ kind: "LARGE", count: 3, amount: 24660, date: "2026-10-02" });
  });

  it("returns at most 8 flags, biggest excess first", () => {
    const rows = Array.from({ length: 12 }, (_, i) => row("2026-10", `c${i}`, 300 + i * 100, `m${i}`));
    const f = findUnusual(rows, "2026-10");
    expect(f.length).toBeLessThanOrEqual(8);
    for (let i = 1; i < f.length; i++) expect(f[i - 1].excess).toBeGreaterThanOrEqual(f[i].excess);
  });
});
