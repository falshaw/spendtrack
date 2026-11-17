/**
 * Missing-receipt list — pure, so it is testable.
 *
 * Business-scope costs need a receipt on file for the books: every EXPENSE row on a
 * BUSINESS account, excluding own-account Transfers and other excluded categories
 * (moving your own money needs no receipt). A row counts as covered when it carries
 * a receipt reference (file path, link or ref) or at least one stored attachment.
 */

export interface ReceiptTxn {
  id: string;
  date: string; // YYYY-MM-DD
  merchant: string;
  amountEur: number;
  amount: number;
  currency: string;
  account: string | null;
  accountId: string | null;
  category: string | null;
  receiptRef: string | null;
  /** Files stored on the row (`transaction_attachments`). One counts as a receipt. */
  attachments?: number;
}

export interface ReceiptRow {
  id: string;
  date: string | null;
  label: string;
  amountEur: number;
  amount: number;
  currency: string;
  where: string; // account name
  reason: string;
  receipt: string | null; // the reference that covers it
  /** The bank row's own receiptRef (editable inline on /receipts). */
  receiptRef: string | null;
  /** Stored attachment files on the row. */
  attachments: number;
}

const blank = (s: string | null | undefined) => !s || !s.trim();

export function buildReceiptRows(txns: ReceiptTxn[]): ReceiptRow[] {
  const rows: ReceiptRow[] = txns.map((t) => {
    const files = t.attachments ?? 0;
    const receipt = !blank(t.receiptRef)
      ? t.receiptRef
      : files > 0
        ? `${files} attachment${files === 1 ? "" : "s"}`
        : null;
    return {
      id: t.id,
      date: t.date,
      label: t.merchant,
      amountEur: t.amountEur,
      amount: t.amount,
      currency: t.currency,
      where: t.account ?? "—",
      reason: "Business account",
      receipt,
      receiptRef: blank(t.receiptRef) ? null : t.receiptRef,
      attachments: files,
    };
  });
  return rows.sort((a, b) => ((a.date ?? "") < (b.date ?? "") ? 1 : (a.date ?? "") > (b.date ?? "") ? -1 : 0));
}

export function receiptTotals(rows: ReceiptRow[]): { missing: number; missingEur: number; covered: number } {
  const missing = rows.filter((r) => !r.receipt);
  return {
    missing: missing.length,
    missingEur: missing.reduce((s, r) => s + r.amountEur, 0),
    covered: rows.length - missing.length,
  };
}
