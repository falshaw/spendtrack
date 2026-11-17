"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Eye, Pencil, Play, Plus, RotateCcw, Trash2 } from "lucide-react";
import { Modal } from "./Modal";
import { cn, formatAmount } from "@/lib/utils";
import type { PayeeOp, RuleActions, RuleConditions, TxnRuleLite } from "@/lib/rule-engine";

export interface RuleRow extends TxnRuleLite {
  name: string;
}

interface Lite {
  id: string;
  name: string;
}

interface PreviewChange {
  id: string;
  merchant: string;
  amount: number;
  currency: string;
  type: "EXPENSE" | "INCOME";
  before: { categoryId: string | null; categoryName: string | null; displayMerchant: string | null; note: string | null; tags: string[] };
  after: { categoryId: string | null; categoryName: string | null; displayMerchant: string | null; note: string | null; tags: string[] };
}

const OPS: { v: PayeeOp; label: string }[] = [
  { v: "contains", label: "contains" },
  { v: "word", label: "has the word(s)" },
  { v: "exact", label: "is exactly" },
  { v: "regex", label: "matches regex" },
];

const iso = (d: Date) => d.toISOString().slice(0, 10);
const defaultRange = () => {
  const to = new Date();
  const from = new Date(Date.UTC(to.getUTCFullYear() - 1, to.getUTCMonth(), 1));
  return { from: iso(from), to: iso(to) };
};

const emptyForm = () => ({
  name: "",
  op: "contains" as PayeeOp,
  payee: "",
  amountMin: "",
  amountMax: "",
  type: "" as "" | "EXPENSE" | "INCOME",
  accountIds: [] as string[],
  currency: "",
  categoryId: "",
  displayMerchant: "",
  note: "",
  tags: "",
  stopProcessing: true,
  active: true,
});

type Form = ReturnType<typeof emptyForm>;

function toForm(r: RuleRow): Form {
  const c = r.conditions;
  const a = r.actions;
  return {
    name: r.name,
    op: c.payee?.op ?? "contains",
    payee: c.payee?.value ?? "",
    amountMin: c.amountMin !== undefined ? String(c.amountMin) : "",
    amountMax: c.amountMax !== undefined ? String(c.amountMax) : "",
    type: c.type ?? "",
    accountIds: c.accountIds ?? [],
    currency: c.currency ?? "",
    categoryId: a.categoryId ?? "",
    displayMerchant: a.displayMerchant ?? "",
    note: a.note ?? "",
    tags: (a.tags ?? []).join(", "),
    stopProcessing: r.stopProcessing,
    active: r.active,
  };
}

function describe(c: RuleConditions, accounts: Lite[]): string {
  const parts: string[] = [];
  if (c.payee) parts.push(`payee ${OPS.find((o) => o.v === c.payee!.op)?.label ?? c.payee.op} "${c.payee.value}"`);
  if (c.amountMin !== undefined) parts.push(`amount ≥ ${c.amountMin}`);
  if (c.amountMax !== undefined) parts.push(`amount ≤ ${c.amountMax}`);
  if (c.type) parts.push(c.type === "EXPENSE" ? "expenses" : "income");
  if (c.accountIds?.length) parts.push(`on ${c.accountIds.map((id) => accounts.find((a) => a.id === id)?.name ?? id).join(", ")}`);
  if (c.currency) parts.push(c.currency);
  return parts.join(" · ") || "(no condition)";
}

function describeActions(a: RuleActions, categories: Lite[]): string {
  const parts: string[] = [];
  if (a.categoryId) parts.push(`→ ${categories.find((c) => c.id === a.categoryId)?.name ?? a.categoryId}`);
  if (a.displayMerchant) parts.push(`show as "${a.displayMerchant}"`);
  if (a.note) parts.push(`note "${a.note}"`);
  if (a.tags?.length) parts.push(`tags ${a.tags.join(", ")}`);
  return parts.join(" · ");
}

