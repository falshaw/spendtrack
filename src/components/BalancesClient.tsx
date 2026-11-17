"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Pencil, Trash2, FileText, Hand, Lock } from "lucide-react";
import { formatMoney, formatAmount, formatDate, cn } from "@/lib/utils";
import { SUPPORTED_CURRENCIES } from "@/lib/currency";
import { ageDays, balanceState, STALE_DAYS, type BalanceState } from "@/lib/balances";
import type { BalanceRow } from "@/lib/money-data";
import { Modal } from "./Modal";

const STATE_STYLE: Record<BalanceState, string> = {
  fresh: "bg-olive/15 text-olive",
  stale: "bg-gold/20 text-clay-deep",
  missing: "bg-clay/15 text-clay-deep",
};

export function BalancesClient({ rows, today }: { rows: BalanceRow[]; today: string }) {
  const router = useRouter();
  const [editing, setEditing] = useState<BalanceRow | null>(null);
  const [form, setForm] = useState({ balance: "", currency: "EUR", asOf: today, held: false, earmark: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const states = rows.map((r) => balanceState(r.asOf, today));
  const missing = rows.filter((_, i) => states[i] === "missing");
  const stale = rows.filter((_, i) => states[i] === "stale");
  const knownEur = rows.reduce((s, r) => s + (r.eur ?? 0), 0);

  function openEdit(r: BalanceRow) {
    setEditing(r);
    setForm({
      balance: r.balance != null ? r.balance.toFixed(2) : "",
      currency: r.currency ?? r.accountCurrency,
      asOf: r.asOf ?? today,
      held: r.earmark != null,
      earmark: r.earmark ?? "",
    });
    setError("");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    const balance = Number(form.balance.replace(",", "."));
    const balanceTyped = form.balance.trim() !== "";
    if (balanceTyped && !Number.isFinite(balance)) return setError("Enter the balance as a number");
    if (!balanceTyped && editing.balance != null) return setError("Enter the balance as a number");
    const earmark = form.held ? form.earmark.trim() || "Held back" : null;
    const earmarkChanged = earmark !== editing.earmark;
    const balanceChanged =
      balanceTyped &&
      (editing.balance == null ||
        Math.abs(balance - editing.balance) >= 0.005 ||
        form.currency !== editing.currency ||
        form.asOf !== editing.asOf);
    if (!earmarkChanged && !balanceChanged) {
      setEditing(null);
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (earmarkChanged) {
        const res = await fetch(`/api/accounts/${editing.accountId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ earmark }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setError(data.error || "Save failed");
          return;
        }
      }
      if (balanceChanged) {
        const res = await fetch("/api/account-balances", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accountId: editing.accountId, asOf: form.asOf, balance, currency: form.currency }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setError(data.error || "Save failed");
          return;
        }
      }
      setEditing(null);
      router.refresh();
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  }

  async function remove(r: BalanceRow) {
    if (!r.balanceId) return;
    const back = r.stored > 1 ? "its previous balance" : "missing";
    if (!confirm(`Delete the ${r.name} balance of ${r.asOf}? The account goes back to ${back}.`)) return;
    await fetch(`/api/account-balances/${r.balanceId}`, { method: "DELETE" });
    router.refresh();
  }

  return (
    <div>
      <div className="glass-card p-4 mb-4 flex flex-wrap items-center gap-x-8 gap-y-2 text-sm">
        <div>
          <span className="text-ink-soft">Cash accounts</span>{" "}
          <span className="font-semibold">{rows.length}</span>
        </div>
        <div>
          <span className="text-ink-soft">Stored balances ≈</span>{" "}
          <span className="font-semibold tabular-nums">{formatMoney(knownEur)}</span>
          <span className="text-ink-muted text-xs"> (at each as-of date)</span>
        </div>
        <div className={cn(missing.length ? "text-clay-deep font-semibold" : "text-ink-soft")}>
          {missing.length} missing
        </div>
        <div className={cn(stale.length ? "text-clay-deep font-semibold" : "text-ink-soft")}>
          {stale.length} stale (&gt;{STALE_DAYS} days)
        </div>
        <Link href="/dashboard" className="ml-auto text-accent-green hover:underline">
          Safe to draw on the dashboard →
        </Link>
      </div>

      <div className="glass-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-ink-muted text-xs border-b border-line">
              <th className="p-3 font-medium">Account</th>
              <th className="p-3 font-medium text-right">Balance</th>
              <th className="p-3 font-medium">As of</th>
              <th className="p-3 font-medium">Source</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const st = states[i];
              return (
                <tr key={r.accountId} className="border-b border-line last:border-0 group" data-testid="balance-row">
                  <td className="p-3">
                    <div className="font-semibold">{r.name}</div>
                    {r.earmark && (
                      <span
                        className="inline-flex items-center gap-1 mt-0.5 px-1.5 py-0.5 rounded text-[11px] font-medium bg-sea/10 text-sea-deep"
                        title="Held back: not counted as drawable cash on the dashboard"
                      >
                        <Lock size={11} /> held back · {r.earmark}
                      </span>
                    )}
                    <div className="text-xs text-ink-muted">
                      {[r.institution, r.type.toLowerCase(), r.biz === "BUSINESS" ? "business" : null]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  </td>
                  <td className="p-3 text-right tabular-nums">
                    {r.balance != null && r.currency ? (
                      <>
                        <div className={cn("font-semibold", r.balance < 0 ? "text-clay-deep" : "text-ink")}>
                          {formatAmount(r.balance, r.currency)}
                        </div>
                        {r.currency !== "EUR" && r.eur != null && (
                          <div className="text-xs text-ink-muted">≈{formatMoney(r.eur)}</div>
                        )}
                      </>
                    ) : (
                      <span className="font-semibold text-clay-deep">missing</span>
                    )}
                  </td>
                  <td className="p-3 whitespace-nowrap">
                    <div>{r.asOf ? formatDate(r.asOf) : "—"}</div>
                    <span className={cn("inline-block mt-0.5 px-1.5 py-0.5 rounded text-[11px] font-medium", STATE_STYLE[st])}>
                      {st === "missing" ? "missing" : st === "stale" ? `stale · ${ageDays(r.asOf!, today)} days` : `${ageDays(r.asOf!, today)} days old`}
                    </span>
                  </td>
                  <td className="p-3 text-xs text-ink-soft max-w-[18rem]">
                    {r.origin === "STATEMENT" ? (
                      <span className="flex items-start gap-1.5 break-all">
                        <FileText size={13} className="shrink-0 mt-0.5" /> {r.source}
                      </span>
                    ) : r.origin === "MANUAL" ? (
                      <span className="flex items-center gap-1.5">
                        <Hand size={13} /> manual
                      </span>
                    ) : (
                      <span className="text-ink-muted">no printed closing balance on file</span>
                    )}
                  </td>
                  <td className="p-3 whitespace-nowrap text-right">
                    <button
                      onClick={() => openEdit(r)}
                      className="p-1.5 rounded-md text-ink-muted hover:text-ink hover:bg-ink/[0.04]"
                      aria-label={`Edit ${r.name} balance`}
                    >
                      <Pencil size={15} />
                    </button>
                    {r.balanceId && (
                      <button
                        onClick={() => remove(r)}
                        className="p-1.5 rounded-md text-ink-muted hover:text-clay-deep hover:bg-ink/[0.04]"
                        aria-label={`Delete ${r.name} balance`}
                      >
                        <Trash2 size={15} />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-ink-muted mt-4">
        A card&apos;s balance is what you owe, so it is negative. Enter the closing balance printed on a statement; a
        newer date adds a balance, the same date replaces it. The safe-to-draw tile adds the rows imported after each
        as-of date and leaves held-back and investment accounts out of the drawable cash; an investment account&apos;s
        balance is its value on Net worth.
      </p>

      {editing && (
        <Modal title={`${editing.name} — balance`} onClose={() => setEditing(null)}>
          <form onSubmit={submit} className="space-y-4">
            {error && <p className="text-sm text-clay-deep bg-clay/10 rounded-lg p-3">{error}</p>}
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <label className="block text-sm text-ink-soft mb-1">Balance</label>
                <input
                  value={form.balance}
                  onChange={(e) => setForm({ ...form, balance: e.target.value })}
                  className="input-field tabular-nums"
                  inputMode="decimal"
                  placeholder="e.g. 1234.56 (card: -250.00)"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-sm text-ink-soft mb-1">Currency</label>
                <select
                  value={form.currency}
                  onChange={(e) => setForm({ ...form, currency: e.target.value })}
                  className="input-field"
                >
                  {SUPPORTED_CURRENCIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className="block text-sm text-ink-soft mb-1">As of</label>
              <input
                type="date"
                value={form.asOf}
                max={today}
                onChange={(e) => setForm({ ...form, asOf: e.target.value })}
                className="input-field"
                required
              />
              <p className="text-xs text-ink-muted mt-1">
                Same date as the stored one = replace it. A newer date = a newer balance; the old one stays as history.
              </p>
            </div>
            <div className="border-t border-line pt-3">
              <label className="flex items-center gap-2 text-sm text-ink-soft">
                <input
                  type="checkbox"
                  checked={form.held}
                  onChange={(e) => setForm({ ...form, held: e.target.checked })}
                />
                Held back — earmarked, not drawable
              </label>
              {form.held && (
                <input
                  value={form.earmark}
                  onChange={(e) => setForm({ ...form, earmark: e.target.value })}
                  className="input-field mt-2"
                  placeholder="Why, e.g. VAT reserve"
                  maxLength={60}
                />
              )}
              <p className="text-xs text-ink-muted mt-1">
                A held-back account is shown on the safe-to-draw tile but left out of the cash you can draw.
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setEditing(null)} className="btn-secondary text-sm">
                Cancel
              </button>
              <button type="submit" disabled={busy} className="btn-primary text-sm">
                {busy ? "Saving…" : "Save"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
