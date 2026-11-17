"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Paperclip, Pencil, X } from "lucide-react";
import { formatAmount, formatDate, formatMoney, cn } from "@/lib/utils";
import { receiptTotals, type ReceiptRow } from "@/lib/receipts";

export function ReceiptsClient({ rows, year, thisYear }: { rows: ReceiptRow[]; year: number; thisYear: number }) {
  const router = useRouter();
  const [onlyMissing, setOnlyMissing] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const totals = useMemo(() => receiptTotals(rows), [rows]);
  const shown = onlyMissing ? rows.filter((r) => !r.receipt) : rows;

  function start(r: ReceiptRow) {
    setEditing(r.id);
    setValue(r.receiptRef ?? "");
    setError("");
  }

  async function save(r: ReceiptRow) {
    setBusy(true);
    setError("");
    try {
      const body = { receiptRef: value.trim() || null };
      const res = await fetch(`/api/transactions/${r.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Save failed");
        return;
      }
      setEditing(null);
      router.refresh();
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  }

  const years = [thisYear - 1, thisYear];
  return (
    <div>
      <div className="glass-card p-4 mb-4 flex flex-wrap items-center gap-x-8 gap-y-2 text-sm">
        <div>
          <span className="text-ink-soft">Missing</span>{" "}
          <span className={cn("font-semibold", totals.missing ? "text-clay-deep" : "text-olive")} data-testid="receipts-missing">
            {totals.missing}
          </span>{" "}
          <span className="text-ink-muted tabular-nums">≈{formatMoney(totals.missingEur)}</span>
        </div>
        <div>
          <span className="text-ink-soft">Covered</span> <span className="font-semibold">{totals.covered}</span>
        </div>
        <label className="flex items-center gap-2 text-ink-soft">
          <input type="checkbox" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} />
          Missing only
        </label>
        <div className="ml-auto flex gap-2">
          {years.map((y) => (
            <Link
              key={y}
              href={`/receipts?year=${y}`}
              className={cn(
                "px-3 py-1 rounded-lg text-xs font-medium",
                y === year ? "bg-clay/10 text-clay-deep" : "text-ink-soft hover:bg-ink/[0.04]",
              )}
            >
              {y}
            </Link>
          ))}
        </div>
      </div>
      {error && <p className="text-sm text-clay-deep bg-clay/10 rounded-lg p-3 mb-3">{error}</p>}

      <div className="glass-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-ink-muted text-xs border-b border-line">
              <th className="p-3 font-medium">Date</th>
              <th className="p-3 font-medium">Cost</th>
              <th className="p-3 font-medium">Where</th>
              <th className="p-3 font-medium text-right">Amount</th>
              <th className="p-3 font-medium">Receipt</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={5} className="p-6 text-center text-ink-muted">
                  {onlyMissing ? "Every cost in this year has a receipt on file." : "No business costs in this year."}
                </td>
              </tr>
            )}
            {shown.map((r) => {
              const key = r.id;
              const isEditing = editing === key;
              return (
                <tr key={key} className="border-b border-line last:border-0" data-testid="receipt-row">
                  <td className="p-3 whitespace-nowrap">{r.date ? formatDate(r.date) : "—"}</td>
                  <td className="p-3">
                    <div className="font-medium">{r.label}</div>
                    <div className="text-xs text-ink-muted">{r.reason}</div>
                  </td>
                  <td className="p-3 text-ink-soft">{r.where}</td>
                  <td className="p-3 text-right tabular-nums whitespace-nowrap">
                    {formatAmount(r.amount, r.currency)}
                    {r.currency !== "EUR" && <div className="text-xs text-ink-muted">≈{formatMoney(r.amountEur)}</div>}
                  </td>
                  <td className="p-3 min-w-[16rem]">
                    {isEditing ? (
                      <div className="flex items-center gap-1">
                        <input
                          autoFocus
                          value={value}
                          onChange={(e) => setValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") save(r);
                            if (e.key === "Escape") setEditing(null);
                          }}
                          placeholder="file path, link or reference"
                          className="input-field text-xs py-1"
                          aria-label={`Receipt for ${r.label}`}
                        />
                        <button
                          disabled={busy}
                          onClick={() => save(r)}
                          className="p-1.5 rounded-md text-olive hover:bg-ink/[0.04]"
                          aria-label="Save"
                        >
                          <Check size={15} />
                        </button>
                        <button
                          onClick={() => setEditing(null)}
                          className="p-1.5 rounded-md text-ink-muted hover:bg-ink/[0.04]"
                          aria-label="Cancel"
                        >
                          <X size={15} />
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        {r.receipt ? (
                          <span className="text-xs text-olive break-all flex items-center gap-1">
                            {r.attachments > 0 && !r.receiptRef && <Paperclip size={12} />}
                            {r.receipt}
                          </span>
                        ) : (
                          <span className="text-xs font-semibold text-clay-deep">missing</span>
                        )}
                        <button
                          onClick={() => start(r)}
                          className="p-1 rounded-md text-ink-muted hover:text-ink hover:bg-ink/[0.04]"
                          aria-label={`Edit receipt for ${r.label}`}
                        >
                          <Pencil size={13} />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-ink-muted mt-4">
        Attach the file itself from the transaction&apos;s edit dialog on{" "}
        <Link href="/transactions" className="text-accent-green hover:underline">
          Transactions
        </Link>
        ; a stored file counts as the receipt.
      </p>
    </div>
  );
}
