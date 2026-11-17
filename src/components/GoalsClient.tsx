"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { cn, formatDate, formatMoney } from "@/lib/utils";
import type { GoalRow } from "@/lib/goals-data";
import { Modal } from "./Modal";

interface AccountOpt {
  id: string;
  name: string;
  earmark: string | null;
}

const SOURCE_LABEL: Record<GoalRow["source"], string> = {
  ACCOUNT: "Earmarked account",
  RESERVE: "Tax / no-income reserve",
  MANUAL: "Entered by hand",
};

const STATUS: Record<GoalRow["status"], { label: string; cls: string }> = {
  reached: { label: "reached", cls: "bg-olive/15 text-accent-green" },
  "on-track": { label: "on track", cls: "bg-sea/10 text-sea-deep" },
  behind: { label: "behind", cls: "bg-clay/10 text-clay-deep" },
  "no-date": { label: "no date", cls: "bg-ink/[0.05] text-ink-muted" },
  "no-data": { label: "no figure", cls: "bg-ink/[0.05] text-ink-muted" },
};

const emptyForm = {
  name: "",
  source: "MANUAL" as GoalRow["source"],
  target: "",
  targetDate: "",
  accountId: "",
  manualAmount: "",
  note: "",
  archived: false,
};

/** F5 — goals: cards with progress, per-month-needed and on-track status; add/edit/delete. */
export function GoalsClient({ goals, accounts }: { goals: GoalRow[]; accounts: AccountOpt[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<GoalRow | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const earmarked = accounts.filter((a) => a.earmark && a.earmark.trim());

  function openNew() {
    setEditing(null);
    setForm(emptyForm);
    setError("");
    setOpen(true);
  }
  function openEdit(g: GoalRow) {
    setEditing(g);
    setForm({
      name: g.name,
      source: g.source,
      // A RESERVE goal without its own target follows the schedule's; keep it blank so it still does.
      target: g.ownTarget == null ? "" : String(g.ownTarget),
      targetDate: g.targetDate ?? "",
      accountId: g.accountId ?? "",
      manualAmount: g.manualAmount == null ? "" : String(g.manualAmount),
      note: g.note ?? "",
      archived: g.archived,
    });
    setError("");
    setOpen(true);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const num = (s: string) => (s.trim() === "" ? null : Number(s));
    const body = {
      name: form.name,
      source: form.source,
      target: num(form.target),
      targetDate: form.targetDate || null,
      accountId: form.source === "ACCOUNT" ? form.accountId || null : null,
      manualAmount: form.source === "MANUAL" ? num(form.manualAmount) : null,
      note: form.note || null,
      archived: form.archived,
    };
    try {
      const res = await fetch(editing ? `/api/goals/${editing.id}` : "/api/goals", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const first = data.details?.fieldErrors ? Object.values(data.details.fieldErrors).flat()[0] : null;
        setError((first as string) || data.error || "Save failed");
        return;
      }
      setOpen(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function remove(g: GoalRow) {
    if (!confirm(`Delete goal "${g.name}"?`)) return;
    const res = await fetch(`/api/goals/${g.id}`, { method: "DELETE" });
    if (res.ok) router.refresh();
  }

  const live = goals.filter((g) => !g.archived);
  const archived = goals.filter((g) => g.archived);

  return (
    <div>
      <div className="flex justify-end mb-4">
        <button onClick={openNew} className="btn-primary flex items-center gap-2">
          <Plus size={16} /> Add goal
        </button>
      </div>

      {live.length === 0 && (
        <div className="glass-card p-6 text-sm text-ink-soft">
          No goals yet. A goal can follow an earmarked account&apos;s balance, the reserve schedule, or an amount you type.
        </div>
      )}

      <div className="bento-flat grid gap-4 sm:grid-cols-2">
        {live.map((g) => (
          <GoalCard key={g.id} g={g} onEdit={() => openEdit(g)} onDelete={() => remove(g)} />
        ))}
      </div>

      {archived.length > 0 && (
        <>
          <h2 className="text-sm font-semibold text-ink-soft mt-8 mb-3">Archived</h2>
          <div className="grid gap-4 sm:grid-cols-2 opacity-60">
            {archived.map((g) => (
              <GoalCard key={g.id} g={g} onEdit={() => openEdit(g)} onDelete={() => remove(g)} />
            ))}
          </div>
        </>
      )}

      {open && (
        <Modal title={editing ? "Edit goal" : "Add goal"} onClose={() => setOpen(false)}>
          <form onSubmit={save} className="space-y-3">
            <div>
              <label className="label">Name</label>
              <input className="input-field" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={80} />
            </div>
            <div>
              <label className="label">Progress comes from</label>
              <select className="input-field" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value as GoalRow["source"] })}>
                <option value="MANUAL">{SOURCE_LABEL.MANUAL}</option>
                <option value="ACCOUNT">{SOURCE_LABEL.ACCOUNT}</option>
                <option value="RESERVE">{SOURCE_LABEL.RESERVE}</option>
              </select>
            </div>
            {form.source === "ACCOUNT" && (
              <div>
                <label className="label">Account</label>
                <select className="input-field" value={form.accountId} onChange={(e) => setForm({ ...form, accountId: e.target.value })}>
                  <option value="">Choose an earmarked account…</option>
                  {earmarked.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} — {a.earmark}
                    </option>
                  ))}
                </select>
                {earmarked.length === 0 && (
                  <p className="text-xs text-clay-deep mt-1">No account is earmarked. Mark one as held back on Balances first.</p>
                )}
              </div>
            )}
            {form.source === "MANUAL" && (
              <div>
                <label className="label">Saved so far (EUR)</label>
                <input type="number" step="0.01" min="0" className="input-field" value={form.manualAmount} onChange={(e) => setForm({ ...form, manualAmount: e.target.value })} />
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Target (EUR)</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  className="input-field"
                  value={form.target}
                  placeholder={form.source === "RESERVE" ? "schedule's final level" : ""}
                  onChange={(e) => setForm({ ...form, target: e.target.value })}
                />
              </div>
              <div>
                <label className="label">By (optional)</label>
                <input type="date" className="input-field" value={form.targetDate} onChange={(e) => setForm({ ...form, targetDate: e.target.value })} />
              </div>
            </div>
            <div>
              <label className="label">Note</label>
              <input className="input-field" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} maxLength={500} />
            </div>
            {editing && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={form.archived} onChange={(e) => setForm({ ...form, archived: e.target.checked })} /> Archived
              </label>
            )}
            {error && <p className="text-sm text-clay-deep">{error}</p>}
            <div className="flex gap-2 pt-2">
              <button type="button" onClick={() => setOpen(false)} className="btn-secondary flex-1">
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

function GoalCard({ g, onEdit, onDelete }: { g: GoalRow; onEdit: () => void; onDelete: () => void }) {
  const pct = g.pct == null ? null : Math.max(0, g.pct);
  const st = STATUS[g.status];
  return (
    <div className="glass-card p-5" data-testid="goal-card">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-semibold">{g.name}</div>
          <div className="text-xs text-ink-muted">
            {SOURCE_LABEL[g.source]}
            {g.source === "ACCOUNT" && g.accountName ? ` · ${g.accountName}` : ""}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <span className={cn("text-[10px] uppercase tracking-wide rounded-full px-2 py-0.5", st.cls)}>{st.label}</span>
          <button onClick={onEdit} title="Edit" className="p-1.5 rounded-md text-ink-muted hover:text-ink hover:bg-ink/[0.04]">
            <Pencil size={14} />
          </button>
          <button onClick={onDelete} title="Delete" className="p-1.5 rounded-md text-ink-muted hover:text-clay-deep hover:bg-ink/[0.04]">
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      <div className="mt-4 flex items-baseline justify-between">
        <span className="text-2xl font-bold tabular-nums">{g.current == null ? "—" : formatMoney(g.current, true)}</span>
        <span className="text-sm text-ink-soft tabular-nums">of {formatMoney(g.target, true)}</span>
      </div>
      <div className="mt-2 h-2 rounded-full bg-ink/[0.06] overflow-hidden" role="progressbar" aria-valuenow={pct == null ? undefined : Math.round(pct * 100)} aria-valuemin={0} aria-valuemax={100}>
        <div
          className={cn("h-full rounded-full", g.status === "behind" ? "bg-accent-orange" : "bg-accent-green")}
          style={{ width: `${pct == null ? 0 : Math.min(100, pct * 100)}%` }}
        />
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-soft">
        {pct != null && <span>{Math.round(pct * 100)} %</span>}
        {g.remaining != null && g.remaining > 0 && <span>{formatMoney(g.remaining, true)} to go</span>}
        {g.targetDate && <span>by {formatDate(g.targetDate)}</span>}
        {g.perMonthNeeded != null && <span>{formatMoney(g.perMonthNeeded, true)}/mo needed</span>}
        {g.expectedNow != null && g.status === "behind" && g.source !== "RESERVE" && <span>line says {formatMoney(g.expectedNow, true)} by now</span>}
      </div>
      {g.missing && <p className="mt-2 text-xs text-clay-deep">{g.missing}</p>}
      {g.source === "ACCOUNT" && !g.earmark && g.accountId && (
        <p className="mt-2 text-xs text-clay-deep">This account is no longer earmarked — it now counts as drawable cash.</p>
      )}
      {g.source === "ACCOUNT" && g.asOf && <p className="mt-2 text-xs text-ink-muted">Balance as of {formatDate(g.asOf)} + imports since</p>}
      {g.nextStep && (
        <p className="mt-2 text-xs text-ink-muted">
          Next step: {g.nextStep.label} ({formatDate(g.nextStep.payDate)}) → {formatMoney(g.nextStep.reserveAfter, true)}
        </p>
      )}
      {g.note && <p className="mt-2 text-xs text-ink-soft">{g.note}</p>}
    </div>
  );
}
