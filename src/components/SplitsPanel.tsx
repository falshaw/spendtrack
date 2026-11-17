"use client";

import { useEffect, useState } from "react";
import { Plus, ScanLine, Trash2 } from "lucide-react";
import { formatAmount } from "@/lib/utils";
import { validateSplits } from "@/lib/splits";

interface Part {
  amount: string;
  categoryId: string;
  note: string;
}

/**
 * F3 — split one transaction across categories, inside the edit dialog. The parts
 * must sum to the row amount to the cent (the remaining counter shows the gap);
 * saving with no parts unsplits. "From receipt" reads the item lines off the first
 * photo attached to the row (F9) and fills the parts, uncategorised.
 */
export function SplitsPanel({
  transactionId,
  amount,
  currency,
  categories,
  onChange,
}: {
  transactionId: string;
  amount: number;
  currency: string;
  categories: { id: string; name: string }[];
  onChange: () => void;
}) {
  const [parts, setParts] = useState<Part[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    let alive = true;
    fetch(`/api/transactions/${transactionId}/splits`)
      .then((r) => (r.ok ? r.json() : { parts: [] }))
      .then((d) => {
        if (!alive) return;
        const got: Part[] = (d.parts ?? []).map((p: { amount: number; categoryId: string | null; note: string | null }) => ({
          amount: String(p.amount),
          categoryId: p.categoryId ?? "",
          note: p.note ?? "",
        }));
        setParts(got);
        setOpen(got.length > 0);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => {
      alive = false;
    };
  }, [transactionId]);

  const nums = parts.map((p) => ({ amount: parseFloat(p.amount) || 0, categoryId: p.categoryId || null }));
  const sum = nums.reduce((s, p) => s + p.amount, 0);
  const remaining = Math.round((amount - sum) * 100) / 100;
  const problem = parts.length ? validateSplits(amount, nums) : null;

  function update(i: number, patch: Partial<Part>) {
    setParts(parts.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  }
  function add() {
    setParts([...parts, { amount: remaining > 0 ? remaining.toFixed(2) : "", categoryId: "", note: "" }]);
    setOpen(true);
  }
  function remove(i: number) {
    setParts(parts.filter((_, j) => j !== i));
  }

  async function save(unsplit = false) {
    setBusy(true);
    setMsg("");
    try {
      const body = { parts: unsplit ? [] : nums.map((p, i) => ({ ...p, note: parts[i].note.trim() || null })) };
      const res = await fetch(`/api/transactions/${transactionId}/splits`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return setMsg(data.error || "Save failed");
      if (unsplit) setParts([]);
      setMsg(unsplit ? "Split removed." : `Saved ${data.parts} parts.`);
      onChange();
    } finally {
      setBusy(false);
    }
  }

  async function prefill() {
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch(`/api/transactions/${transactionId}/splits/prefill`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return setMsg(data.error || "Could not read the receipt");
      setParts((data.parts as { amount: number; note: string }[]).map((p) => ({ amount: p.amount.toFixed(2), categoryId: "", note: p.note })));
      setOpen(true);
      setMsg(`${data.parts.length} item lines read off the receipt — pick a category per line and close the gap.`);
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return null;

  return (
    <div className="mt-4 border-t border-line pt-3" data-testid="splits-panel">
      <div className="flex items-center justify-between">
        <button type="button" onClick={() => setOpen((v) => !v)} className="text-sm font-medium">
          Split across categories {parts.length > 0 && <span className="text-ink-muted font-normal">({parts.length} parts)</span>}
        </button>
        <div className="flex gap-2">
          <button type="button" onClick={prefill} disabled={busy} className="text-xs text-ink-soft hover:text-ink flex items-center gap-1" title="Read the item lines off the attached receipt photo">
            <ScanLine size={14} /> From receipt
          </button>
          <button type="button" onClick={add} disabled={busy} className="text-xs text-ink-soft hover:text-ink flex items-center gap-1">
            <Plus size={14} /> Add part
          </button>
        </div>
      </div>
      {open && (
        <div className="mt-2 space-y-2">
          {parts.map((p, i) => (
            <div key={i} className="grid grid-cols-[1fr_6rem_1fr_auto] gap-2 items-center">
              <select className="input-field !py-1 text-sm" value={p.categoryId} onChange={(e) => update(i, { categoryId: e.target.value })}>
                <option value="">(uncategorised)</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              <input type="number" step="0.01" min="0" className="input-field !py-1 text-sm text-right" value={p.amount} onChange={(e) => update(i, { amount: e.target.value })} />
              <input className="input-field !py-1 text-sm" placeholder="note" value={p.note} onChange={(e) => update(i, { note: e.target.value })} />
              <button type="button" onClick={() => remove(i)} className="text-ink-muted hover:text-clay-deep" title="Remove part"><Trash2 size={14} /></button>
            </div>
          ))}
          <div className="flex items-center justify-between text-xs">
            <span className={remaining === 0 ? "text-olive" : "text-clay-deep"} data-testid="splits-remaining">
              {parts.length ? `Remaining ${formatAmount(remaining, currency)} of ${formatAmount(amount, currency)}` : "No parts"}
              {problem && parts.length ? ` — ${problem}` : ""}
            </span>
            <div className="flex gap-2">
              {parts.length > 0 && (
                <button type="button" onClick={() => save(true)} disabled={busy} className="btn-secondary !py-1 !px-3 text-xs">Unsplit</button>
              )}
              <button type="button" onClick={() => save(false)} disabled={busy || !!problem || parts.length === 0} className="btn-primary !py-1 !px-3 text-xs">
                Save split
              </button>
            </div>
          </div>
          {msg && <p className="text-xs text-ink-soft">{msg}</p>}
        </div>
      )}
    </div>
  );
}