export function RulesClient({
  user,
  learned,
  categories,
  accounts,
}: {
  user: RuleRow[];
  learned: RuleRow[];
  categories: Lite[];
  accounts: Lite[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<RuleRow | null>(null);
  const [form, setForm] = useState<Form>(emptyForm());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showLearned, setShowLearned] = useState(false);
  const [range, setRange] = useState(defaultRange());
  const [preview, setPreview] = useState<{ rule: RuleRow; scanned: number; capped: boolean; changes: PreviewChange[] } | null>(null);
  const [lastBatch, setLastBatch] = useState<{ batch: string; changed: number; rule: string } | null>(null);
  const [notice, setNotice] = useState("");

  function startNew() {
    setEditing(null);
    setForm(emptyForm());
    setError("");
    setOpen(true);
  }
  function startEdit(r: RuleRow) {
    setEditing(r);
    setForm(toForm(r));
    setError("");
    setOpen(true);
  }

  function buildBody(): { conditions: RuleConditions; actions: RuleActions } | string {
    const conditions: RuleConditions = {};
    if (form.payee.trim()) conditions.payee = { op: form.op, value: form.payee.trim() };
    if (form.amountMin.trim()) {
      const n = parseFloat(form.amountMin);
      if (!Number.isFinite(n) || n < 0) return "Min amount must be a positive number";
      conditions.amountMin = n;
    }
    if (form.amountMax.trim()) {
      const n = parseFloat(form.amountMax);
      if (!Number.isFinite(n) || n < 0) return "Max amount must be a positive number";
      conditions.amountMax = n;
    }
    if (form.type) conditions.type = form.type;
    if (form.accountIds.length) conditions.accountIds = form.accountIds;
    if (form.currency.trim()) conditions.currency = form.currency.trim().toUpperCase();
    if (Object.keys(conditions).length === 0) return "Give the rule at least one condition";
    const actions: RuleActions = {};
    if (form.categoryId) actions.categoryId = form.categoryId;
    if (form.displayMerchant.trim()) actions.displayMerchant = form.displayMerchant.trim();
    if (form.note.trim()) actions.note = form.note.trim();
    const tags = form.tags.split(",").map((t) => t.trim()).filter(Boolean);
    if (tags.length) actions.tags = tags;
    if (Object.keys(actions).length === 0) return "Give the rule at least one action";
    return { conditions, actions };
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const built = buildBody();
    if (typeof built === "string") return setError(built);
    setBusy(true);
    try {
      const body = {
        name: form.name.trim(),
        active: form.active,
        stopProcessing: form.stopProcessing,
        ...built,
      };
      const res = await fetch(editing ? `/api/rules/${editing.id}` : "/api/rules", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
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

  async function remove(r: RuleRow) {
    if (!confirm(`Delete rule "${r.name || describe(r.conditions, accounts)}"? Rows it already changed keep their values.`)) return;
    await fetch(`/api/rules/${r.id}`, { method: "DELETE" });
    router.refresh();
  }

  async function toggle(r: RuleRow) {
    await fetch(`/api/rules/${r.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !r.active }),
    });
    router.refresh();
  }

  async function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= user.length) return;
    const ids = user.map((r) => r.id);
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await fetch("/api/rules/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    router.refresh();
  }

  async function runPreview(r: RuleRow) {
    setNotice("");
    setBusy(true);
    try {
      const res = await fetch(`/api/rules/${r.id}/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(range),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return setNotice(data.error || "Preview failed");
      setPreview({ rule: r, scanned: data.scanned, capped: data.capped, changes: data.changes });
    } finally {
      setBusy(false);
    }
  }

  async function runApply() {
    if (!preview) return;
    if (!confirm(`Apply "${preview.rule.name || "this rule"}" to ${preview.changes.length} row(s)? Only category, display name, note and tags change; an undo is offered after.`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/rules/${preview.rule.id}/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(range),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return setNotice(data.error || "Apply failed");
      setLastBatch({ batch: data.batch, changed: data.changed, rule: preview.rule.name || preview.rule.id });
      setNotice(`Applied to ${data.changed} row(s).`);
      setPreview(null);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function undo() {
    if (!lastBatch) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/rules/undo/${lastBatch.batch}`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return setNotice(data.error || "Undo failed");
      setNotice(`Restored ${data.restored} row(s).`);
      setLastBatch(null);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="glass-card p-4 flex flex-wrap items-center gap-3 text-sm">
        <span className="text-ink-soft">Preview / apply window</span>
        <input type="date" className="input-field !w-auto" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
        <span className="text-ink-muted">to</span>
        <input type="date" className="input-field !w-auto" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
        {lastBatch && (
          <button onClick={undo} disabled={busy} className="btn-secondary !py-1 !px-3 text-xs flex items-center gap-1" title={`Batch ${lastBatch.batch}`}>
            <RotateCcw size={14} /> Undo last apply ({lastBatch.changed} rows, {lastBatch.rule})
          </button>
        )}
        {notice && <span className="text-ink-soft" data-testid="rules-notice">{notice}</span>}
        <button onClick={startNew} className="btn-primary !py-1.5 !px-3 text-sm ml-auto flex items-center gap-1">
          <Plus size={16} /> New rule
        </button>
      </div>

      <div className="glass-card overflow-hidden">
        <div className="px-4 py-3 border-b border-ink/10 flex items-center justify-between">
          <h2 className="font-semibold">Your rules <span className="text-ink-muted font-normal">({user.length}, run in this order)</span></h2>
        </div>
        {user.length === 0 ? (
          <p className="px-4 py-6 text-sm text-ink-soft">No rules yet. A rule needs one condition (payee, amount, type, account, currency) and one action.</p>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {user.map((r, i) => (
                <tr key={r.id} className={cn("border-b border-ink/5", !r.active && "opacity-50")}>
                  <td className="px-3 py-2 w-16 whitespace-nowrap">
                    <button onClick={() => move(i, -1)} disabled={i === 0} className="text-ink-muted hover:text-ink disabled:opacity-30" title="Move up"><ArrowUp size={14} /></button>
                    <button onClick={() => move(i, 1)} disabled={i === user.length - 1} className="text-ink-muted hover:text-ink disabled:opacity-30 ml-1" title="Move down"><ArrowDown size={14} /></button>
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-medium">{r.name || <span className="text-ink-muted">(unnamed)</span>}</div>
                    <div className="text-xs text-ink-soft">If {describe(r.conditions, accounts)}</div>
                    <div className="text-xs text-ink-soft">{describeActions(r.actions, categories)}{r.stopProcessing ? "" : " · continue to next rule"}</div>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-right">
                    <button onClick={() => toggle(r)} className="text-xs text-ink-soft hover:text-ink mr-3" title={r.active ? "Switch off" : "Switch on"}>{r.active ? "on" : "off"}</button>
                    <button onClick={() => runPreview(r)} disabled={busy} className="text-ink-muted hover:text-ink mr-2" title="Preview on the window"><Eye size={15} /></button>
                    <button onClick={() => startEdit(r)} className="text-ink-muted hover:text-ink mr-2" title="Edit"><Pencil size={15} /></button>
                    <button onClick={() => remove(r)} className="text-ink-muted hover:text-clay-deep" title="Delete"><Trash2 size={15} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {preview && (
        <div className="glass-card overflow-hidden" data-testid="rules-preview">
          <div className="px-4 py-3 border-b border-ink/10 flex flex-wrap items-center gap-3">
            <h2 className="font-semibold">Preview: {preview.rule.name || "(unnamed)"}</h2>
            <span className="text-sm text-ink-soft">
              {preview.changes.length} of {preview.scanned} rows would change{preview.capped ? " (window capped at 5,000 rows — narrow it)" : ""}
            </span>
            <div className="ml-auto flex gap-2">
              <button onClick={() => setPreview(null)} className="btn-secondary !py-1 !px-3 text-xs">Close</button>
              <button onClick={runApply} disabled={busy || preview.changes.length === 0} className="btn-primary !py-1 !px-3 text-xs flex items-center gap-1">
                <Play size={14} /> Apply {preview.changes.length}
              </button>
            </div>
          </div>
          {preview.changes.length > 0 && (
            <div className="max-h-96 overflow-auto">
              <table className="w-full text-xs">
                <thead className="text-ink-muted text-left">
                  <tr><th className="px-3 py-2">Merchant</th><th className="px-3 py-2 text-right">Amount</th><th className="px-3 py-2">Before</th><th className="px-3 py-2">After</th></tr>
                </thead>
                <tbody>
                  {preview.changes.map((c) => (
                    <tr key={c.id} className="border-t border-ink/5">
                      <td className="px-3 py-1.5 max-w-[260px] truncate">{c.merchant}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{c.type === "EXPENSE" ? "−" : "+"}{formatAmount(c.amount, c.currency)}</td>
                      <td className="px-3 py-1.5 text-ink-soft">{labelState(c.before)}</td>
                      <td className="px-3 py-1.5">{labelState(c.after)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div className="glass-card overflow-hidden">
        <button onClick={() => setShowLearned((v) => !v)} className="w-full px-4 py-3 text-left flex items-center justify-between">
          <h2 className="font-semibold">Learned merchant rules <span className="text-ink-muted font-normal">({learned.length})</span></h2>
          <span className="text-xs text-ink-soft">{showLearned ? "hide" : "show"}</span>
        </button>
        {showLearned && (
          <div className="border-t border-ink/10">
            <p className="px-4 py-2 text-xs text-ink-soft">
              One per merchant, learned when you categorise a row. They fill the category only where no rule above did — exact match first, then the longest whole-word match.
            </p>
            <table className="w-full text-sm">
              <tbody>
                {learned.map((r) => (
                  <tr key={r.id} className={cn("border-t border-ink/5", !r.active && "opacity-50")}>
                    <td className="px-4 py-1.5 font-mono text-xs">{r.matchText}</td>
                    <td className="px-4 py-1.5 text-ink-soft">{categories.find((c) => c.id === r.actions.categoryId)?.name ?? r.actions.categoryId}</td>
                    <td className="px-4 py-1.5 text-right whitespace-nowrap">
                      <button onClick={() => toggle(r)} className="text-xs text-ink-soft hover:text-ink mr-3">{r.active ? "on" : "off"}</button>
                      <button onClick={() => remove(r)} className="text-ink-muted hover:text-clay-deep" title="Delete"><Trash2 size={14} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {open && (
        <Modal title={editing ? "Edit rule" : "New rule"} onClose={() => setOpen(false)} wide>
          <form onSubmit={submit} className="space-y-4 text-sm">
            <div>
              <label className="block text-xs text-ink-soft mb-1">Name</label>
              <input className="input-field" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Spotify → Subscriptions" />
            </div>
            <fieldset className="space-y-2">
              <legend className="text-xs uppercase tracking-wide text-ink-muted">If</legend>
              <div className="flex gap-2">
                <select className="input-field !w-44" value={form.op} onChange={(e) => setForm({ ...form, op: e.target.value as PayeeOp })}>
                  {OPS.map((o) => <option key={o.v} value={o.v}>payee {o.label}</option>)}
                </select>
                <input className="input-field flex-1" value={form.payee} onChange={(e) => setForm({ ...form, payee: e.target.value })} placeholder={form.op === "regex" ? "^acme\\.example" : "spotify"} />
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                <input className="input-field" type="number" step="0.01" min="0" placeholder="amount ≥" value={form.amountMin} onChange={(e) => setForm({ ...form, amountMin: e.target.value })} />
                <input className="input-field" type="number" step="0.01" min="0" placeholder="amount ≤" value={form.amountMax} onChange={(e) => setForm({ ...form, amountMax: e.target.value })} />
                <select className="input-field" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as Form["type"] })}>
                  <option value="">any type</option>
                  <option value="EXPENSE">expenses</option>
                  <option value="INCOME">income</option>
                </select>
                <input className="input-field" maxLength={3} placeholder="currency (EUR)" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} />
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {accounts.map((a) => (
                  <label key={a.id} className="flex items-center gap-1 text-xs">
                    <input
                      type="checkbox"
                      checked={form.accountIds.includes(a.id)}
                      onChange={(e) =>
                        setForm({ ...form, accountIds: e.target.checked ? [...form.accountIds, a.id] : form.accountIds.filter((x) => x !== a.id) })
                      }
                    />
                    {a.name}
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset className="space-y-2">
              <legend className="text-xs uppercase tracking-wide text-ink-muted">Then</legend>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                <select className="input-field" value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}>
                  <option value="">keep category</option>
                  {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <input className="input-field" placeholder="show as (display name)" value={form.displayMerchant} onChange={(e) => setForm({ ...form, displayMerchant: e.target.value })} />
                <input className="input-field" placeholder="note" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
                <input className="input-field" placeholder="tags, comma separated" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} />
              </div>
            </fieldset>
            <div className="flex flex-wrap gap-4 text-xs">
              <label className="flex items-center gap-1"><input type="checkbox" checked={form.stopProcessing} onChange={(e) => setForm({ ...form, stopProcessing: e.target.checked })} /> stop after this rule</label>
              <label className="flex items-center gap-1"><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> active</label>
            </div>
            {error && <p className="text-clay-deep text-xs">{error}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setOpen(false)} className="btn-secondary">Cancel</button>
              <button type="submit" disabled={busy} className="btn-primary">{editing ? "Save" : "Create"}</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

function labelState(s: PreviewChange["before"]): string {
  const parts: string[] = [];
  parts.push(s.categoryName ?? "(uncategorised)");
  if (s.displayMerchant) parts.push(`"${s.displayMerchant}"`);
  if (s.note) parts.push(`note: ${s.note}`);
  if (s.tags.length) parts.push(`#${s.tags.join(" #")}`);
  return parts.join(" · ");
}
