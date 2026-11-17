"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Link2, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { cn, formatAmount, formatDate, formatMoney } from "@/lib/utils";
import { SUPPORTED_CURRENCIES } from "@/lib/currency";
import type { ConnectionView, HoldingView, InvestmentsOverview } from "@/lib/investments-data";
import { CategoryDonut } from "./charts/CategoryDonut";
import { PortfolioValueChart } from "./charts/PortfolioValueChart";
import { Modal } from "./Modal";

type Tab = "dividends" | "trades" | "flows";

const STATUS_CHIP: Record<ConnectionView["status"], { label: string; cls: string }> = {
  NEVER: { label: "never synced", cls: "bg-ink/[0.06] text-ink-muted" },
  OK: { label: "synced", cls: "bg-accent-green/10 text-accent-green" },
  PARTIAL: { label: "partly synced", cls: "bg-accent-orange/10 text-clay-text" },
  ERROR: { label: "sync failed", cls: "bg-clay/10 text-clay-deep" },
};

const signed = (n: number) => `${n >= 0 ? "+" : "−"}${formatMoney(Math.abs(n))}`;
const qty = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 6 });

export function InvestmentsClient({ data }: { data: InvestmentsOverview }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string[]>([]);
  const [tab, setTab] = useState<Tab>("dividends");
  const [editing, setEditing] = useState<HoldingView | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState({ symbol: "", name: "", quantity: "", avgCost: "", price: "", currency: "EUR" });
  const [formError, setFormError] = useState("");

  const synced = data.connections.filter((c) => c.broker !== "MANUAL");
  const anyConfigured = synced.some((c) => c.configured);

  async function sync() {
    setBusy(true);
    setMsg([]);
    try {
      const res = await fetch("/api/investments/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = await res.json().catch(() => ({}));
      const lines: string[] = [];
      if (body.error) lines.push(body.hint ? `${body.error} ${body.hint}` : body.error);
      for (const r of (body.results ?? []) as { broker: string; status: string; message: string }[]) {
        if (r.status === "SKIPPED") continue;
        lines.push(`${r.broker === "IBKR" ? "Interactive Brokers" : "Trading 212"}: ${r.status === "ERROR" ? "failed — " : ""}${r.message}`);
      }
      setMsg(lines.length ? lines : ["Nothing to sync."]);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function link(broker: ConnectionView["broker"], accountId: string) {
    const res = await fetch("/api/investments/connections", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ broker, accountId: accountId || null }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) setMsg([body.error || "Could not link the account"]);
    router.refresh();
  }

  function openNew() {
    setEditing(null);
    setForm({ symbol: "", name: "", quantity: "", avgCost: "", price: "", currency: "EUR" });
    setFormError("");
    setFormOpen(true);
  }
  function openEdit(h: HoldingView) {
    setEditing(h);
    setForm({
      symbol: h.symbol,
      name: h.name ?? "",
      quantity: String(h.quantity),
      avgCost: String(h.avgCost),
      price: h.price == null ? "" : String(h.price),
      currency: h.currency,
    });
    setFormError("");
    setFormOpen(true);
  }
  async function saveHolding(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFormError("");
    try {
      const body = {
        ...(editing ? {} : { symbol: form.symbol }),
        name: form.name || null,
        quantity: Number(form.quantity),
        avgCost: Number(form.avgCost),
        price: form.price === "" ? null : Number(form.price),
        currency: form.currency,
      };
      const res = await fetch(editing ? `/api/investments/holdings/${editing.id}` : "/api/investments/holdings", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) {
        const first = out.details?.fieldErrors ? Object.values(out.details.fieldErrors).flat()[0] : null;
        return setFormError((first as string) || out.error || "Save failed");
      }
      setFormOpen(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }
  async function removeHolding(h: HoldingView) {
    if (!confirm(`Delete ${h.symbol}?`)) return;
    const res = await fetch(`/api/investments/holdings/${h.id}`, { method: "DELETE" });
    if (res.ok) router.refresh();
  }

  const tiles = [
    {
      label: "Portfolio value",
      value: data.totalEur == null ? "—" : formatMoney(data.totalEur, true),
      note: data.change ? `${signed(data.change.abs)}${data.change.pct == null ? "" : ` (${data.change.pct}%)`} since ${formatDate(data.change.since)}` : "≈ EUR, all brokers",
    },
    {
      label: "Unrealised P/L",
      value: data.pnl.pnl == null ? "—" : signed(data.pnl.pnl),
      note: data.pnl.pct == null ? "on the holdings' cost" : `${data.pnl.pct}% on ${formatMoney(data.pnl.cost ?? 0, true)} cost`,
    },
    { label: "Dividends this year", value: formatMoney(data.dividendsYtdEur, true), note: `${data.dividends.length} payments on record` },
    {
      label: "Net deposits",
      value: formatMoney(data.netDepositsEur, true),
      note: `cash at brokers ${formatMoney(data.cashEur, true)}`,
    },
  ];

  return (
    <div className="space-y-6">
      {/* connections */}
      <div className="glass-card p-5">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <h2 className="font-semibold">Brokers</h2>
          <button
            onClick={sync}
            disabled={busy || !anyConfigured || !data.sync.allowed}
            className="btn-primary !py-1.5 text-sm flex items-center gap-1.5"
            title={!anyConfigured ? "No broker credentials configured" : data.sync.reason ?? "Pull holdings, trades, dividends and cash flows (read-only)"}
          >
            <RefreshCw size={14} className={cn(busy && "animate-spin")} /> {busy ? "Syncing…" : "Sync now"}
          </button>
        </div>
        {!data.sync.allowed && data.sync.reason && anyConfigured && <p className="text-xs text-clay-deep mb-2">{data.sync.reason}</p>}
        {msg.length > 0 && (
          <ul className="text-xs text-ink-soft mb-3 space-y-0.5" aria-live="polite">
            {msg.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        )}
        <ul className="grid gap-3 md:grid-cols-3">
          {data.connections.map((c) => {
            const chip = STATUS_CHIP[c.status];
            const shown = c.broker !== "MANUAL" || c.exists;
            if (!shown) return null;
            return (
              <li key={c.broker} className="rounded-2xl border border-line p-4 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold">{c.label}</span>
                  {c.configured === false ? (
                    <span className="text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 bg-ink/[0.06] text-ink-muted">not connected</span>
                  ) : (
                    <span className={cn("text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5", chip.cls)}>{c.broker === "MANUAL" ? "manual" : chip.label}</span>
                  )}
                </div>
                <div className="text-lg font-bold tabular-nums mt-1">{c.totalEur == null ? "—" : formatMoney(c.totalEur)}</div>
                <div className="text-[11px] text-ink-muted">
                  {c.asOf ? `as of ${formatDate(c.asOf)}` : "no data yet"} · {c.holdings} holdings
                  {c.lastSyncAt && c.broker !== "MANUAL" ? ` · last sync ${formatDate(c.lastSyncAt)}` : ""}
                </div>
                {c.configured === false && (
                  <p className="text-[11px] text-ink-soft mt-2">
                    {c.exists ? "Showing stored data. " : ""}To connect, set <code className="font-mono">{c.env.join(" + ")}</code> in <code className="font-mono">.env</code> and restart — see the README.
                  </p>
                )}
                {c.lastSyncMessage && c.status !== "OK" && <p className="text-[11px] text-clay-text mt-2 break-words">{c.lastSyncMessage}</p>}
                {(c.exists || c.configured) && data.accounts.length > 0 && (
                  <label className="flex items-center gap-1.5 mt-3 text-[11px] text-ink-soft">
                    <Link2 size={12} />
                    <span className="shrink-0">Replaces account</span>
                    <select
                      className="input-field !py-1 !text-xs"
                      value={c.accountId ?? ""}
                      onChange={(e) => link(c.broker, e.target.value)}
                      title="Net worth counts this connection INSTEAD of the linked account's balance"
                    >
                      <option value="">— none (counted on its own)</option>
                      {data.accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </li>
            );
          })}
        </ul>
        <p className="text-[11px] text-ink-muted mt-3">
          Read-only: the sync only downloads data, it can never place an order. Credentials stay in the environment and are never stored in the database.
        </p>
      </div>

      {data.problems.length > 0 && <p className="text-xs text-clay-deep">{data.problems.join(" · ")}</p>}

      <div className="bento grid grid-cols-2 lg:grid-cols-4 gap-3">
        {tiles.map((t) => (
          <div key={t.label} className="glass-card p-4">
            <div className="text-xs text-ink-soft mb-1">{t.label}</div>
            <div className="text-xl font-bold tabular-nums">{t.value}</div>
            <div className="text-[11px] text-ink-muted mt-1">{t.note}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
        <div className="glass-card p-5">
          <h2 className="font-semibold mb-3">Value over time</h2>
          {data.history.length >= 2 ? (
            <PortfolioValueChart data={data.history} />
          ) : (
            <p className="text-sm text-ink-soft">The line starts once two days have a value — each sync records one.</p>
          )}
        </div>
        <div className="glass-card p-5">
          <h2 className="font-semibold mb-3">Allocation</h2>
          <CategoryDonut data={data.allocation} centerLabel="Invested" emptyText="No holdings yet." />
        </div>
      </div>

      <div className="glass-card p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold">Holdings</h2>
          <button onClick={openNew} className="text-sm text-ink-soft hover:text-ink flex items-center gap-1" title="For a broker without an API, or without credentials">
            <Plus size={14} /> Add manual holding
          </button>
        </div>
        {data.holdings.length === 0 ? (
          <p className="text-sm text-ink-soft">No holdings yet — connect a broker and sync, or add a holding by hand.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-ink-muted border-b border-line">
                  <th className="px-2 py-1.5 font-medium">Symbol</th>
                  <th className="px-2 py-1.5 font-medium text-right">Quantity</th>
                  <th className="px-2 py-1.5 font-medium text-right">Avg cost</th>
                  <th className="px-2 py-1.5 font-medium text-right">Price</th>
                  <th className="px-2 py-1.5 font-medium text-right">Value ≈EUR</th>
                  <th className="px-2 py-1.5 font-medium text-right">Unrealised P/L</th>
                  <th className="px-2 py-1.5 font-medium text-right">Weight</th>
                  <th className="px-2 py-1.5" />
                </tr>
              </thead>
              <tbody>
                {data.holdings.map((h) => (
                  <tr key={h.id} className="border-b border-line last:border-0 tabular-nums">
                    <td className="px-2 py-1.5">
                      <span className="font-semibold">{h.symbol}</span>
                      <span className="block text-[10px] uppercase tracking-wide text-ink-muted truncate max-w-[16rem]">
                        {h.name ? `${h.name} · ` : ""}
                        {h.brokerLabel}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-right">{qty(h.quantity)}</td>
                    <td className="px-2 py-1.5 text-right">{formatAmount(h.avgCost, h.currency)}</td>
                    <td className="px-2 py-1.5 text-right">{h.price == null ? "—" : formatAmount(h.price, h.currency)}</td>
                    <td className="px-2 py-1.5 text-right font-medium">{h.eur == null ? "—" : formatMoney(h.eur)}</td>
                    <td className={cn("px-2 py-1.5 text-right", h.pnlEur != null && (h.pnlEur >= 0 ? "text-accent-green" : "text-clay-deep"))}>
                      {h.pnlEur == null ? "—" : signed(h.pnlEur)}
                    </td>
                    <td className="px-2 py-1.5 text-right">{h.weight == null ? "—" : `${h.weight}%`}</td>
                    <td className="px-2 py-1.5 text-right whitespace-nowrap">
                      {h.broker === "MANUAL" && (
                        <>
                          <button onClick={() => openEdit(h)} title="Edit" className="p-1 text-ink-muted hover:text-ink">
                            <Pencil size={13} />
                          </button>
                          <button onClick={() => removeHolding(h)} title="Delete" className="p-1 text-ink-muted hover:text-clay-deep">
                            <Trash2 size={13} />
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="glass-card p-5">
        <div className="flex items-center gap-1 mb-3 flex-wrap" role="tablist">
          {(
            [
              ["dividends", `Dividends (${data.dividends.length})`],
              ["trades", `Trades (${data.trades.length})`],
              ["flows", `Deposits & withdrawals (${data.flows.length})`],
            ] as [Tab, string][]
          ).map(([k, label]) => (
            <button
              key={k}
              role="tab"
              aria-selected={tab === k}
              onClick={() => setTab(k)}
              className={cn("px-3 py-1.5 rounded-full text-sm font-semibold", tab === k ? "bg-ink text-white" : "text-ink-soft hover:text-ink")}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === "dividends" && (
          <>
            <History
              empty="No dividends on record."
              head={["Paid", "Symbol", "Broker", "Amount", "Withholding", "≈EUR"]}
              rows={data.dividends.map((d) => [
                formatDate(d.paidOn),
                d.symbol,
                d.brokerLabel,
                formatAmount(d.amount, d.currency),
                d.withholdingTax == null ? "—" : formatAmount(d.withholdingTax, d.currency),
                d.eur == null ? "—" : formatMoney(d.eur),
              ])}
            />
            <p className="text-[11px] text-ink-muted mt-3">
              Dividends count as income on Income and Reports — except a payment that is already there as an imported statement row (same amount, within a few days), which is counted once.
            </p>
          </>
        )}
        {tab === "trades" && (
          <History
            empty="No trades on record."
            head={["Date", "Symbol", "Side", "Quantity", "Price", "Fees"]}
            rows={data.trades.map((t) => [
              formatDate(t.executedAt),
              t.symbol,
              t.side === "BUY" ? "Buy" : "Sell",
              qty(t.quantity),
              formatAmount(t.price, t.currency),
              t.fees ? formatAmount(t.fees, t.currency) : "—",
            ])}
          />
        )}
        {tab === "flows" && (
          <History
            empty="No deposits or withdrawals on record."
            head={["Date", "Broker", "Type", "Amount", "≈EUR"]}
            rows={data.flows.map((f) => [
              formatDate(f.date),
              f.brokerLabel,
              f.kind === "DEPOSIT" ? "Deposit" : "Withdrawal",
              `${f.kind === "DEPOSIT" ? "+" : "−"}${formatAmount(f.amount, f.currency)}`,
              f.eur == null ? "—" : formatMoney(f.eur),
            ])}
          />
        )}
      </div>

      {formOpen && (
        <Modal title={editing ? `Edit ${editing.symbol}` : "Add manual holding"} onClose={() => setFormOpen(false)}>
          <form onSubmit={saveHolding} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Symbol</label>
                <input
                  className="input-field"
                  value={form.symbol}
                  onChange={(e) => setForm({ ...form, symbol: e.target.value })}
                  required
                  maxLength={20}
                  disabled={!!editing}
                />
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
              <label className="label">Name (optional)</label>
              <input className="input-field" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={120} />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="label">Quantity</label>
                <input type="number" step="any" min="0" className="input-field" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} required />
              </div>
              <div>
                <label className="label">Avg cost</label>
                <input type="number" step="any" min="0" className="input-field" value={form.avgCost} onChange={(e) => setForm({ ...form, avgCost: e.target.value })} required />
              </div>
              <div>
                <label className="label">Price now</label>
                <input type="number" step="any" min="0" className="input-field" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} placeholder="= cost" />
              </div>
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

function History({ head, rows, empty }: { head: string[]; rows: string[][]; empty: string }) {
  if (!rows.length) return <p className="text-sm text-ink-soft">{empty}</p>;
  return (
    <div className="overflow-x-auto max-h-[28rem] overflow-y-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-white">
          <tr className="text-left text-xs text-ink-muted border-b border-line">
            {head.map((h, i) => (
              <th key={h} className={cn("px-2 py-1.5 font-medium", i >= head.length - 2 && "text-right")}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-line last:border-0 tabular-nums">
              {r.map((c, j) => (
                <td key={j} className={cn("px-2 py-1.5", j >= r.length - 2 && "text-right")}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
