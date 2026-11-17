import { describe, expect, it } from "vitest";
import { MONTH_NAMES, monthIndex } from "@/lib/l10n-keywords";
import { parseCsv, parseDateFlexible } from "@/lib/csv";
import { partsFromReceiptLines } from "@/lib/splits";

describe("l10n keyword tables", () => {
  it("every month name in every table language maps to its month, abbreviated or not", () => {
    for (const names of Object.values(MONTH_NAMES)) {
      names.forEach((name, i) => {
        expect(monthIndex(name), name).toBe(i + 1);
        expect(monthIndex(name[0].toUpperCase() + name.slice(1)), name).toBe(i + 1);
      });
    }
    expect(monthIndex("Sept")).toBe(9);
    expect(monthIndex("dec.")).toBe(12);
    expect(monthIndex("xyz")).toBeNull();
  });

  it("text dates read the same in every language", () => {
    expect(parseDateFlexible("5 March 2026")).toBe("2026-03-05");
    expect(parseDateFlexible("5 mars 2026")).toBe("2026-03-05");
    expect(parseDateFlexible("5 marzo 2026")).toBe("2026-03-05");
    expect(parseDateFlexible("Mar 5, 2026")).toBe("2026-03-05");
  });

  it("a CSV export with localised headers maps the same columns", () => {
    const text = ["Date;Libellé;Montant;Devise", "01/06/2026;EXAMPLE STORE;-12,50;EUR"].join("\n");
    const r = parseCsv(text);
    expect(r.rows[0]).toMatchObject({ date: "2026-06-01", merchant: "EXAMPLE STORE", amount: 12.5, currency: "EUR", type: "EXPENSE" });
  });

  it("receipt totals and tax lines are not items, in any table language", () => {
    const parts = partsFromReceiptLines(
      [
        { label: "Coffee", amount: 3 },
        { label: "Total", amount: 3 },
        { label: "TVA", amount: 0.5 },
        { label: "Totale", amount: 3 },
        { label: "Propina", amount: 1 },
      ],
      3,
    );
    expect(parts.map((p) => p.note)).toEqual(["Coffee"]);
  });
});
