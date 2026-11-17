"use client";

import { useRef, useState } from "react";
import { UploadCloud, FileText } from "lucide-react";
import { formatAmount, formatDate, cn } from "@/lib/utils";
import { SUPPORTED_CURRENCIES, hasRate } from "@/lib/currency";
import { Modal } from "./Modal";
import type { CatLite, AccountLite } from "./TransactionsClient";

interface PreviewRow {
  date: string;
  merchant: string;
  amount: number;
  currency: string | null;
  type: "EXPENSE" | "INCOME";
  rawCategory: string | null;
  note: string | null;
  suggestedCategoryId: string | null;
}

interface ReviewRow extends PreviewRow {
  include: boolean;
  categoryId: string;
  resolvedCurrency: string;
  detectedCurrency: boolean;
  // The file named a currency that has no EUR rate. The row blocks the import
  // until a rated currency is picked by hand — silently relabelling it EUR would
  // turn 5,000 JPY into EUR 5,000 and lose the evidence.
  unratedCurrency: string | null;
  // The USER picked this category in review. Only those teach a merchant rule;
  // a keyword-map guess must never be frozen in as one.
  userCategorised: boolean;
}

interface HeldMirror {
  index: number;
}

/** Any code with a rate in src/lib/currency.ts — a statement can carry a PLN pocket. */
function validCcy(x: string | null | undefined): string | null {
  if (!x) return null;
  const u = x.trim().toUpperCase();
  return hasRate(u) ? u : null;
}

/**
 * Where the rows came from, which decides how much the review step trusts them:
 * a statement reconciles against its own printed totals, a receipt is one
 * model-read draft with nothing to check it against.
 */
type Mode = "csv" | "statement" | "receipt";

interface Validation {
  checked: boolean;
  ok: boolean | null;
  out?: number;
  in?: number;
  detail?: string;
}

const IMAGE_RE = /\.(jpe?g|png|webp|heic|heif|gif|bmp|tiff?)$/i;
const STATEMENT_RE = /\.(pdf|zip|csv|md)$/i;

function isImageFile(f: File): boolean {
  return f.type.startsWith("image/") || IMAGE_RE.test(f.name);
}

function isStatementFile(f: File): boolean {
  return f.type === "application/pdf" || STATEMENT_RE.test(f.name);
}

