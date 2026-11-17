import { describe, expect, it } from "vitest";
import { detectDecimalMark, parseAmount, parseCsv, parseDateFlexible } from "@/lib/csv";

describe("parseAmount", () => {
  it("parses plain and EU-formatted numbers", () => {
    expect(parseAmount("1234.56")).toBe(1234.56);
    expect(parseAmount("1.234,56")).toBe(1234.56); // EU thousands + decimal comma
    expect(parseAmount("1,234.56")).toBe(1234.56); // comma thousands + decimal dot
    expect(parseAmount("12,34")).toBe(12.34); // bare decimal comma
  });

  it("strips currency symbols and space/NBSP thousands separators", () => {
    // Spaces as thousands separators must not shrink or drop the amount.
    expect(parseAmount("€23 000.00")).toBe(23000);
    expect(parseAmount("€1 234,56")).toBe(1234.56);
  });

  it("handles negatives: minus sign and accounting parentheses", () => {
    expect(parseAmount("-42.00")).toBe(-42);
    expect(parseAmount("(42.00)")).toBe(-42);
  });

  it("returns null for junk", () => {
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("n/a")).toBeNull();
  });
});

describe("parseDateFlexible", () => {
  it("parses ISO and EU day-first formats", () => {
    expect(parseDateFlexible("2026-06-05")).toBe("2026-06-05");
    expect(parseDateFlexible("05/06/2026")).toBe("2026-06-05"); // EU day-first
    expect(parseDateFlexible("05.06.26")).toBe("2026-06-05");
  });

  it("swaps only when day-first is impossible", () => {
    expect(parseDateFlexible("06/25/2026")).toBe("2026-06-25"); // 25 can't be a month
  });

  it("returns null for junk", () => {
    expect(parseDateFlexible("not a date")).toBeNull();
  });
});

describe("parseCsv", () => {
  it("parses a simple statement with debit/credit columns", () => {
    const text = [
      "Date,Description,Money Out,Money In",
      "2026-06-01,COSTA COFFEE,4.50,",
      '2026-06-02,"REFUND, AMAZON",,12.99',
    ].join("\n");
    const result = parseCsv(text);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({
      date: "2026-06-01",
      merchant: "COSTA COFFEE",
      amount: 4.5,
      type: "EXPENSE",
    });
    expect(result.rows[1]).toMatchObject({
      date: "2026-06-02",
      merchant: "REFUND, AMAZON",
      amount: 12.99,
      type: "INCOME",
    });
  });
});

describe("parseCsv header detection", () => {
  it("never lets 'Value Date' claim the amount column", () => {
    // "Value Date" matches the amount pattern (`value`); first-match-wins mapped
    // amount -> the date column and every row was skipped.
    const text = [
      "Value Date,Description,Amount",
      "2026-06-01,COSTA COFFEE,-4.50",
      "2026-06-02,REFUND,12.99",
    ].join("\n");
    const result = parseCsv(text);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({
      date: "2026-06-01",
      merchant: "COSTA COFFEE",
      amount: 4.5,
      type: "EXPENSE",
    });
    expect(result.rows[1]).toMatchObject({ amount: 12.99, type: "INCOME" });
  });

  it("ignores a running balance column when picking the amount", () => {
    const text = ["Date,Description,Balance,Amount", "2026-06-01,COSTA COFFEE,1000.00,-4.50"].join("\n");
    const result = parseCsv(text);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ amount: 4.5, type: "EXPENSE" });
  });
});

describe("lone thousands separator", () => {
  it("reads a lone dot + three digits as thousands — decimal-comma '-3.000' is 3,000, not 3.00", () => {
    expect(parseAmount("-3.000")).toBe(-3000);
    expect(parseAmount("1.234")).toBe(1234);
    expect(parseAmount("12.5")).toBe(12.5); // a real decimal is untouched
    expect(parseAmount("1234.567")).toBe(1234.567); // 4+ leading digits: not a thousands group
  });

  it("an explicit decimal mark settles it", () => {
    expect(parseAmount("3.000", ",")).toBe(3000);
    expect(parseAmount("1.234,5", ",")).toBe(1234.5);
    expect(parseAmount("1,234", ".")).toBe(1234);
  });

  it("detectDecimalMark: one ',dd' cell makes it a comma file", () => {
    expect(detectDecimalMark(["-3.000", "12,50", "-7,10"])).toBe(",");
    expect(detectDecimalMark(["1,234.50", "12.00"])).toBe(".");
    expect(detectDecimalMark(["100", "250"])).toBeUndefined();
    expect(detectDecimalMark(["1,50", "2.50"])).toBeUndefined(); // mixed: do not guess
  });

  it("rejects a non-calendar date instead of rolling it over", () => {
    expect(parseDateFlexible("31.02.2026")).toBeNull();
    expect(parseDateFlexible("2026-02-31")).toBeNull();
    expect(parseDateFlexible("29.02.2028")).toBe("2028-02-29");
  });

  it("reads text dates without going through local time", () => {
    expect(parseDateFlexible("27 Jul 2026")).toBe("2026-07-27");
    expect(parseDateFlexible("27. julio 2026")).toBe("2026-07-27");
    expect(parseDateFlexible("Jul 27, 2026")).toBe("2026-07-27");
    expect(parseDateFlexible("1 mars 2026")).toBe("2026-03-01");
    expect(parseDateFlexible("not a date")).toBeNull();
  });

  it("a single Amount column with no negatives is read as charges, and says so", () => {
    const r = parseCsv("Date,Description,Amount\n2026-08-01,AMAZON,33.81\n2026-08-02,CAFE,12.00\n");
    expect(r.signAssumed).toBe(true);
    expect(r.rows.every((x) => x.type === "EXPENSE")).toBe(true);
  });

  it("a signed Amount column keeps its signs", () => {
    const r = parseCsv("Date,Description,Amount\n2026-08-01,SALARY,4500.00\n2026-08-02,CAFE,-12.00\n");
    expect(r.signAssumed).toBe(false);
    expect(r.rows.map((x) => x.type)).toEqual(["INCOME", "EXPENSE"]);
  });

  it("a comma-decimal file parses its lone-dot thousands correctly", () => {
    const r = parseCsv("Datum;Beschreibung;Betrag\n27.07.2026;Miete;-3.000\n28.07.2026;Kaffee;-2,50\n");
    expect(r.rows.map((x) => x.amount)).toEqual([3000, 2.5]);
  });

  it("a header that merely contains the word 'in' is not the credit column", () => {
    const r = parseCsv("Date,Description,Logged in,Amount\n2026-08-01,X,yes,-5.00\n2026-08-02,Y,no,7.00\n");
    expect(r.mapping.credit).toBeUndefined();
    expect(r.rows).toHaveLength(2);
  });
});
