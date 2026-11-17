"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Pencil, Trash2, CalendarPlus, Repeat } from "lucide-react";
import { formatAmount, formatDate, formatDateShort, cn } from "@/lib/utils";
import { SUPPORTED_CURRENCIES } from "@/lib/currency";
import { Modal } from "./Modal";
import type { CatLite } from "./TransactionsClient";
import type { RuleStatus, RuleStatusKind, StatusSummary } from "@/lib/recurring-status";

export interface RecurringRow {
  id: string;
  merchant: string;
  amount: number;
  currency: string;
  type: "EXPENSE" | "INCOME";
  cadence: "WEEKLY" | "MONTHLY" | "QUARTERLY" | "YEARLY";
  nextDate: string;
  endDate: string | null;
  ended: boolean; // resolved on the server — comparing to `now` during render is impure
  active: boolean;
  categoryId: string | null;
  categoryName: string | null;
  categoryColor: string | null;
  accountId: string | null;
  accountName: string | null;
  accountColor: string | null;
  /** F4: the latest linked charge moved > 5 % and > €1 off the rule amount. */
  priceChange: { from: number; to: number; pct: number } | null;
  /** Due / paid / missed for the latest expected occurrence (server-resolved); null = nothing to judge. */
  status: RuleStatus | null;
}

/** Minimal account shape the recurring form needs. */
export interface AcctLite {
  id: string;
  name: string;
  color: string;
}

const CADENCE_LABEL: Record<string, string> = {
  WEEKLY: "Weekly",
  MONTHLY: "Monthly",
  QUARTERLY: "Quarterly",
  YEARLY: "Yearly",
};

// paid = olive, due = sea, missed = clay, unknown / upcoming = neutral.
const STATUS_CHIP: Record<RuleStatusKind, { label: string; cls: string }> = {
  paid: { label: "paid", cls: "text-olive border-olive/25 bg-olive/10" },
  due: { label: "due", cls: "text-sea border-sea/25 bg-sea/10" },
  missed: { label: "missed", cls: "text-clay-deep border-clay/25 bg-clay/10" },
  unknown: { label: "not yet importable", cls: "text-ink-muted border-line bg-ink/[0.04]" },
  upcoming: { label: "upcoming", cls: "text-ink-soft border-line bg-ink/[0.04]" },
};

const today = () => new Date().toISOString().slice(0, 10);

const emptyForm = () => ({
  merchant: "",
  amount: "",
  currency: "EUR",
  type: "EXPENSE" as "EXPENSE" | "INCOME",
  cadence: "MONTHLY" as RecurringRow["cadence"],
  nextDate: today(),
  endDate: "",
  categoryId: "",
  accountId: "",
  active: true,
});

