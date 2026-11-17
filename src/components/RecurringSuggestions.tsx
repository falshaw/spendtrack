"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Sparkles, X } from "lucide-react";
import { formatAmount, formatDate, cn } from "@/lib/utils";
import type { CatLite } from "./TransactionsClient";
import type { AcctLite } from "./RecurringClient";

interface Suggestion {
  key: string;
  merchant: string;
  accountId: string | null;
  type: "EXPENSE" | "INCOME";
  currency: string;
  cadence: "WEEKLY" | "MONTHLY" | "QUARTERLY" | "YEARLY";
  count: number;
  amount: number;
  typicalAmount: number;
  priceChange: { from: number; to: number; pct: number } | null;
  firstDate: string;
  lastDate: string;
  nextDate: string;
  categoryId: string | null;
}

const CADENCE: Record<Suggestion["cadence"], string> = {
  WEEKLY: "weekly",
  MONTHLY: "monthly",
  QUARTERLY: "quarterly",
  YEARLY: "yearly",
};

/**
 * F4 — the Suggested panel on /recurring: charges that repeat on a cadence but are
 * not a rule yet. Confirm creates the rule (amount = last charge) and links the
 * past rows; Dismiss hides the group for good. Nothing changes a money row.
 */
export function RecurringSuggestions({ categories, accounts }: { categories: CatLite[]; accounts: AcctLite[] }) {
  const router = useRouter();
  const [items, setItems] = useState<Suggestion[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [cats, setCats] = useState<Record<string, string>>({});
  const [open, setOpen] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/recurring/suggestions");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not load suggestions");
      setItems(data.suggestions ?? []);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setItems([]);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    fetch("/api/recurring/suggestions")
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!alive) return;
        if (!res.ok) {
          setError(data.error || "Could not load suggestions");
          setItems([]);
        } else setItems(data.suggestions ?? []);
      })
      .catch((e) => {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
        setItems([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  async function act(s: Suggestion, kind: "confirm" | "dismiss") {
    setBusy(s.key);
    setError("");
    try {
      const body =
        kind === "confirm"
          ? {
              key: s.key,
              merchant: (names[s.key] ?? s.merchant).trim() || s.merchant,
              categoryId: (cats[s.key] ?? s.categoryId ?? "") || null,
            }
          : { key: s.key };
      const res = await fetch(`/api/recurring/suggestions/${kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || `${kind} failed`);
        return;
      }
      await load();
      if (kind === "confirm") router.refresh();
    } finally {
      setBusy(null);
    }
  }

  if (items === null) return null;
  if (items.length === 0 && !error) return null;
  const acctName = (id: string | null) => accounts.find((a) => a.id === id)?.name ?? "No account";

  return (
    <div className="glass-card p-4 mb-5" data-testid="recurring-suggestions">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex items-center gap-2 font-semibold text-sm">
        <Sparkles size={16} className="text-clay-deep" />
        Suggested — {items.length} repeating charge{items.length === 1 ? "" : "s"} not tracked yet
      </button>
      {error && <p className="text-xs text-clay-deep mt-2">{error}</p>}
      {open && items.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-ink-muted border-b border-line">
                <th className="px-2 py-1.5 font-medium">Name</th>
                <th className="px-2 py-1.5 font-medium">Category</th>
                <th className="px-2 py-1.5 font-medium">Seen</th>
                <th className="px-2 py-1.5 font-medium">Next</th>
                <th className="px-2 py-1.5 font-medium text-right">Amount</th>
                <th className="px-2 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.key} className="border-b border-line last:border-0 align-top">
                  <td className="px-2 py-2">
                    <input
                      className="input-field !py-1 text-sm w-full min-w-[10rem]"
                      value={names[s.key] ?? s.merchant}
                      onChange={(e) => setNames({ ...names, [s.key]: e.target.value })}
                      aria-label="Rule name"
                    />
                    <span className="block text-[10px] uppercase tracking-wide text-ink-muted mt-1">{acctName(s.accountId)}</span>
                  </td>
                  <td className="px-2 py-2">
                    <select
                      className="input-field !py-1 text-sm"
                      value={cats[s.key] ?? s.categoryId ?? ""}
                      onChange={(e) => setCats({ ...cats, [s.key]: e.target.value })}
                      aria-label="Category"
                    >
                      <option value="">(uncategorised)</option>
                      {categories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-2 text-ink-soft whitespace-nowrap">
                    {s.count}× {CADENCE[s.cadence]}
                    <span className="block text-[10px] text-ink-muted">
                      {formatDate(s.firstDate)} – {formatDate(s.lastDate)}
                    </span>
                  </td>
                  <td className="px-2 py-2 text-ink-soft whitespace-nowrap">{formatDate(s.nextDate)}</td>
                  <td className={cn("px-2 py-2 text-right tabular-nums font-medium", s.type === "INCOME" ? "text-accent-green" : "text-ink")}>
                    {s.type === "INCOME" ? "+" : "−"}
                    {formatAmount(s.amount, s.currency)}
                    {s.priceChange && (
                      <span
                        className={cn("block text-[10px] uppercase tracking-wide font-normal", s.priceChange.pct > 0 ? "text-clay-deep" : "text-accent-green")}
                        title={`Earlier charges were ${formatAmount(s.priceChange.from, s.currency)}`}
                      >
                        was {formatAmount(s.priceChange.from, s.currency)} ({s.priceChange.pct > 0 ? "+" : ""}
                        {Math.round(s.priceChange.pct * 1000) / 10} %)
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => act(s, "confirm")}
                        disabled={busy !== null}
                        title="Track it: create the rule and link the past charges"
                        className="p-1.5 rounded-md text-ink-muted hover:text-accent-green hover:bg-ink/[0.04]"
                      >
                        <Check size={16} />
                      </button>
                      <button
                        type="button"
                        onClick={() => act(s, "dismiss")}
                        disabled={busy !== null}
                        title="Not a bill — never suggest it again"
                        className="p-1.5 rounded-md text-ink-muted hover:text-clay-deep hover:bg-ink/[0.04]"
                      >
                        <X size={16} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
