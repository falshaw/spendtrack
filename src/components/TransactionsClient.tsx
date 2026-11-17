"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Upload, Pencil, Trash2, Search } from "lucide-react";
import { formatMoney, formatAmount, formatDate, cn } from "@/lib/utils";
import { toEur, SUPPORTED_CURRENCIES } from "@/lib/currency";
import { Modal } from "./Modal";
import { CsvImportDialog } from "./CsvImportDialog";
import { AttachmentsPanel } from "./AttachmentsPanel";
import { SplitsPanel } from "./SplitsPanel";

export interface TxnRow {
  id: string;
  date: string;
  accrualDate: string | null; // the month the row COUNTS in when it differs from `date`
  merchant: string;
  displayMerchant: string | null; // a rule's rename; the raw merchant stays the dedup key
  tags: string[];
  splitParts: number; // F3: >0 = split across categories (category shown = the largest part)
  amount: number;
  currency: string;
  type: "EXPENSE" | "INCOME";
  accountId: string | null;
  accountName: string | null;
  accountColor: string | null;
  categoryId: string | null;
  categoryName: string | null;
  categoryColor: string | null;
  categoryGroup: string | null; // INCOME/NEEDS/WANTS/SAVINGS — drives refund netting
  inMonth: boolean; // counts in the viewed month (accrual date, else charge date)
  excluded: boolean; // category excluded from totals (transfers/investments)
  note: string | null;
  reviewed: boolean;
}

export interface CatLite {
  id: string;
  name: string;
  color: string;
  group: string;
}

export interface AccountLite {
  id: string;
  name: string;
  color: string;
}

const today = () => new Date().toISOString().slice(0, 10);

const emptyForm = () => ({
  type: "EXPENSE" as "EXPENSE" | "INCOME",
  amount: "",
  currency: "EUR",
  date: today(),
  merchant: "",
  accountId: "",
  categoryId: "",
  note: "",
});

