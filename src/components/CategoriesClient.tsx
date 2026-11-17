"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { formatMoney, CATEGORY_COLORS, cn } from "@/lib/utils";
import { Modal } from "./Modal";

export interface CatFull {
  id: string;
  name: string;
  group: "INCOME" | "NEEDS" | "WANTS" | "SAVINGS";
  color: string;
  monthlyBudget: number | null;
  excludeFromTotals: boolean;
  isArchived: boolean;
}

const GROUPS: CatFull["group"][] = ["INCOME", "NEEDS", "WANTS", "SAVINGS"];
const GROUP_LABEL: Record<string, string> = {
  INCOME: "Income",
  NEEDS: "Needs",
  WANTS: "Wants",
  SAVINGS: "Savings",
};

const emptyForm = () => ({
  name: "",
  group: "WANTS" as CatFull["group"],
  color: CATEGORY_COLORS[0],
  monthlyBudget: "",
  excludeFromTotals: false,
  isArchived: false,
});

export function CategoriesClient({ categories }: { categories: CatFull[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<CatFull | null>(null);
  const [form, setForm] = useState(emptyForm());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function openAdd() {
    setEditing(null);
    setForm(emptyForm());
    setError("");
    setOpen(true);
  }

  function openEdit(c: CatFull) {
    setEditing(c);
    setForm({
      name: c.name,
      group: c.group,
      color: c.color,
      monthlyBudget: c.monthlyBudget == null ? "" : String(c.monthlyBudget),
      excludeFromTotals: c.excludeFromTotals,
      isArchived: c.isArchived,
    });
    setError("");
    setOpen(true);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!form.name.trim()) return setError("Name is required");
    const budget =
      form.monthlyBudget.trim() === "" ? null : parseFloat(form.monthlyBudget);
    if (budget != null && (!Number.isFinite(budget) || budget < 0))
      return setError("Budget must be a positive number");

    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        group: form.group,
        color: form.color,
        monthlyBudget: budget,
        excludeFromTotals: form.excludeFromTotals,
      };
      if (editing) body.isArchived = form.isArchived;

      const res = await fetch(
        editing ? `/api/categories/${editing.id}` : "/api/categories",
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

  async function remove(c: CatFull) {
    if (
      !confirm(
        `Delete "${c.name}"? Existing transactions keep their history but become uncategorised.`,
      )
    )
      return;
    await fetch(`/api/categories/${c.id}`, { method: "DELETE" });
    router.refresh();
  }

  const active = categories.filter((c) => !c.isArchived);

  return (
    <div>
      <div className="flex justify-end mb-4">
        <button
          onClick={openAdd}
          className="btn-primary flex items-center gap-2 text-sm"
        >
          <Plus size={16} /> Add category
        </button>
      </div>

      <div className="space-y-4">
        {GROUPS.filter((g) => active.some((c) => c.group === g)).map((g) => (
          <div key={g} className="glass-card p-6">
            <h2 className="text-sm text-ink-soft mb-3">{GROUP_LABEL[g]}</h2>
            <div className="divide-y divide-white/5">
              {active
                .filter((c) => c.group === g)
                .map((c) => (
                  <div
                    key={c.id}
                    className="flex items-center gap-3 py-2.5 text-sm group"
                  >
                    <span
                      className="w-4 h-4 rounded-md shrink-0"
                      style={{ background: c.color }}
                    />
                    <span className="flex-1 truncate">{c.name}</span>
                    {c.excludeFromTotals && (
                      <span className="text-[10px] uppercase tracking-wide text-ink-muted border border-line rounded px-1.5 py-0.5">
                        excluded
                      </span>
                    )}
                    <span className="text-ink-muted tabular-nums">
                      {c.monthlyBudget != null
                        ? `${formatMoney(c.monthlyBudget)}/mo`
                        : "—"}
                    </span>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => openEdit(c)}
                        className="p-1.5 rounded-md text-ink-muted hover:text-ink hover:bg-ink/[0.04]"
                        aria-label="Edit"
                      >
                        <Pencil size={15} />
                      </button>
                      <button
                        onClick={() => remove(c)}
                        className="p-1.5 rounded-md text-ink-muted hover:text-clay-deep hover:bg-ink/[0.04]"
                        aria-label="Delete"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </div>
                ))}
            </div>
          </div>
        ))}
        {active.length === 0 && (
          <div className="glass-card p-10 text-center text-ink-muted">
            No categories yet. Add your first one.
          </div>
        )}
      </div>

      {open && (
        <Modal
          title={editing ? "Edit category" : "Add category"}
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
                placeholder="e.g. Groceries"
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm text-ink-soft mb-1">
                  Group
                </label>
                <select
                  value={form.group}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      group: e.target.value as CatFull["group"],
                    })
                  }
                  className="input-field"
                >
                  {GROUPS.map((g) => (
                    <option key={g} value={g}>
                      {GROUP_LABEL[g]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm text-ink-soft mb-1">
                  Budget (€/mo)
                </label>
                <input
                  type="number"
                  step="10"
                  min="0"
                  value={form.monthlyBudget}
                  onChange={(e) =>
                    setForm({ ...form, monthlyBudget: e.target.value })
                  }
                  className="input-field"
                  placeholder="optional"
                />
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
                <input
                  type="color"
                  value={form.color}
                  onChange={(e) => setForm({ ...form, color: e.target.value })}
                  className="w-7 h-7 rounded-md bg-transparent border border-line cursor-pointer"
                  aria-label="Custom colour"
                />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-ink-soft">
              <input
                type="checkbox"
                checked={form.excludeFromTotals}
                onChange={(e) =>
                  setForm({ ...form, excludeFromTotals: e.target.checked })
                }
                className="accent-[#10b981]"
              />
              Exclude from totals (transfers / investments / internal moves)
            </label>
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
