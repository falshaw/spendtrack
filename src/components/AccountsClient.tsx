"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Pencil, Trash2, Landmark, CreditCard, Wallet } from "lucide-react";
import { formatMoney, formatDate, CATEGORY_COLORS, cn } from "@/lib/utils";
import { SUPPORTED_CURRENCIES } from "@/lib/currency";
import { Modal } from "./Modal";

export interface AccountFull {
  id: string;
  name: string;
  institution: string | null;
  type: "BANK" | "CARD" | "CASH" | "SAVINGS" | "INVESTMENT" | "OTHER";
  biz: "PERSONAL" | "BUSINESS";
  currency: string;
  color: string;
  isArchived: boolean;
  balanceEur: number;
  count: number;
  lastDate: string | null;
}

const TYPES = ["BANK", "CARD", "CASH", "SAVINGS", "INVESTMENT", "OTHER"] as const;

// Drives the dashboard's Together / Personal / Business scopes.
const BIZ_OPTIONS: { value: AccountFull["biz"]; label: string }[] = [
  { value: "PERSONAL", label: "Personal" },
  { value: "BUSINESS", label: "Business" },
];

function typeIcon(t: string) {
  if (t === "CARD") return CreditCard;
  if (t === "CASH") return Wallet;
  return Landmark;
}

const emptyForm = () => ({
  name: "",
  institution: "",
  type: "BANK" as AccountFull["type"],
  biz: "PERSONAL" as AccountFull["biz"],
  currency: "EUR",
  color: CATEGORY_COLORS[0],
  isArchived: false,
});