export function TransactionsClient({
  rows,
  categories,
  accounts,
  initialFilter,
  initialAccount,
  monthLabel,
  capped,
}: {
  rows: TxnRow[];
  categories: CatLite[];
  accounts: AccountLite[];
  initialFilter: string;
  initialAccount: string;
  monthLabel: string;
  capped: boolean; // the out-of-month extras hit the fetch cap
}) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [filterCat, setFilterCat] = useState("all");
  const [filterAcc, setFilterAcc] = useState(initialAccount || "all");
  const [filterType, setFilterType] = useState(initialFilter || "all");
  const [formOpen, setFormOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [editing, setEditing] = useState<TxnRow | null>(null);
  const [form, setForm] = useState(emptyForm());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (q && !`${r.merchant} ${r.displayMerchant ?? ""} ${r.tags.join(" ")} ${r.note ?? ""}`.toLowerCase().includes(q))
        return false;
      if (filterCat === "uncat" && r.categoryId) return false;
      if (filterCat !== "all" && filterCat !== "uncat" && r.categoryId !== filterCat)
        return false;
      if (filterAcc !== "all" && r.accountId !== filterAcc) return false;
      if (filterType === "review" && r.reviewed) return false;
      if (
        (filterType === "EXPENSE" || filterType === "INCOME") &&
        r.type !== filterType
      )
        return false;
      return true;
    });
  }, [rows, search, filterCat, filterAcc, filterType]);

  // Totals are for the VIEWED MONTH only and follow the dashboard's rules: EUR-
  // converted, transfers left out, a refund (money in, sitting in a spend category)
  // nets off spend, and pay handed back (money out, in an income category) nets off
  // income. The list also carries unreviewed rows from other months and, from the
  // Accounts page, an account's whole history — summing those under a month heading
  // printed all-time figures as if they were the month's.
  const totals = useMemo(() => {
    let income = 0;
    let expense = 0;
    let mixed = false;
    let excludedCount = 0;
    let outsideMonth = 0;
    for (const r of filtered) {
      if (!r.inMonth) {
        outsideMonth++;
        continue;
      }
      if (r.excluded) {
        excludedCount++;
        continue;
      }
      if (r.currency !== "EUR") mixed = true;
      const eur = toEur(r.amount, r.currency);
      const spendCategory = r.categoryGroup != null && r.categoryGroup !== "INCOME";
      if (r.type === "INCOME") {
        if (spendCategory) expense -= eur;
        else income += eur;
      } else if (r.categoryGroup === "INCOME") income -= eur;
      else expense += eur;
    }
    return { income, expense, count: filtered.length, mixed, excludedCount, outsideMonth };
  }, [filtered]);

  function openAdd() {
    setEditing(null);
    setForm(emptyForm());
    setError("");
    setFormOpen(true);
  }

  function openEdit(r: TxnRow) {
    setEditing(r);
    setForm({
      type: r.type,
      amount: String(r.amount),
      currency: r.currency,
      date: r.date.slice(0, 10),
      merchant: r.merchant,
      accountId: r.accountId ?? "",
      categoryId: r.categoryId ?? "",
      note: r.note ?? "",
    });
    setError("");
    setFormOpen(true);
  }

  async function submitForm(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const amount = parseFloat(form.amount);
    if (!form.merchant.trim()) return setError("Merchant is required");
    if (!Number.isFinite(amount) || amount <= 0)
      return setError("Enter an amount greater than 0");

    setBusy(true);
    try {
      const body = {
        type: form.type,
        amount,
        currency: form.currency,
        date: form.date,
        merchant: form.merchant.trim(),
        accountId: form.accountId || null,
        categoryId: form.categoryId || null,
        note: form.note.trim() || null,
        reviewed: true,
      };
      const res = await fetch(
        editing ? `/api/transactions/${editing.id}` : "/api/transactions",
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
      setFormOpen(false);
      router.refresh();
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  }

  async function remove(r: TxnRow) {
    if (!confirm(`Delete "${r.merchant}" (${formatAmount(r.amount, r.currency)})?`))
      return;
    await fetch(`/api/transactions/${r.id}`, { method: "DELETE" });
    router.refresh();
  }

  async function quickPatch(r: TxnRow, patch: Record<string, unknown>) {
    await fetch(`/api/transactions/${r.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    router.refresh();
  }

  return (
    <div>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="relative flex-1 min-w-[180px]">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted"
          />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search merchant or note…"
            className="input-field pl-9"
          />
        </div>
        <select
          value={filterAcc}
          onChange={(e) => setFilterAcc(e.target.value)}
          className="input-field w-auto"
        >
          <option value="all">All accounts</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select
          value={filterCat}
          onChange={(e) => setFilterCat(e.target.value)}
          className="input-field w-auto"
        >
          <option value="all">All categories</option>
          <option value="uncat">Uncategorised</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          value={filterType}
          onChange={(e) => setFilterType(e.target.value)}
          className="input-field w-auto"
        >
          <option value="all">All types</option>
          <option value="EXPENSE">Expense</option>
          <option value="INCOME">Income</option>
          <option value="review">To review</option>
        </select>
        <button
          onClick={() => setImportOpen(true)}
          className="btn-secondary flex items-center gap-2 text-sm"
        >
          <Upload size={16} /> Import CSV
        </button>
        <button
          onClick={openAdd}
          className="btn-primary flex items-center gap-2 text-sm"
        >
          <Plus size={16} /> Add
        </button>
      </div>

      {/* Summary (EUR-converted) */}
      {capped && (
        <div className="mb-3 rounded-xl border border-clay/40 bg-clay/10 px-4 py-2 text-sm text-clay-deep">
          Only the newest 2,000 rows outside {monthLabel} are loaded — older ones are not in this list.
          The {monthLabel} rows and totals are complete.
        </div>
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-1 mb-4 text-sm text-ink-soft">
        <span>{totals.count} shown</span>
        <span className="text-ink-muted">{monthLabel}:</span>
        <span className="text-accent-green">
          + {totals.mixed ? "≈" : ""}
          {formatMoney(totals.income)}
        </span>
        <span className="text-accent-orange">
          − {totals.mixed ? "≈" : ""}
          {formatMoney(totals.expense)}
        </span>
        {totals.mixed && (
          <span className="text-ink-muted">mixed currencies → EUR</span>
        )}
        {totals.excludedCount > 0 && (
          <span className="text-ink-muted">
            {totals.excludedCount} transfer(s) excluded
          </span>
        )}
        {totals.outsideMonth > 0 && (
          <span className="text-ink-muted">
            {totals.outsideMonth} row(s) from other months not in the totals
          </span>
        )}
      </div>

      {/* Table */}
      <div className="glass-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-ink-muted border-b border-line">
                <th className="px-4 py-3 font-medium">Date</th>
                <th className="px-4 py-3 font-medium">Merchant</th>
                <th className="px-4 py-3 font-medium">Category</th>
                <th className="px-4 py-3 font-medium">Account</th>
                <th className="px-4 py-3 font-medium text-right">Amount</th>
                <th className="px-4 py-3 font-medium w-24"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-ink-muted">
                    No transactions match.
                  </td>
                </tr>
              )}
              {filtered.map((r) => (
                <tr
                  key={r.id}
                  className="border-b border-line hover:bg-ink/[0.03]"
                >
                  <td className="px-4 py-2.5 whitespace-nowrap text-ink-soft">
                    {formatDate(r.date)}
                    {r.accrualDate && r.accrualDate.slice(0, 7) !== r.date.slice(0, 7) && (
                      <span
                        className="ml-1.5 text-[10px] uppercase tracking-wide text-ink-muted"
                        title={`Charged ${formatDate(r.date)}; counts in the month of ${formatDate(r.accrualDate)}`}
                      >
                        counts {r.accrualDate.slice(0, 7)}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="truncate max-w-[220px]" title={r.displayMerchant ? r.merchant : undefined}>
                        {r.displayMerchant ?? r.merchant}
                      </span>
                      {r.splitParts > 0 && (
                        <span className="text-[10px] rounded-full bg-sea/10 text-ink-soft px-1.5 py-0.5" title="Split across categories — open the row to see the parts">
                          split ×{r.splitParts}
                        </span>
                      )}
                      {r.tags.map((t) => (
                        <span key={t} className="text-[10px] rounded-full bg-clay/10 text-clay-deep px-1.5 py-0.5">
                          {t}
                        </span>
                      ))}
                      {!r.reviewed && (
                        <button
                          onClick={() => quickPatch(r, { reviewed: true })}
                          title="Mark reviewed"
                          className="text-[10px] uppercase tracking-wide text-clay-text border border-accent-orange/40 rounded px-1 hover:bg-accent-orange/10"
                        >
                          review
                        </button>
                      )}
                    </div>
                    {r.note && (
                      <div className="text-xs text-ink-muted truncate max-w-[260px]">
                        {r.note}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {/* Category colour as a dot (same markup as the Account column) —
                        the select text stays ink so it reads; the hues are 2.4–2.7:1. */}
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        aria-hidden="true"
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ background: r.categoryColor ?? "var(--line)" }}
                      />
                      <select
                        value={r.categoryId ?? ""}
                        onChange={(e) =>
                          quickPatch(r, {
                            categoryId: e.target.value || null,
                            reviewed: true,
                          })
                        }
                        className="bg-transparent border border-line rounded-md px-2 py-1 text-xs text-ink-soft max-w-[160px] focus:outline-none focus:border-accent-green"
                      >
                        <option value="">Uncategorised</option>
                        {categories.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    {r.accountName ? (
                      <span className="inline-flex items-center gap-1.5 text-xs text-ink-soft whitespace-nowrap">
                        <span
                          className="w-2 h-2 rounded-full shrink-0"
                          style={{ background: r.accountColor ?? "#64748b" }}
                        />
                        {r.accountName}
                      </span>
                    ) : (
                      <span className="text-xs text-ink-muted">—</span>
                    )}
                  </td>
                  <td
                    className={cn(
                      "px-4 py-2.5 text-right tabular-nums font-medium whitespace-nowrap",
                      r.type === "INCOME"
                        ? "text-accent-green"
                        : "text-ink",
                    )}
                  >
                    {r.type === "INCOME" ? "+" : "−"}
                    {formatAmount(r.amount, r.currency)}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center justify-end gap-1">
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

      {/* Add / Edit modal */}
      {formOpen && (
        <Modal
          title={editing ? "Edit transaction" : "Add transaction"}
          onClose={() => setFormOpen(false)}
        >
          <form onSubmit={submitForm} className="space-y-4">
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
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
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
            </div>
            <div>
              <label className="block text-sm text-ink-soft mb-1">Date</label>
              <input
                type="date"
                value={form.date}
                onChange={(e) => setForm({ ...form, date: e.target.value })}
                className="input-field"
                required
              />
            </div>
            <div>
              <label className="block text-sm text-ink-soft mb-1">
                Merchant
              </label>
              <input
                value={form.merchant}
                onChange={(e) => setForm({ ...form, merchant: e.target.value })}
                className="input-field"
                placeholder="e.g. Supermarket"
                required
              />
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
            <div>
              <label className="block text-sm text-ink-soft mb-1">
                Account
              </label>
              <select
                value={form.accountId}
                onChange={(e) =>
                  setForm({ ...form, accountId: e.target.value })
                }
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
            <div>
              <label className="block text-sm text-ink-soft mb-1">
                Note (optional)
              </label>
              <input
                value={form.note}
                onChange={(e) => setForm({ ...form, note: e.target.value })}
                className="input-field"
              />
            </div>
            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={() => setFormOpen(false)}
                className="btn-secondary flex-1"
              >
                Cancel
              </button>
              <button type="submit" className="btn-primary flex-1" disabled={busy}>
                {busy ? "Saving…" : editing ? "Save" : "Add"}
              </button>
            </div>
          </form>
          {editing && (
            <SplitsPanel
              transactionId={editing.id}
              amount={editing.amount}
              currency={editing.currency}
              categories={categories}
              onChange={() => router.refresh()}
            />
          )}
          {editing && <AttachmentsPanel transactionId={editing.id} onChange={() => router.refresh()} />}
        </Modal>
      )}

      {/* CSV import */}
      {importOpen && (
        <CsvImportDialog
          categories={categories}
          accounts={accounts}
          onClose={() => setImportOpen(false)}
          onImported={() => {
            setImportOpen(false);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}
