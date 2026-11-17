/**
 * F9 — attachment checks, pure so they are testable.
 *
 * The stored type comes from the file's own first bytes, never from the client's
 * MIME or the file name: a renamed .exe must not come back out as "receipt.pdf"
 * with `application/pdf`. Four types only — what receipts and invoices are.
 */

export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
/** Multipart framing on top of the file, allowed on the declared Content-Length. */
export const ATTACHMENT_FORM_OVERHEAD = 64 * 1024;
export const ATTACHMENTS_PER_TXN = 20;

export type AttachmentMime = "image/jpeg" | "image/png" | "application/pdf" | "image/webp";

const startsWith = (b: Uint8Array, sig: number[], at = 0) =>
  b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);

/** The real type of a file from its magic bytes, or null when it is none of the four. */
export function sniffMime(bytes: Uint8Array): AttachmentMime | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"; // %PDF-
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
}

const EXT: Record<AttachmentMime, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "application/pdf": "pdf",
  "image/webp": "webp",
};

/**
 * A filename safe to store and to put in Content-Disposition: path parts dropped,
 * only [A-Za-z0-9._ -] kept, at most 120 chars, and the extension forced to the
 * sniffed type's (so "invoice.pdf.exe" holding a PDF becomes "invoice.pdf.pdf").
 */
export function safeFilename(name: string, mime: AttachmentMime): string {
  const base = (name.split(/[\\/]/).pop() ?? "")
    .replace(/[^A-Za-z0-9._ -]+/g, "_")
    .replace(/^\.+/, "")
    .trim();
  const stem = base.replace(/\.[A-Za-z0-9]{1,5}$/, "") || "attachment";
  return `${stem.slice(0, 110)}.${EXT[mime]}`;
}

export type AttachmentCheck =
  | { ok: true; mime: AttachmentMime; filename: string }
  | { ok: false; status: 400 | 413 | 415; error: string };

/** Size + type verdict for an uploaded file's bytes. */
export function checkAttachment(bytes: Uint8Array, name: string): AttachmentCheck {
  if (bytes.length === 0) return { ok: false, status: 400, error: "Empty file" };
  if (bytes.length > ATTACHMENT_MAX_BYTES) return { ok: false, status: 413, error: "File too large (10 MB max)" };
  const mime = sniffMime(bytes);
  if (!mime) return { ok: false, status: 415, error: "Only JPEG, PNG, WEBP or PDF files can be attached" };
  return { ok: true, mime, filename: safeFilename(name, mime) };
}

/** Refuse on the declared length BEFORE the body is buffered. */
export function declaredTooLarge(contentLength: string | null): boolean {
  const n = Number(contentLength ?? 0);
  return Number.isFinite(n) && n > ATTACHMENT_MAX_BYTES + ATTACHMENT_FORM_OVERHEAD;
}

/** Headers for serving a stored file: always a download, never rendered in our origin. */
export function downloadHeaders(a: { filename: string; mime: string; sizeBytes: number }): Record<string, string> {
  const ascii = a.filename.replace(/[^A-Za-z0-9._ -]/g, "_");
  return {
    "Content-Type": a.mime,
    "Content-Length": String(a.sizeBytes),
    "Content-Disposition": `attachment; filename="${ascii}"`,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox",
    "Cache-Control": "private, no-store",
  };
}