export function AccountsClient({ accounts }: { accounts: AccountFull[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<AccountFull | null>(null);
  const [form, setForm] = useState(emptyForm());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function openAdd() {
    setEditing(null);
    setForm(emptyForm());
    setError("");
    setOpen(true);
  }

  function openEdit(a: AccountFull) {
    setEditing(a);
    setForm({
      name: a.name,
      institution: a.institution ?? "",
      type: a.type,
      biz: a.biz,
      currency: a.currency,
      color: a.color,
      isArchived: a.isArchived,
    });
    setError("");
    setOpen(true);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!form.name.trim()) return setError("Name is required");
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        institution: form.institution.trim() || null,
        type: form.type,
        biz: form.biz,
        currency: form.currency,
        color: form.color,
      };
      if (editing) body.isArchived = form.isArchived;
      const res = await fetch(
        editing ? `/api/accounts/${editing.id}` : "/api/accounts",
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

  async function remove(a: AccountFull) {
    if (
      !confirm(
        `Delete "${a.name}"? Its ${a.count} transaction(s) are kept but unlinked from any account.`,
      )
    )
      return;
    await fetch(`/api/accounts/${a.id}`, { method: "DELETE" });
    router.refresh();
  }

  const visible = accounts.filter((a) => !a.isArchived);
  const totalEur = visible.reduce((s, a) => s + a.balanceEur, 0);

  return (
    <div>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div className="text-sm text-ink-soft">
          Net flow across accounts (imported rows, not bank balances):{" "}
          <span
            className={cn(
              "font-semibold",
              totalEur >= 0 ? "text-accent-green" : "text-clay-deep",
            )}
          >
            ≈{formatMoney(totalEur)}
          </span>
        </div>
        <button
          onClick={openAdd}
          className="btn-primary flex items-center gap-2 text-sm"
        >
          <Plus size={16} /> Add account
        </button>
      </div>

      <div className="bento grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {visible.map((a) => {
          const Icon = typeIcon(a.type);
          return (
            <div key={a.id} className="glass-card p-5 group">
              <div className="flex items-start justify-between mb-3">
                <div
                  className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                  style={{ background: `${a.color}22`, color: a.color }}
                >
                  <Icon size={20} />
                </div>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => openEdit(a)}
                    className="p-1.5 rounded-md text-ink-muted hover:text-ink hover:bg-ink/[0.04]"
                    aria-label="Edit"
                  >
                    <Pencil size={15} />
                  </button>
                  <button
                    onClick={() => remove(a)}
                    className="p-1.5 rounded-md text-ink-muted hover:text-clay-deep hover:bg-ink/[0.04]"
                    aria-label="Delete"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
              <Link href={`/transactions?account=${a.id}`} className="block">
                <div className="font-semibold mb-0.5 hover:text-accent-green transition-colors">
                  {a.name}
                </div>
                <div className="text-xs text-ink-muted mb-3">
                  {[
                    a.institution,
                    a.type.toLowerCase(),
                    a.currency,
                    a.biz === "BUSINESS" ? "business" : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
                <div
                  className={cn(
                    "text-2xl font-bold tabular-nums",
                    a.balanceEur >= 0 ? "text-ink" : "text-clay-deep",
                  )}
                >
                  ≈{formatMoney(a.balanceEur)}
                </div>
                <div className="text-xs text-ink-muted mt-1">
                  net flow · {a.count} txn{a.count === 1 ? "" : "s"}
                  {a.lastDate
                    ? ` · last ${formatDate(a.lastDate)}`
                    : " · no data yet"}
                </div>
              </Link>
            </div>
          );
        })}
        {visible.length === 0 && (
          <div className="glass-card p-10 text-center text-ink-muted col-span-full">
            No accounts yet. Add your first one.
          </div>
        )}
      </div>

      <p className="text-xs text-ink-muted mt-4">
        Balances are ≈EUR (each account may hold several currencies; figures are
        converted). Click an account to see its transactions.
      </p>

      {open && (
        <Modal
          title={editing ? "Edit account" : "Add account"}
          onClose={() => setOpen(false)}
        >
          <form onSubmit={submit} className="space-y-4">
            {error && (
              <p className="text-sm text-clay-deep bg-clay/10 rounded-lg p-3">
                {error}
              </p>
            )}
            <div>
              <label className="block text-sm text-ink-soft mb-1">Name</label>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="input-field"
                placeholder="e.g. Main current account"
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm text-ink-soft mb-1">
                  Institution
                </label>
                <input
                  value={form.institution}
                  onChange={(e) =>
                    setForm({ ...form, institution: e.target.value })
                  }
                  className="input-field"
                  placeholder="e.g. Revolut"
                />
              </div>
              <div>
                <label className="block text-sm text-ink-soft mb-1">Type</label>
                <select
                  value={form.type}
                  onChange={(e) =>
                    setForm({ ...form, type: e.target.value as AccountFull["type"] })
                  }
                  className="input-field"
                >
                  {TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t.charAt(0) + t.slice(1).toLowerCase()}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm text-ink-soft mb-1">
                  Primary currency
                </label>
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
              <div>
                <label className="block text-sm text-ink-soft mb-1">Scope</label>
                <select
                  value={form.biz}
                  onChange={(e) =>
                    setForm({ ...form, biz: e.target.value as AccountFull["biz"] })
                  }
                  className="input-field"
                >
                  {BIZ_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className="block text-sm text-ink-soft mb-2">Colour</label>
              <div className="flex items-center gap-2 flex-wrap">
                {CATEGORY_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setForm({ ...form, color: c })}
                    className={cn(
                      "w-7 h-7 rounded-md border-2 transition-transform",
                      form.color === c
                        ? "border-white scale-110"
                        : "border-transparent",
                    )}
                    style={{ background: c }}
                    aria-label={`Colour ${c}`}
                  />
                ))}
              </div>
            </div>
            {editing && (
              <label className="flex items-center gap-2 text-sm text-ink-soft">
                <input
                  type="checkbox"
                  checked={form.isArchived}
                  onChange={(e) =>
                    setForm({ ...form, isArchived: e.target.checked })
                  }
                  className="accent-[#10b981]"
                />
                Archived (hidden from pickers)
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
