/**
 * F9 — attachments: the type comes from the magic bytes (a renamed .exe is
 * refused), the 10 MB cap holds on both the declared length and the bytes, and
 * every route scopes by `{id, userId}`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => ({
  transaction: { findFirst: vi.fn() },
  transactionAttachment: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    deleteMany: vi.fn(),
  },
}));
const auth = vi.hoisted(() => ({ requireUserId: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/auth", () => ({ requireUserId: auth.requireUserId }));

import {
  ATTACHMENT_MAX_BYTES,
  checkAttachment,
  declaredTooLarge,
  downloadHeaders,
  safeFilename,
  sniffMime,
} from "@/lib/attachments";
import * as upload from "@/app/api/transactions/[id]/attachments/route";
import * as one from "@/app/api/attachments/[id]/route";

const bytes = (...b: number[]) => new Uint8Array(b);
const PDF = bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0);
const JPG = bytes(0xff, 0xd8, 0xff, 0xe0, 0);
const WEBP = bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50);
const EXE = bytes(0x4d, 0x5a, 0x90, 0x00, 0x03); // "MZ"

describe("sniffMime", () => {
  it("knows the four receipt types by their first bytes", () => {
    expect(sniffMime(PDF)).toBe("application/pdf");
    expect(sniffMime(PNG)).toBe("image/png");
    expect(sniffMime(JPG)).toBe("image/jpeg");
    expect(sniffMime(WEBP)).toBe("image/webp");
  });
  it("refuses everything else, whatever it is called", () => {
    expect(sniffMime(EXE)).toBeNull();
    expect(sniffMime(bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x41, 0x56, 0x49, 0x20))).toBeNull(); // RIFF AVI
    expect(sniffMime(new TextEncoder().encode("<html><script>"))).toBeNull();
  });
});

describe("checkAttachment", () => {
  it("a renamed .exe is refused with 415", () => {
    expect(checkAttachment(EXE, "receipt.pdf")).toMatchObject({ ok: false, status: 415 });
  });
  it("caps the size at 10 MB", () => {
    const big = new Uint8Array(ATTACHMENT_MAX_BYTES + 1);
    big.set(PDF);
    expect(checkAttachment(big, "x.pdf")).toMatchObject({ ok: false, status: 413 });
    const edge = new Uint8Array(ATTACHMENT_MAX_BYTES);
    edge.set(PDF);
    expect(checkAttachment(edge, "x.pdf").ok).toBe(true);
  });
  it("an empty file is a 400", () => {
    expect(checkAttachment(new Uint8Array(0), "x.pdf")).toMatchObject({ ok: false, status: 400 });
  });
  it("forces the extension to the real type and strips path parts", () => {
    expect(checkAttachment(PDF, "../../etc/invoice.exe")).toMatchObject({ ok: true, filename: "invoice.pdf" });
    expect(safeFilename("C:\\Users\\x\\Receipt #1.jpeg", "image/jpeg")).toBe("Receipt _1.jpg");
    expect(safeFilename("...", "image/png")).toBe("attachment.png");
  });
  it("refuses on the declared length before buffering", () => {
    expect(declaredTooLarge(String(ATTACHMENT_MAX_BYTES + 200_000))).toBe(true);
    expect(declaredTooLarge(String(ATTACHMENT_MAX_BYTES))).toBe(false);
    expect(declaredTooLarge(null)).toBe(false);
  });
  it("serves as a sandboxed, nosniff download", () => {
    const h = downloadHeaders({ filename: 'a"b.pdf', mime: "application/pdf", sizeBytes: 5 });
    expect(h["Content-Disposition"]).toBe('attachment; filename="a_b.pdf"');
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["Content-Security-Policy"]).toBe("sandbox");
  });
});

const ID = "cmabcdefghijklmnopqrstuvw";
const ctx = { params: Promise.resolve({ id: ID }) };
function multipart(file: Uint8Array<ArrayBuffer>, name: string) {
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array(file)], name));
  return new NextRequest(`http://localhost/api/transactions/${ID}/attachments`, { method: "POST", body: fd });
}

describe("attachment routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.requireUserId.mockResolvedValue("u1");
    db.transaction.findFirst.mockResolvedValue({ id: ID });
    db.transactionAttachment.count.mockResolvedValue(0);
    db.transactionAttachment.findFirst.mockResolvedValue(null);
    db.transactionAttachment.create.mockImplementation(async (a: { data: Record<string, unknown> }) => ({ id: "att1", ...a.data }));
    db.transactionAttachment.deleteMany.mockResolvedValue({ count: 1 });
  });

  it("refuses an unauthenticated caller everywhere", async () => {
    auth.requireUserId.mockResolvedValue(null);
    expect((await upload.POST(multipart(PDF, "a.pdf"), ctx)).status).toBe(401);
    expect((await upload.GET(new NextRequest("http://localhost/x"), ctx)).status).toBe(401);
    expect((await one.GET(new NextRequest("http://localhost/x"), ctx)).status).toBe(401);
    expect((await one.DELETE(new NextRequest("http://localhost/x"), ctx)).status).toBe(401);
  });

  it("uploads to the caller's own transaction only", async () => {
    db.transaction.findFirst.mockResolvedValue(null);
    const res = await upload.POST(multipart(PDF, "a.pdf"), ctx);
    expect(res.status).toBe(404);
    expect(db.transaction.findFirst.mock.calls[0][0].where).toEqual({ id: ID, userId: "u1" });
    expect(db.transactionAttachment.create).not.toHaveBeenCalled();
  });

  it("stores the sniffed type, not the client's, and refuses a renamed .exe", async () => {
    const bad = await upload.POST(multipart(EXE, "receipt.pdf"), ctx);
    expect(bad.status).toBe(415);
    const ok = await upload.POST(multipart(PNG, "photo.pdf"), ctx);
    expect(ok.status).toBe(201);
    const data = db.transactionAttachment.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ userId: "u1", transactionId: ID, mime: "image/png", filename: "photo.png", sizeBytes: PNG.length });
    expect(data.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the same file twice is a 409", async () => {
    db.transactionAttachment.findFirst.mockResolvedValue({ id: "att0" });
    expect((await upload.POST(multipart(PDF, "a.pdf"), ctx)).status).toBe(409);
  });

  it("413 on a declared length over the cap, before the body is read", async () => {
    const req = new NextRequest(`http://localhost/api/transactions/${ID}/attachments`, {
      method: "POST",
      headers: { "content-length": String(ATTACHMENT_MAX_BYTES * 2) },
      body: "x",
    });
    expect((await upload.POST(req, ctx)).status).toBe(413);
    expect(db.transaction.findFirst).not.toHaveBeenCalled();
  });

  it("lists without the file bytes", async () => {
    db.transactionAttachment.findMany.mockResolvedValue([]);
    await upload.GET(new NextRequest("http://localhost/x"), ctx);
    const q = db.transactionAttachment.findMany.mock.calls[0][0];
    expect(q.where).toEqual({ transactionId: ID, userId: "u1" });
    expect(q.select.data).toBeUndefined();
  });

  it("download + delete are scoped {id, userId}", async () => {
    db.transactionAttachment.findFirst.mockResolvedValue({ filename: "a.pdf", mime: "application/pdf", sizeBytes: 8, data: Buffer.from(PDF) });
    const res = await one.GET(new NextRequest("http://localhost/x"), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
    expect(db.transactionAttachment.findFirst.mock.calls[0][0].where).toEqual({ id: ID, userId: "u1" });
    db.transactionAttachment.findFirst.mockResolvedValue(null);
    expect((await one.GET(new NextRequest("http://localhost/x"), ctx)).status).toBe(404);

    await one.DELETE(new NextRequest("http://localhost/x"), ctx);
    expect(db.transactionAttachment.deleteMany.mock.calls[0][0].where).toEqual({ id: ID, userId: "u1" });
    db.transactionAttachment.deleteMany.mockResolvedValue({ count: 0 });
    expect((await one.DELETE(new NextRequest("http://localhost/x"), ctx)).status).toBe(404);
  });
});