export function CsvImportDialog({
  categories,
  accounts,
  onClose,
  onImported,
}: {
  categories: CatLite[];
  accounts: AccountLite[];
  onClose: () => void;
  onImported: () => void;
}) {
  const [step, setStep] = useState<"upload" | "review">("upload");
  const [mode, setMode] = useState<Mode>("csv");
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [skipped, setSkipped] = useState(0);
  const [fileName, setFileName] = useState("");
  const [fileCurrency, setFileCurrency] = useState("EUR");
  const [accountId, setAccountId] = useState("");
  const [detectedLabel, setDetectedLabel] = useState("");
  const [validation, setValidation] = useState<Validation | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState("");
  const [held, setHeld] = useState<{ rows: ReviewRow[]; imported: number } | null>(null);
  // F9: a receipt's own file can be stored on the row it creates.
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [attachReceipt, setAttachReceipt] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);

  function toReview(preview: PreviewRow[]) {
    setRows(
      preview.map((r) => {
        const detected = validCcy(r.currency);
        const named = r.currency?.trim().toUpperCase() || null;
        return {
          ...r,
          include: true,
          categoryId: r.suggestedCategoryId ?? "",
          resolvedCurrency: detected ?? fileCurrency,
          detectedCurrency: detected != null,
          unratedCurrency: named && !detected ? named : null,
          userCategorised: false,
        };
      }),
    );
    setStep("review");
  }

  /**
   * A bank statement (PDF or the bank's own CSV export). Goes through the Python
   * parsers, including the reconciliation against the statement's own printed
   * totals.
   *
   * Returns "fallback" only when the parser says the file is not a bank export
   * it knows — an actual parse FAILURE is reported as an error and never
   * silently retried as a generic CSV, because a statement that reads as empty
   * is a parser failure, not an empty month.
   */
  async function handleStatement(
    file: File,
  ): Promise<"handled" | "fallback" | "receipt"> {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/transactions/import/statement", {
      method: "POST",
      body: fd,
    });
    const data = await res.json();
    if (!res.ok) {
      setError([data.error, data.hint].filter(Boolean).join(" "));
      return "handled";
    }
    // A one-page invoice rather than a bank export — read it as a receipt.
    if (data.fallback === "receipt") return "receipt";
    if (data.fallback === "generic-csv") return "fallback";

    setMode("statement");
    setDetectedLabel(data.label ?? "");
    setValidation(data.validation ?? null);
    setWarnings(data.warnings ?? []);
    if (data.account && accounts.some((a) => a.id === data.account)) {
      setAccountId(data.account);
    }
    setSkipped(0);
    toReview(data.rows as PreviewRow[]);
    return "handled";
  }

  /** A photographed or scanned receipt, read by the local vision model. */
  async function handleReceipt(file: File) {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/transactions/import/receipt", {
      method: "POST",
      body: fd,
    });
    const data = await res.json();
    if (!res.ok) {
      setError([data.error, data.hint].filter(Boolean).join(" "));
      return;
    }
    const d = data.draft;
    // Deliberately NOT gated on data.confidence. Benchmarked over 20
    // synthetic receipts: the model reported 1.0 on every answer including the
    // wrong ones, and after a prompt change reported 0.6 on every answer including
    // the right ones. It never once separated a correct read from an incorrect
    // one, so a confidence threshold is noise dressed as a safety check. The
    // amount is always shown editable next to a standing instruction to check it.
    const notes: string[] = [];
    const cc = data.crossCheck ?? {};
    if (cc.agrees === true) {
      notes.push(
        `Two independent reads agree on ${d.amount}${cc.label ? ` (matched "${cc.label}")` : ""}.`,
      );
    } else if (cc.agrees === false) {
      notes.push(
        `⚠ The two reads disagreed — corrected from ${cc.correctedFrom} to ${d.amount}` +
          `${cc.label ? ` using the line labelled "${cc.label}"` : ""}. Check this one against the receipt.`,
      );
    } else {
      notes.push(
        "No labelled total could be cross-checked on this receipt, so the amount " +
          "rests on a single read — check it against the paper.",
      );
    }
    if (!d.date) {
      notes.push("No date found on the receipt — defaulted to today, check it.");
    }
    setMode("receipt");
    setReceiptFile(file);
    setDetectedLabel(`Receipt read by ${data.model ?? "the local vision model"}`);
    setValidation(null);
    setWarnings(notes);
    setSkipped(0);
    toReview([
      {
        date: d.date ?? new Date().toISOString().slice(0, 10),
        merchant: d.merchant,
        amount: d.amount,
        currency: d.currency,
        type: d.type,
        rawCategory: null,
        note: d.note,
        suggestedCategoryId: d.suggestedCategoryId,
      },
    ]);
  }

  /** Any other CSV — the app's own column-mapping parser. */
  async function handleGenericCsv(file: File) {
    const csv = await file.text();
    const res = await fetch("/api/transactions/import/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csv }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || "Could not parse the file");
      return;
    }
    setMode("csv");
    setDetectedLabel("");
    setValidation(null);
    setWarnings(
      data.signAssumed
        ? [
            "This file has no negative amounts, so every row was read as an EXPENSE (card exports print charges as positive). If it is a file of income, flip the rows before importing.",
          ]
        : [],
    );
    setSkipped(data.skipped ?? 0);
    toReview(data.rows as PreviewRow[]);
  }

  async function handleFile(file: File) {
    setError("");
    setBusy(true);
    setFileName(file.name);
    setDetectedLabel("");
    setValidation(null);
    setWarnings([]);
    try {
      if (isImageFile(file)) {
        setBusyLabel("Reading the receipt…");
        await handleReceipt(file);
        return;
      }
      if (isStatementFile(file)) {
        setBusyLabel("Parsing the statement…");
        const outcome = await handleStatement(file);
        if (outcome === "handled") return;
        if (outcome === "receipt") {
          setBusyLabel("Not a bank statement — reading it as a receipt…");
          await handleReceipt(file);
          return;
        }
      }
      setBusyLabel("Reading…");
      await handleGenericCsv(file);
    } catch {
      setError("Could not read the file");
    } finally {
      setBusy(false);
      setBusyLabel("");
    }
  }

  function setRow(i: number, patch: Partial<ReviewRow>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  function setAllInclude(v: boolean) {
    setRows((prev) => prev.map((r) => ({ ...r, include: v })));
  }

  // Apply a file-level currency to every row that didn't carry its own.
  function applyFileCurrency(ccy: string) {
    setFileCurrency(ccy);
    setRows((prev) =>
      prev.map((r) =>
        r.detectedCurrency || r.unratedCurrency ? r : { ...r, resolvedCurrency: ccy },
      ),
    );
  }

  async function commit() {
    const chosen = rows.filter((r) => r.include);
    if (chosen.length === 0) {
      setError("Select at least one row to import");
      return;
    }
    const unrated = chosen.filter((r) => r.unratedCurrency);
    if (unrated.length > 0) {
      const codes = [...new Set(unrated.map((r) => r.unratedCurrency))].join(", ");
      setError(
        `${unrated.length} row(s) are in ${codes}, which has no EUR rate — they would count 1:1 as euros. ` +
          "Pick the real currency on each row, untick them, or add the rate to src/lib/currency.ts.",
      );
      return;
    }
    await post(chosen, false);
  }

  async function post(chosen: ReviewRow[], allowMirrors: boolean) {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/transactions/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: accountId || null,
          allowMirrors,
          rows: chosen.map((r) => ({
            date: r.date,
            merchant: r.merchant,
            amount: r.amount,
            currency: r.resolvedCurrency,
            type: r.type,
            categoryId: r.categoryId || null,
            userCategorised: r.userCategorised,
            note: r.note,
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Import failed");
        return;
      }
      const mirrors: HeldMirror[] = data.mirrorsInserted ? [] : (data.suspectedMirrors ?? []);
      if (mirrors.length > 0) {
        // Keep the dialog open: these rows were NOT written and need a decision.
        setHeld({ rows: mirrors.map((m) => chosen[m.index]), imported: data.imported ?? 0 });
        return;
      }
      const ids: string[] = data.ids ?? [];
      if (mode === "receipt" && attachReceipt && receiptFile && ids.length === 1) {
        const fd = new FormData();
        fd.append("file", receiptFile, receiptFile.name);
        const up = await fetch(`/api/transactions/${ids[0]}/attachments`, { method: "POST", body: fd });
        if (!up.ok) {
          const e = await up.json().catch(() => ({}));
          // The row IS saved; only the file failed. Say so instead of closing silently.
          setError(`Saved the transaction, but the file was not attached: ${e.error || up.status}`);
          setStep("upload");
          setRows([]);
          return;
        }
      }
      onImported();
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  }

  const includedCount = rows.filter((r) => r.include).length;
  const anyUndetected = rows.some((r) => !r.detectedCurrency);

  return (
    <Modal
      title={
        mode === "receipt" ? "Receipt — check and save" : "Import transactions"
      }
      onClose={onClose}
      wide={step === "review"}
    >
      {error && (
        <p className="text-sm text-clay-deep bg-clay/10 rounded-lg p-3 mb-4">
          {error}
        </p>
      )}

      {held && (
        <div className="text-sm bg-clay/10 rounded-lg p-3 mb-4">
          <p className="text-clay-deep font-medium">
            {held.imported} imported. {held.rows.length} row(s) held back — the account already holds
            the same date and amount with the OPPOSITE sign.
          </p>
          <p className="text-ink-soft mt-1">
            Usually a sign fix: if the statement prints only this row, the existing one is the phantom —
            correct its type instead of adding a second row. Import them only for a genuine same-day pair.
          </p>
          <ul className="mt-2 text-xs text-ink-soft space-y-0.5">
            {held.rows.map((r, i) => (
              <li key={i}>
                {formatDate(r.date)} · {r.type === "INCOME" ? "+" : "−"}
                {formatAmount(r.amount, r.resolvedCurrency)} · {r.merchant}
              </li>
            ))}
          </ul>
          <div className="flex gap-2 pt-3">
            <button onClick={onImported} className="btn-secondary flex-1" disabled={busy}>
              Leave them out
            </button>
            <button
              onClick={() => {
                const again = held.rows;
                setHeld(null);
                void post(again, true);
              }}
              className="btn-primary flex-1"
              disabled={busy}
            >
              Import them anyway
            </button>
          </div>
        </div>
      )}

      {step === "upload" && (
        <div>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.pdf,.zip,.md,.jpg,.jpeg,.png,.webp,.heic,text/csv,text/plain,application/pdf,image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
            }}
          />
          <div className="mb-4">
            <label className="block text-sm text-ink-soft mb-1">
              Import into account
            </label>
            <select
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              className="input-field"
            >
              <option value="">No account</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          <button
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            className="w-full border-2 border-dashed border-line rounded-xl py-12 flex flex-col items-center gap-3 text-ink-soft hover:border-accent-green/40 hover:text-ink transition-colors"
          >
            <UploadCloud size={36} className="text-accent-green" />
            <span className="font-medium">
              {busy ? busyLabel || "Reading…" : "Choose a file"}
            </span>
            <span className="text-xs text-ink-muted">
              Statement PDF · bank CSV export · receipt photo
            </span>
          </button>
          <div className="text-xs text-ink-muted mt-4 space-y-1.5">
            <p>
              <span className="text-ink-soft">Statements</span> — Revolut, Wise,
              American Express and Trading 212 are recognised from the
              file itself, so the bank and the categories fill in
              on their own. Each file is checked against the totals the
              statement prints; you see the verdict before anything is written.
            </p>
            <p>
              <span className="text-ink-soft">Receipts</span> — a photo or scan
              is read by the local vision model on this machine. It comes back
              as a draft for you to confirm.
            </p>
            <p>
              Anything else is treated as a plain CSV: columns, currency,
              1,234.56 vs 1.234,56 and day-first dates are auto-detected.
              Imported rows land as “to review”.
            </p>
          </div>
        </div>
      )}

      {step === "review" && (
        <div>
          {detectedLabel && (
            <div className="mb-3 rounded-lg border border-line bg-sand/60 px-3 py-2">
              <p className="text-sm text-ink-soft">
                Detected: <span className="text-ink">{detectedLabel}</span>
              </p>
              {/* The reconciliation verdict. A statement whose rows don't add up
                  to its own printed totals is the one thing that must never be
                  imported quietly. */}
              {validation?.detail && (
                <p
                  className={cn(
                    "text-xs mt-1 tabular-nums",
                    validation.checked && validation.ok === false
                      ? "text-clay-deep font-medium"
                      : validation.checked && validation.ok
                        ? "text-accent-green"
                        : "text-ink-muted",
                  )}
                >
                  {validation.checked && validation.ok === false
                    ? "⚠ Does not reconcile — "
                    : validation.checked && validation.ok
                      ? "✓ Reconciles with the statement — "
                      : ""}
                  {validation.detail}
                </p>
              )}
              {warnings.map((w, i) => (
                <p key={i} className="text-xs text-ink-muted mt-1">
                  {w}
                </p>
              ))}
            </div>
          )}
          <div className="flex items-center justify-between mb-3 text-sm flex-wrap gap-2">
            <span className="flex items-center gap-2 text-ink-soft">
              <FileText size={16} /> {fileName} ·{" "}
              <span className="text-ink">{includedCount}</span> of{" "}
              {rows.length} selected
              {skipped > 0 && (
                <span className="text-ink-muted">· {skipped} skipped</span>
              )}
            </span>
            <div className="flex items-center gap-3">
              {anyUndetected && (
                <label className="flex items-center gap-1.5 text-xs text-ink-soft">
                  Default currency
                  <select
                    value={fileCurrency}
                    onChange={(e) => applyFileCurrency(e.target.value)}
                    className="bg-transparent border border-line rounded-md px-1.5 py-0.5 text-xs focus:outline-none focus:border-accent-green"
                  >
                    {SUPPORTED_CURRENCIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <button
                onClick={() => setAllInclude(true)}
                className="text-xs text-accent-green"
              >
                All
              </button>
              <button
                onClick={() => setAllInclude(false)}
                className="text-xs text-ink-muted"
              >
                None
              </button>
            </div>
          </div>

          <div className="max-h-[50vh] overflow-y-auto rounded-lg border border-line">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-sand">
                <tr className="text-left text-ink-muted border-b border-line">
                  <th className="px-3 py-2 w-8"></th>
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium">Merchant</th>
                  <th className="px-3 py-2 font-medium">Category</th>
                  <th className="px-3 py-2 font-medium">Ccy</th>
                  <th className="px-3 py-2 font-medium text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr
                    key={i}
                    className={cn(
                      "border-b border-line",
                      !r.include && "opacity-40",
                    )}
                  >
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={r.include}
                        onChange={(e) =>
                          setRow(i, { include: e.target.checked })
                        }
                        className="accent-[#10b981]"
                      />
                    </td>
                    {/* A statement's rows are reconciled — editing them would
                        break the arithmetic that was just verified. A receipt
                        has no such check, so its one row stays editable. */}
                    <td className="px-3 py-2 whitespace-nowrap text-ink-soft">
                      {mode === "receipt" ? (
                        <input
                          type="date"
                          value={r.date}
                          onChange={(e) => setRow(i, { date: e.target.value })}
                          className="bg-transparent border border-line rounded-md px-1.5 py-1 text-xs focus:outline-none focus:border-accent-green"
                        />
                      ) : (
                        formatDate(r.date)
                      )}
                    </td>
                    <td className="px-3 py-2 truncate max-w-[200px]">
                      {mode === "receipt" ? (
                        <input
                          type="text"
                          value={r.merchant}
                          onChange={(e) =>
                            setRow(i, { merchant: e.target.value })
                          }
                          className="w-full bg-transparent border border-line rounded-md px-2 py-1 text-xs focus:outline-none focus:border-accent-green"
                        />
                      ) : (
                        r.merchant
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <select
                        value={r.categoryId}
                        onChange={(e) =>
                          setRow(i, { categoryId: e.target.value, userCategorised: true })
                        }
                        className="bg-transparent border border-line rounded-md px-2 py-1 text-xs text-ink-soft max-w-[150px] focus:outline-none focus:border-accent-green"
                      >
                        <option value="">Uncategorised</option>
                        {categories.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-2">
                      <select
                        value={r.resolvedCurrency}
                        onChange={(e) =>
                          setRow(i, {
                            resolvedCurrency: e.target.value,
                            detectedCurrency: true,
                            unratedCurrency: null,
                          })
                        }
                        title={
                          r.unratedCurrency
                            ? `File says ${r.unratedCurrency} — no EUR rate. Pick the real currency.`
                            : undefined
                        }
                        className={cn(
                          "bg-transparent border rounded-md px-1.5 py-1 text-xs focus:outline-none focus:border-accent-green",
                          r.unratedCurrency ? "border-clay text-clay-deep" : "border-line text-ink-soft",
                        )}
                      >
                        {r.unratedCurrency && (
                          <option value={r.resolvedCurrency}>{r.unratedCurrency} — no rate</option>
                        )}
                        {/* a rated code missing from the picker list keeps its own option */}
                        {[
                          ...SUPPORTED_CURRENCIES,
                          ...(!(SUPPORTED_CURRENCIES as readonly string[]).includes(r.resolvedCurrency)
                            ? [r.resolvedCurrency]
                            : []),
                        ].map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td
                      className={cn(
                        "px-3 py-2 text-right tabular-nums whitespace-nowrap",
                        r.type === "INCOME"
                          ? "text-accent-green"
                          : "text-ink",
                      )}
                    >
                      {mode === "receipt" ? (
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={r.amount}
                          onChange={(e) =>
                            setRow(i, {
                              amount: Math.abs(Number(e.target.value)) || 0,
                            })
                          }
                          className="w-28 bg-transparent border border-line rounded-md px-2 py-1 text-xs text-right tabular-nums focus:outline-none focus:border-accent-green"
                        />
                      ) : (
                        <>
                          {r.type === "INCOME" ? "+" : "−"}
                          {formatAmount(r.amount, r.resolvedCurrency)}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {mode === "receipt" && receiptFile && (
            <label className="flex items-center gap-2 text-sm text-ink-soft pt-4" data-testid="attach-receipt">
              <input type="checkbox" checked={attachReceipt} onChange={(e) => setAttachReceipt(e.target.checked)} />
              Attach the file ({receiptFile.name}) to the transaction — it then counts as its receipt
            </label>
          )}
          <div className="flex gap-2 pt-4">
            <button
              onClick={() => {
                setStep("upload");
                setRows([]);
                setError("");
              }}
              className="btn-secondary flex-1"
            >
              Back
            </button>
            <button
              onClick={commit}
              className="btn-primary flex-1"
              disabled={busy || includedCount === 0}
            >
              {busy ? "Importing…" : `Import ${includedCount}`}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
