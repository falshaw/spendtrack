import { describe, expect, it } from "vitest";
import {
  RATES_TO_EUR,
  SUPPORTED_CURRENCIES,
  UnknownCurrencyError,
  hasRate,
  normalizeCurrency,
  toEur,
} from "@/lib/currency";

describe("toEur", () => {
  it("passes EUR through unchanged", () => {
    expect(toEur(123.45, "EUR")).toBe(123.45);
  });

  it("converts GBP/USD at the static reference rates", () => {
    expect(toEur(85.83, "GBP")).toBeCloseTo(100, 6);
    expect(toEur(114.81, "USD")).toBeCloseTo(100, 6);
  });

  it("converts each amount exactly once", () => {
    // A GBP row and a JPY row in one sum: 100 GBP + 5,000 JPY is ~146 EUR, not 5,100.
    const total = toEur(100, "GBP") + toEur(5000, "JPY");
    expect(total).toBeCloseTo(100 / 0.8583 + 5000 / 170, 6);
    expect(total).toBeLessThan(250);
  });

  // An unknown code must never count 1:1 — 5,000 of anything would read
  // as €5,000 in every total. It fails loudly instead.
  it("throws on a currency with no rate instead of counting it 1:1", () => {
    expect(() => toEur(50, "XYZ")).toThrow(UnknownCurrencyError);
    expect(() => toEur(50, "XYZ")).toThrow(/XYZ/);
    expect(() => toEur(50, "")).toThrow(UnknownCurrencyError);
    // Codes are exact: a lower-case or prototype key is not a rate.
    expect(() => toEur(50, "gbp")).toThrow(UnknownCurrencyError);
    expect(() => toEur(50, "constructor")).toThrow(UnknownCurrencyError);
  });
});

describe("rate table", () => {
  it("has a positive, finite rate for every code", () => {
    for (const [code, rate] of Object.entries(RATES_TO_EUR)) {
      expect(code).toMatch(/^[A-Z]{3}$/);
      expect(Number.isFinite(rate) && rate > 0).toBe(true);
    }
  });

  it("covers every picker currency and every code the parsers can emit", () => {
    for (const c of SUPPORTED_CURRENCIES) expect(hasRate(c)).toBe(true);
    // every ISO code the parser sidecar can emit (CURRENCY_CODES in l10n_keywords.py)
    for (const c of ["AUD", "CAD", "CZK", "DKK", "HUF", "JPY", "NOK", "PLN", "SEK"]) {
      expect(hasRate(c)).toBe(true);
    }
  });

  it("hasRate rejects missing and unknown codes", () => {
    expect(hasRate("XYZ")).toBe(false);
    expect(hasRate(null)).toBe(false);
    expect(hasRate(undefined)).toBe(false);
    expect(hasRate("toString")).toBe(false);
  });
});

describe("normalizeCurrency", () => {
  it("uppercases and trims known codes", () => {
    expect(normalizeCurrency(" gbp ")).toBe("GBP");
    expect(normalizeCurrency("sek")).toBe("SEK");
  });

  it("defaults a MISSING code to EUR", () => {
    expect(normalizeCurrency(null)).toBe("EUR");
    expect(normalizeCurrency(undefined)).toBe("EUR");
    expect(normalizeCurrency("  ")).toBe("EUR");
  });

  it("keeps an UNKNOWN code visible instead of relabelling it EUR", () => {
    expect(normalizeCurrency("xyz")).toBe("XYZ");
    expect(hasRate(normalizeCurrency("xyz"))).toBe(false);
  });
});

describe("picker list", () => {
  it("is every rated code, in alphabetical order", () => {
    expect([...SUPPORTED_CURRENCIES]).toEqual(Object.keys(RATES_TO_EUR).sort());
    expect([...SUPPORTED_CURRENCIES]).toEqual([...SUPPORTED_CURRENCIES].sort());
  });
});