export function RecurringClient({
  rules,
  categories,
  accounts,
  summary,
  statusFilter,
}: {
  rules: RecurringRow[];
  categories: CatLite[];
  accounts: AcctLite[];
  summary: StatusSummary;
  /** `/recurring?status=missed` shows only those rows; null = every rule. */
  statusFilter: RuleStatusKind | null;
}) {
  const router = useRouter();
  const shown = statusFilter ? rules.filter((r) => r.status?.status === statusFilter) : rules;
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<RecurringRow | null>(null);
  const [form, setForm] = useState(emptyForm());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function openAdd() {
    setEditing(null);
    setForm(emptyForm());
    setError("");
    setOpen(true);
  }

  function openEdit(r: RecurringRow) {
    setEditing(r);
    setForm({
      merchant: r.merchant,
      amount: String(r.amount),
      currency: r.currency,
      type: r.type,
      cadence: r.cadence,
      nextDate: r.nextDate.slice(0, 10),
      endDate: r.endDate ? r.endDate.slice(0, 10) : "",
      categoryId: r.categoryId ?? "",
      accountId: r.accountId ?? "",
      active: r.active,
    });
    setError("");
    setOpen(true);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const amount = parseFloat(form.amount);
    if (!form.merchant.trim()) return setError("Merchant is required");
    if (!Number.isFinite(amount) || amount <= 0)
      return setError("Enter an amount greater than 0");
    setBusy(true);
    try {
      const body = {
        merchant: form.merchant.trim(),
        amount,
        currency: form.currency,
        type: form.type,
        cadence: form.cadence,
        nextDate: form.nextDate,
        endDate: form.endDate || null,
        categoryId: form.categoryId || null,
        accountId: form.accountId || null,
        active: form.active,
      };
      const res = await fetch(
        editing ? `/api/recurring/${editing.id}` : "/api/recurring",
        {
          method: editing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Save failed");
        return;
      }
      setOpen(false);
      router.refresh();
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  }

  async function remove(r: RecurringRow) {
    if (!confirm(`Delete recurring "${r.merchant}"?`)) return;
    await fetch(`/api/recurring/${r.id}`, { method: "DELETE" });
    router.refresh();
  }

  async function logNow(r: RecurringRow) {
    await fetch(`/api/recurring/${r.id}/post`, { method: "POST" });
    router.refresh();
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <p className="text-sm text-ink-soft tabular-nums" data-testid="status-summary">
          <span className="text-olive font-medium">{summary.paid} paid</span>
          {" · "}
          <span className="text-sea font-medium">{summary.due} due</span>
          {" · "}
          <span className={cn("font-medium", summary.missed > 0 ? "text-clay-deep" : "text-ink-soft")}>
            {summary.missed} missed
          </span>
          {" · "}
          <span className="text-ink-muted">{summary.unknown} not yet importable</span>
          {statusFilter && (
            <>
              {" — showing "}
              <span className="font-medium">{STATUS_CHIP[statusFilter].label}</span>
              {" only · "}
              <Link href="/recurring" className="text-clay-deep">
                show all
              </Link>
            </>
          )}
        </p>
        <button
          onClick={openAdd}
          className="btn-primary flex items-center gap-2 text-sm"
        >
          <Plus size={16} /> Add recurring
        </button>
      </div>

      {shown.length === 0 && statusFilter ? (
        <div className="glass-card p-10 text-center text-ink-muted">
          No rule is {STATUS_CHIP[statusFilter].label} right now.
        </div>
      ) : rules.length === 0 ? (
        <div className="glass-card p-10 text-center text-ink-muted">
          <Repeat size={28} className="mx-auto mb-3 text-ink-muted" />
          No recurring bills yet. Add rent, subscriptions or salary to see them
          on the dashboard.
        </div>
      ) : (
        <div className="glass-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-ink-muted border-b border-line">
                  <th className="px-4 py-3 font-medium">Merchant</th>
                  <th className="px-4 py-3 font-medium">Category</th>
                  <th className="px-4 py-3 font-medium">Cadence</th>
                  <th className="px-4 py-3 font-medium">Next</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium text-right">Amount</th>
                  <th className="px-4 py-3 font-medium w-32"></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr
                    key={r.id}
                    className={cn(
                      "border-b border-line hover:bg-ink/[0.03]",
                      !r.active && "opacity-50",
                    )}
                  >
                    <td className="px-4 py-2.5">
                      <span className="flex items-center gap-2 flex-wrap">
                        {r.merchant}
                        {!r.active && !r.ended && (
                          <span className="text-[10px] uppercase tracking-wide text-ink-muted border border-line px-1.5 py-0.5 rounded">
                            paused
                          </span>
                        )}
                        {r.accountName && (
                          <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-ink-muted bg-ink/[0.04] px-1.5 py-0.5 rounded">
                            <span
                              className="w-1.5 h-1.5 rounded-full"
                              style={{ background: r.accountColor ?? "#64748b" }}
                            />
                            {r.accountName}
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="flex items-center gap-2 text-ink-soft">
                        <span
                          className="w-2 h-2 rounded-full"
                          style={{ background: r.categoryColor ?? "#64748b" }}
                        />
                        {r.categoryName ?? "Uncategorised"}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-ink-soft">
                      {CADENCE_LABEL[r.cadence]}
                    </td>
                    <td className="px-4 py-2.5 text-ink-soft whitespace-nowrap">
                      {formatDate(r.nextDate)}
                      {r.endDate && (
                        <span
                          className={cn(
                            "block text-[10px] uppercase tracking-wide",
                            r.ended ? "text-clay-deep" : "text-ink-muted",
                          )}
                        >
                          {r.ended ? "ended" : "ends"} {formatDate(r.endDate)}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      {r.status ? (
                        <>
                          <span
                            className={cn(
                              "inline-block text-[10px] uppercase tracking-wide border px-1.5 py-0.5 rounded",
                              STATUS_CHIP[r.status.status].cls,
                            )}
                            title={`Expected ${formatDate(r.status.expectedDate)}`}
                            data-testid="rule-status"
                          >
                            {STATUS_CHIP[r.status.status].label}
                          </span>
                          <span className="block text-[11px] text-ink-muted mt-0.5 tabular-nums">
                            {r.status.matched
                              ? `${formatDateShort(r.status.matched.date)} · ${formatAmount(r.status.matched.amount, r.status.matched.currency)}`
                              : `expected ${formatDateShort(r.status.expectedDate)}`}
                          </span>
                        </>
                      ) : (
                        <span className="text-ink-muted">—</span>
                      )}
                    </td>
                    <td
                      className={cn(
                        "px-4 py-2.5 text-right tabular-nums font-medium",
                        r.type === "INCOME"
                          ? "text-accent-green"
                          : "text-ink",
                      )}
                    >
                      {r.type === "INCOME" ? "+" : "−"}
                      {formatAmount(r.amount, r.currency)}
                      {r.priceChange && (
                        <span
                          className={cn(
                            "block text-[10px] uppercase tracking-wide font-normal",
                            r.priceChange.pct > 0 ? "text-clay-deep" : "text-accent-green",
                          )}
                          title={`Last linked charge ${formatAmount(r.priceChange.to, r.currency)} vs the rule's ${formatAmount(r.priceChange.from, r.currency)} — edit the rule to follow it`}
                          data-testid="price-change"
                        >
                          last {formatAmount(r.priceChange.to, r.currency)} ({r.priceChange.pct > 0 ? "+" : ""}
                          {Math.round(r.priceChange.pct * 1000) / 10} %)
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => logNow(r)}
                          title="Log this now (posts a transaction)"
                          className="p-1.5 rounded-md text-ink-muted hover:text-accent-green hover:bg-ink/[0.04]"
                        >
                          <CalendarPlus size={15} />
                        </button>
                        <button
                          onClick={() => openEdit(r)}
                          className="p-1.5 rounded-md text-ink-muted hover:text-ink hover:bg-ink/[0.04]"
                          aria-label="Edit"
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          onClick={() => remove(r)}
                          className="p-1.5 rounded-md text-ink-muted hover:text-clay-deep hover:bg-ink/[0.04]"
                          aria-label="Delete"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {open && (
        <Modal
          title={editing ? "Edit recurring bill" : "Add recurring bill"}
          onClose={() => setOpen(false)}
        >
          <form onSubmit={submit} className="space-y-4">
            {error && (
              <p className="text-sm text-clay-deep bg-clay/10 rounded-lg p-3">
                {error}
              </p>
            )}
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setForm({ ...form, type: "EXPENSE" })}
                className={cn(
                  "py-2 rounded-lg text-sm font-medium border transition-colors",
                  form.type === "EXPENSE"
                    ? "bg-accent-orange/15 border-accent-orange/40 text-accent-orange"
                    : "border-line text-ink-soft hover:bg-ink/[0.04]",
                )}
              >
                Expense
              </button>
              <button
                type="button"
                onClick={() => setForm({ ...form, type: "INCOME" })}
                className={cn(
                  "py-2 rounded-lg text-sm font-medium border transition-colors",
                  form.type === "INCOME"
                    ? "bg-accent-green/15 border-accent-green/40 text-accent-green"
                    : "border-line text-ink-soft hover:bg-ink/[0.04]",
                )}
              >
                Income
              </button>
            </div>
            <div>
              <label className="block text-sm text-ink-soft mb-1">
                Merchant
              </label>
              <input
                value={form.merchant}
                onChange={(e) => setForm({ ...form, merchant: e.target.value })}
                className="input-field"
                placeholder="e.g. Netflix"
                required
              />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-sm text-ink-soft mb-1">
                  Amount
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={form.amount}
                  onChange={(e) => setForm({ ...form, amount: e.target.value })}
                  className="input-field"
                  placeholder="0.00"
                  required
                />
              </div>
              <div>
                <label className="block text-sm text-ink-soft mb-1">
                  Currency
                </label>
                <select
                  value={form.currency}
                  onChange={(e) =>
                    setForm({ ...form, currency: e.target.value })
                  }
                  className="input-field"
                >
                  {SUPPORTED_CURRENCIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm text-ink-soft mb-1">
                  Next date
                </label>
                <input
                  type="date"
                  value={form.nextDate}
                  onChange={(e) =>
                    setForm({ ...form, nextDate: e.target.value })
                  }
                  className="input-field"
                  required
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm text-ink-soft mb-1">
                  End date <span className="text-ink-muted">(optional)</span>
                </label>
                <input
                  type="date"
                  value={form.endDate}
                  min={form.nextDate}
                  onChange={(e) => setForm({ ...form, endDate: e.target.value })}
                  className="input-field"
                />
                <p className="text-xs text-ink-muted mt-1">
                  Last payment. Blank = runs indefinitely.
                </p>
              </div>
              <div>
                <label className="block text-sm text-ink-soft mb-1">
                  Account <span className="text-ink-muted">(optional)</span>
                </label>
                <select
                  value={form.accountId}
                  onChange={(e) =>
                    setForm({ ...form, accountId: e.target.value })
                  }
                  className="input-field"
                >
                  <option value="">— none (personal) —</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-ink-muted mt-1">
                  Sets which scope this rule counts under.
                </p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm text-ink-soft mb-1">
                  Cadence
                </label>
                <select
                  value={form.cadence}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      cadence: e.target.value as RecurringRow["cadence"],
                    })
                  }
                  className="input-field"
                >
                  <option value="WEEKLY">Weekly</option>
                  <option value="MONTHLY">Monthly</option>
                  <option value="QUARTERLY">Quarterly</option>
                  <option value="YEARLY">Yearly</option>
                </select>
              </div>
              <div>
                <label className="block text-sm text-ink-soft mb-1">
                  Category
                </label>
                <select
                  value={form.categoryId}
                  onChange={(e) =>
                    setForm({ ...form, categoryId: e.target.value })
                  }
                  className="input-field"
                >
                  <option value="">Uncategorised</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {editing && (
              <label className="flex items-center gap-2 text-sm text-ink-soft">
                <input
                  type="checkbox"
                  checked={form.active}
                  onChange={(e) =>
                    setForm({ ...form, active: e.target.checked })
                  }
                  className="accent-[#10b981]"
                />
                Active
              </label>
            )}
            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="btn-secondary flex-1"
              >
                Cancel
              </button>
              <button type="submit" className="btn-primary flex-1" disabled={busy}>
                {busy ? "Saving…" : editing ? "Save" : "Add"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
