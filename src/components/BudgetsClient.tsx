"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { formatMoney, cn } from "@/lib/utils";
import type { CategorySlice } from "@/lib/finance";

const GROUP_LABEL: Record<string, string> = {
  NEEDS: "Needs",
  WANTS: "Wants",
  SAVINGS: "Savings",
};

function paceColor(pct: number | null): string {
  if (pct == null) return "#a59c8e";
  if (pct >= 1) return "#c8401f";
  if (pct >= 0.8) return "#b97800";
  return "#5f7a3c";
}

function BudgetRow({ slice }: { slice: CategorySlice }) {
  const router = useRouter();
  const [value, setValue] = useState(
    slice.budget == null ? "" : String(slice.budget),
  );
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const numeric = value.trim() === "" ? null : parseFloat(value);
  const pct =
    numeric && numeric > 0 ? slice.spent / numeric : null;
  const fill = pct == null ? 0 : Math.min(pct, 1) * 100;

  async function save() {
    const current = slice.budget == null ? "" : String(slice.budget);
    if (value === current) return;
    if (value !== "" && (!Number.isFinite(numeric!) || numeric! < 0)) return;
    setBusy(true);
    try {
      await fetch(`/api/categories/${slice.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ monthlyBudget: numeric }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="py-3">
      <div className="flex items-center justify-between gap-3 mb-1.5">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="w-2.5 h-2.5 rounded-sm shrink-0"
            style={{ background: slice.color }}
          />
          <span className="text-sm text-ink truncate">{slice.name}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-sm tabular-nums text-ink-soft">
            {formatMoney(slice.spent)}
          </span>
          <span className="text-ink-muted">/</span>
          <div className="flex items-center gap-1">
            <span className="text-ink-muted text-sm">€</span>
            <input
              type="number"
              min="0"
              step="10"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onBlur={save}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
              placeholder="—"
              className="w-20 bg-ink/[0.04] border border-line rounded-md px-2 py-1 text-sm text-right tabular-nums focus:outline-none focus:border-accent-green"
            />
            <span className="w-4">
              {busy ? (
                <span className="text-ink-muted text-xs">…</span>
              ) : saved ? (
                <Check size={14} className="text-accent-green" />
              ) : null}
            </span>
          </div>
        </div>
      </div>
      <div className="h-2 rounded-full bg-ink/[0.04] overflow-hidden">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${fill}%`, background: paceColor(pct) }}
        />
      </div>
    </div>
  );
}

function SplitBar({
  label,
  actual,
  target,
  color,
}: {
  label: string;
  actual: number;
  target: number;
  color: string;
}) {
  const pct = target > 0 ? Math.min(actual / target, 1) * 100 : 0;
  const over = target > 0 && actual > target;
  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span className="text-ink-soft">{label}</span>
        <span className="tabular-nums text-ink-muted">
          {formatMoney(actual, true)}
          {target > 0 && (
            <span className="text-ink-muted"> / {formatMoney(target, true)}</span>
          )}
        </span>
      </div>
      <div className="h-2 rounded-full bg-ink/[0.04] overflow-hidden">
        <div
          className="h-full rounded-full"
          style={{ width: `${pct}%`, background: over ? "#c8401f" : color }}
        />
      </div>
    </div>
  );
}

export function BudgetsClient({
  categories,
  income,
}: {
  categories: CategorySlice[];
  income: number;
}) {
  const spend = categories.filter((c) => c.group !== "INCOME");
  const totalBudget = spend.reduce((s, c) => s + (c.budget ?? 0), 0);
  const totalSpent = spend.reduce((s, c) => s + c.spent, 0);
  const free = totalBudget - totalSpent;

  const groupSpent = (g: string) =>
    spend.filter((c) => c.group === g).reduce((s, c) => s + c.spent, 0);

  const groups = ["NEEDS", "WANTS", "SAVINGS"].filter((g) =>
    spend.some((c) => c.group === g),
  );

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="bento grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="glass-card p-5">
          <div className="text-sm text-ink-soft mb-1">Total budget</div>
          <div className="text-2xl font-bold">{formatMoney(totalBudget)}</div>
        </div>
        <div className="glass-card p-5">
          <div className="text-sm text-ink-soft mb-1">Spent this month</div>
          <div className="text-2xl font-bold text-accent-orange">
            {formatMoney(totalSpent)}
          </div>
        </div>
        <div className="glass-card p-5">
          <div className="text-sm text-ink-soft mb-1">Remaining</div>
          <div
            className={cn(
              "text-2xl font-bold",
              free >= 0 ? "text-accent-green" : "text-clay-deep",
            )}
          >
            {formatMoney(free)}
          </div>
        </div>
      </div>

      {/* 50/30/20 overview */}
      {income > 0 && (
        <div className="glass-card p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm text-ink-soft">
              50 / 30 / 20 of income
            </h2>
            <span className="text-xs text-ink-muted">
              Income {formatMoney(income, true)}
            </span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <SplitBar
              label="Needs (50%)"
              actual={groupSpent("NEEDS")}
              target={income * 0.5}
              color="#2f62b8"
            />
            <SplitBar
              label="Wants (30%)"
              actual={groupSpent("WANTS")}
              target={income * 0.3}
              color="#e2553c"
            />
            <SplitBar
              label="Savings (20%)"
              actual={groupSpent("SAVINGS")}
              target={income * 0.2}
              color="#5a9a2c"
            />
          </div>
          <p className="text-xs text-ink-muted mt-3">
            Money you pay yourself from a business account arrives as a transfer, which this panel doesn&apos;t count as income.
          </p>
        </div>
      )}

      {/* Per-category, grouped */}
      {groups.map((g) => (
        <div key={g} className="glass-card p-6">
          <h2 className="text-sm text-ink-soft mb-1">{GROUP_LABEL[g]}</h2>
          <div className="divide-y divide-white/5">
            {spend
              .filter((c) => c.group === g)
              .map((c) => (
                <BudgetRow key={c.id} slice={c} />
              ))}
          </div>
        </div>
      ))}

      <p className="text-xs text-ink-muted">
        Set a monthly cap per category — leave blank for no limit. Bars turn
        amber at 80% and red when you go over.
      </p>
    </div>
  );
}
