"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Paperclip, Trash2, Download } from "lucide-react";

interface Att {
  id: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  createdAt: string;
}

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/**
 * F9 — files stored with one transaction (receipt photo, invoice PDF). Upload =
 * `POST /api/transactions/[id]/attachments`; the server reads the type from the
 * file's own bytes (JPEG/PNG/WEBP/PDF, 10 MB). A stored file counts as the
 * receipt on /receipts.
 */
export function AttachmentsPanel({ transactionId, onChange }: { transactionId: string; onChange?: () => void }) {
  const [items, setItems] = useState<Att[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/transactions/${transactionId}/attachments`);
      const data = await res.json().catch(() => ({}));
      setItems(res.ok ? (data.attachments as Att[]) : []);
    } catch {
      setItems([]);
    }
  }, [transactionId]);

  useEffect(() => {
    // Fetch on mount / transaction change; setItems runs after the await, not synchronously
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function upload(file: File) {
    setBusy(true);
    setError("");
    try {
      const fd = new FormData();
      fd.append("file", file, file.name);
      const res = await fetch(`/api/transactions/${transactionId}/attachments`, { method: "POST", body: fd });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Upload failed");
        return;
      }
      await load();
      onChange?.();
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  async function remove(a: Att) {
    if (!confirm(`Remove ${a.filename}?`)) return;
    await fetch(`/api/attachments/${a.id}`, { method: "DELETE" });
    await load();
    onChange?.();
  }

  return (
    <div className="border-t border-line pt-4 mt-4" data-testid="attachments-panel">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm text-ink-soft flex items-center gap-1.5">
          <Paperclip size={14} /> Attachments
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={() => input.current?.click()}
          className="btn-secondary text-xs py-1 px-3"
        >
          {busy ? "Uploading…" : "Attach file"}
        </button>
        <input
          ref={input}
          type="file"
          accept="image/jpeg,image/png,image/webp,application/pdf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) upload(f);
          }}
        />
      </div>
      {error && <p className="text-xs text-clay-deep bg-clay/10 rounded-lg p-2 mb-2">{error}</p>}
      {items === null ? (
        <p className="text-xs text-ink-muted">Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-xs text-ink-muted">No file attached. JPEG, PNG, WEBP or PDF up to 10 MB.</p>
      ) : (
        <ul className="space-y-1">
          {items.map((a) => (
            <li key={a.id} className="flex items-center gap-2 text-xs">
              <a href={`/api/attachments/${a.id}`} className="flex items-center gap-1 text-accent-green hover:underline truncate">
                <Download size={12} /> {a.filename}
              </a>
              <span className="text-ink-muted">{kb(a.sizeBytes)}</span>
              <button
                type="button"
                onClick={() => remove(a)}
                className="ml-auto p-1 rounded-md text-ink-muted hover:text-clay-deep hover:bg-ink/[0.04]"
                aria-label={`Remove ${a.filename}`}
              >
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
