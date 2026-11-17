import { describe, expect, it } from "vitest";
import { buildReceiptRows, receiptTotals, type ReceiptTxn } from "@/lib/receipts";

// Missing-receipt list: every business-account cost, covered by a reference or a stored file.

const txn = (over: Partial<ReceiptTxn> = {}): ReceiptTxn => ({
  id: "t1",
  date: "2026-09-10",
  merchant: "Example Airlines",
  amountEur: 214.5,
  amount: 214.5,
  currency: "EUR",
  account: "Business current",
  accountId: "acc-biz",
  category: "Travel",
  receiptRef: null,
  ...over,
});

describe("buildReceiptRows — receipt coverage", () => {
  it("a receipt reference on the bank row covers it", () => {
    const rows = buildReceiptRows([txn({ receiptRef: "INV-0042" })]);
    expect(rows[0]).toMatchObject({ id: "t1", label: "Example Airlines", where: "Business current", reason: "Business account", receipt: "INV-0042" });
  });

  it("treats a whitespace-only reference as missing", () => {
    expect(buildReceiptRows([txn({ receiptRef: "   " })])[0].receipt).toBeNull();
    expect(buildReceiptRows([txn({ receiptRef: "   " })])[0].receiptRef).toBeNull();
  });

  it("keeps the native amount and currency next to the EUR figure", () => {
    const rows = buildReceiptRows([txn({ amount: 236.2, currency: "USD" })]);
    expect(rows[0]).toMatchObject({ amount: 236.2, currency: "USD", amountEur: 214.5 });
  });
});

describe("buildReceiptRows — labelling and order", () => {
  it("falls back to a dash for a missing account", () => {
    const rows = buildReceiptRows([txn({ account: null })]);
    expect(rows[0].where).toBe("—");
  });

  it("sorts newest first", () => {
    const rows = buildReceiptRows([
      txn({ id: "a", date: "2026-08-01" }),
      txn({ id: "b", date: "2026-10-01" }),
      txn({ id: "c", date: "2026-09-01" }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(["b", "c", "a"]);
  });

  it("is empty for empty input", () => {
    expect(buildReceiptRows([])).toEqual([]);
  });
});

describe("receiptTotals", () => {
  it("counts and sums the uncovered rows and counts the covered ones", () => {
    const rows = buildReceiptRows([
      txn({ id: "a", amountEur: 100, receiptRef: "ok" }),
      txn({ id: "b", date: "2026-09-01", amountEur: 50.25 }),
      txn({ id: "c", date: "2026-08-01", amountEur: 10.5 }),
    ]);
    expect(receiptTotals(rows)).toEqual({ missing: 2, missingEur: 60.75, covered: 1 });
    expect(receiptTotals([])).toEqual({ missing: 0, missingEur: 0, covered: 0 });
  });
});

describe("buildReceiptRows — attachments", () => {
  it("a stored file covers a bank row that has no reference", () => {
    const rows = buildReceiptRows([txn({ attachments: 2 })]);
    expect(rows[0]).toMatchObject({ receipt: "2 attachments", attachments: 2, receiptRef: null });
    expect(receiptTotals(rows).missing).toBe(0);
  });
  it("no attachments and no reference stays missing", () => {
    const rows = buildReceiptRows([txn({ attachments: 0 })]);
    expect(rows[0].receipt).toBeNull();
  });
});
