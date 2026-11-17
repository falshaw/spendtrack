"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Camera, Download, Pencil, Plus, Trash2 } from "lucide-react";
import { cn, formatAmount, formatDate, formatMoney } from "@/lib/utils";
import { SUPPORTED_CURRENCIES } from "@/lib/currency";
import type { NetWorthResult, NetWorthItemKind } from "@/lib/net-worth";
import type { SnapshotRow } from "@/lib/net-worth-data";
import { NetWorthChart } from "./charts/NetWorthChart";
import { Modal } from "./Modal";

interface ItemRow {
  id: string;
  kind: NetWorthItemKind;
  name: string;
  amount: number;
  currency: string;
  asOf: string;
  note: string | null;
}

const KIND_LABEL: Record<NetWorthItemKind, string> = { CAR: "Car", ASSET: "Other asset", LIABILITY: "Debt / liability" };
const MONTH = new Intl.DateTimeFormat("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });

export function NetWorthClient({
  today,
  current,
  snapshots,
  items,
}: {
  today: string;
  current: NetWorthResult;
  snapshots: SnapshotRow[];
  items: ItemRow[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [editing, setEditing] = useState<ItemRow | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState({ kind: "ASSET" as NetWorthItemKind, name: "", amount: "", currency: "EUR", asOf: today, note: "" });
  const [formError, setFormError] = useState("");

  const points = snapshots.map((s) => ({
    label: MONTH.format(new Date(`${s.month}T00:00:00Z`)),
    net: s.net,
    netAfterReserve: s.reserve == null ? null : Math.round((s.net - s.reserve) * 100) / 100,
    estimated: s.estimated,
  }));

  async function snapshot(month?: string) {
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch("/api/net-worth/snapshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(month ? { month } : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return setMsg(data.error || "Snapshot failed");
      setMsg(`Stored ${data.month.slice(0, 7)}: ${formatMoney(data.net, true)}${data.estimated ? " (estimated)" : ""}.`);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  function openNew() {
    setEditing(null);
    setForm({ kind: "ASSET", name: "", amount: "", currency: "EUR", asOf: today, note: "" });
    setFormError("");
    setFormOpen(true);
  }
  function openEdit(i: ItemRow) {
    setEditing(i);
    setForm({ kind: i.kind, name: i.name, amount: String(i.amount), currency: i.currency, asOf: i.asOf, note: i.note ?? "" });
    setFormError("");
    setFormOpen(true);
  }
  async function saveItem(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFormError("");
    try {
      const body = {
        kind: form.kind,
        name: form.name,
        amount: Number(form.amount),
        currency: form.currency,
        asOf: form.asOf,
        note: form.note || null,
      };
      const res = await fetch(editing ? `/api/net-worth/items/${editing.id}` : "/api/net-worth/items", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const first = data.details?.fieldErrors ? Object.values(data.details.fieldErrors).flat()[0] : null;
        return setFormError((first as string) || data.error || "Save failed");
      }
      setFormOpen(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }
  async function removeItem(i: ItemRow) {
    if (!confirm(`Delete "${i.name}"?`)) return;
    const res = await fetch(`/api/net-worth/items/${i.id}`, { method: "DELETE" });
    if (res.ok) router.refresh();
  }

  const c = current;
  const cards = [
    { label: "Net worth now", value: c.net, tone: "text-ink", note: c.estimated ? "estimated — see the chips below" : "all figures current" },
    { label: "After tax reserve", value: c.netAfterReserve, tone: "text-clay-deep", note: c.reserve == null ? "no reserve schedule" : `reserve due now ${formatMoney(c.reserve, true)}` },
    { label: "Cash", value: c.cash, tone: "text-accent-green", note: `cards owed ${formatMoney(c.cards, true)}` },
    { label: "Investments", value: c.trading, tone: "text-sea", note: c.trading == null ? (c.detail.tradingProblem ?? "not available") : "investment account balances" },
  ];

  return (
    <div className="space-y-6">
      <div className="bento grid grid-cols-2 lg:grid-cols-4 gap-3">
        {cards.map((k) => (
          <div key={k.label} className="glass-card p-4">
            <div className="text-xs text-ink-soft mb-1">{k.label}</div>
            <div className={cn("text-xl font-bold tabular-nums", k.tone)}>{k.value == null ? "—" : formatMoney(k.value, true)}</div>
            <div className="text-[11px] text-ink-muted mt-1">{k.note}</div>
          </div>
        ))}
      </div>

      <div className="glass-card p-5">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <h2 className="font-semibold">Trend</h2>
          <div className="flex gap-2">
            <button onClick={() => snapshot()} disabled={busy} className="btn-secondary !py-1.5 text-sm flex items-center gap-1.5" title="Store (or refresh) last month's figure">
              <Camera size={14} /> Snapshot last month
            </button>
            <button onClick={() => snapshot(today.slice(0, 7))} disabled={busy} className="btn-secondary !py-1.5 text-sm" title="Store this month as of today; replaced again when it is complete">
              This month so far
            </button>
            <a href="/api/net-worth/export" className="btn-secondary !py-1.5 text-sm flex items-center gap-1.5">
              <Download size={14} /> CSV
            </a>
          </div>
        </div>
        {msg && <p className="text-xs text-ink-soft mb-2">{msg}</p>}
        {points.length >= 2 ? (
          <NetWorthChart data={points} />
        ) : (
          <p className="text-sm text-ink-soft">
            {points.length === 1 ? "One month stored so far — the trend line starts with the second." : "No months stored yet."}
          </p>
        )}
        {snapshots.length > 0 && (
          <div className="overflow-x-auto mt-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-ink-muted border-b border-line">
                  <th className="px-2 py-1.5 font-medium">Month</th>
                  <th className="px-2 py-1.5 font-medium text-right">Cash</th>
                  <th className="px-2 py-1.5 font-medium text-right">Investments</th>
                  <th className="px-2 py-1.5 font-medium text-right">Assets</th>
                  <th className="px-2 py-1.5 font-medium text-right">Liabilities</th>
                  <th className="px-2 py-1.5 font-medium text-right">Net</th>
                  <th className="px-2 py-1.5 font-medium text-right">After reserve</th>
                </tr>
              </thead>
              <tbody>
                {[...snapshots].reverse().map((s) => (
                  <tr key={s.month} className="border-b border-line last:border-0 tabular-nums">
                    <td className="px-2 py-1.5">
                      {s.month.slice(0, 7)}
                      {s.estimated && <span className="ml-2 text-[10px] uppercase tracking-wide text-clay-deep">estimated</span>}
                    </td>
                    <td className="px-2 py-1.5 text-right">{formatMoney(s.cash, true)}</td>
                    <td className="px-2 py-1.5 text-right">{s.trading == null ? "—" : formatMoney(s.trading, true)}</td>
                    <td className="px-2 py-1.5 text-right">{formatMoney(s.assets, true)}</td>
                    <td className="px-2 py-1.5 text-right">{formatMoney(s.liabilities, true)}</td>
                    <td className="px-2 py-1.5 text-right font-medium">{formatMoney(s.net, true)}</td>
                    <td className="px-2 py-1.5 text-right">{s.reserve == null ? "—" : formatMoney(s.net - s.reserve, true)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="glass-card p-5">
          <h2 className="font-semibold mb-3">Accounts (as of today)</h2>
          <ul className="space-y-1.5 text-sm">
            {c.detail.lines.map((l) => (
              <li key={l.accountId} className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  {l.name}
                  {l.state !== "ok" && (
                    <span className={cn("text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5", l.state === "missing" ? "bg-clay/10 text-clay-deep" : "bg-accent-orange/10 text-clay-text")}>
                      {l.state === "missing" ? "no balance" : `stale · ${formatDate(l.asOf)}`}
                    </span>
                  )}
                </span>
                <span className={cn("tabular-nums", l.eur != null && l.eur < 0 && "text-clay-deep")}>{l.eur == null ? "—" : formatMoney(l.eur)}</span>
              </li>
            ))}
          </ul>
          <h3 className="font-semibold mt-5 mb-2 text-sm">Investment accounts</h3>
          {c.detail.trading.length === 0 ? (
            <p className="text-xs text-clay-deep">{c.detail.tradingProblem ?? "No investment accounts"}</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {c.detail.trading.map((p) => (
                <li key={p.name} className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2">
                    {p.name}
                    {p.value == null ? (
                      <span className="text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 bg-clay/10 text-clay-deep">no snapshot</span>
                    ) : (
                      p.stale && (
                        <span className="text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 bg-accent-orange/10 text-clay-text">stale · {formatDate(p.date)}</span>
                      )
                    )}
                  </span>
                  <span className="tabular-nums">{p.value == null ? "—" : formatMoney(p.value)}</span>
                </li>
              ))}
            </ul>
          )}
          {c.detail.trading.length > 0 && c.detail.tradingProblem && <p className="text-xs text-ink-muted mt-2">{c.detail.tradingProblem}</p>}
        </div>

        <div className="glass-card p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold">Other assets &amp; debts</h2>
            <button onClick={openNew} className="text-sm text-ink-soft hover:text-ink flex items-center gap-1">
              <Plus size={14} /> Add
            </button>
          </div>
          {items.length === 0 ? (
            <p className="text-sm text-ink-soft">Nothing yet — add the car&apos;s value, other assets, or a loan.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {items.map((i) => (
                <li key={i.id} className="flex items-center justify-between gap-2">
                  <span>
                    {i.name}
                    <span className="block text-[10px] uppercase tracking-wide text-ink-muted">
                      {KIND_LABEL[i.kind]} · as of {formatDate(i.asOf)}
                    </span>
                  </span>
                  <span className="flex items-center gap-1">
                    <span className={cn("tabular-nums", i.kind === "LIABILITY" && "text-clay-deep")}>
                      {i.kind === "LIABILITY" ? "−" : ""}
                      {formatAmount(i.amount, i.currency)}
                    </span>
                    <button onClick={() => openEdit(i)} title="Edit" className="p-1 text-ink-muted hover:text-ink">
                      <Pencil size={13} />
                    </button>
                    <button onClick={() => removeItem(i)} title="Delete" className="p-1 text-ink-muted hover:text-clay-deep">
                      <Trash2 size={13} />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {formOpen && (
        <Modal title={editing ? "Edit item" : "Add asset or debt"} onClose={() => setFormOpen(false)}>
          <form onSubmit={saveItem} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Kind</label>
                <select className="input-field" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as NetWorthItemKind })}>
                  {(Object.keys(KIND_LABEL) as NetWorthItemKind[]).map((k) => (
                    <option key={k} value={k}>
                      {KIND_LABEL[k]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">Valued as of</label>
                <input type="date" className="input-field" value={form.asOf} onChange={(e) => setForm({ ...form, asOf: e.target.value })} required />
              </div>
            </div>
            <div>
              <label className="label">Name</label>
              <input className="input-field" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={120} />
            </div>
            <div className="grid grid-cols-[1fr_7rem] gap-3">
              <div>
                <label className="label">{form.kind === "LIABILITY" ? "Amount owed" : "Value"}</label>
                <input type="number" step="0.01" min="0" className="input-field" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required />
              </div>
              <div>
                <label className="label">Currency</label>
                <select className="input-field" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
                  {SUPPORTED_CURRENCIES.map((cc) => (
                    <option key={cc} value={cc}>
                      {cc}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className="label">Note</label>
              <input className="input-field" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} maxLength={500} />
            </div>
            {formError && <p className="text-sm text-clay-deep">{formError}</p>}
            <div className="flex gap-2 pt-2">
              <button type="button" onClick={() => setFormOpen(false)} className="btn-secondary flex-1">
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
