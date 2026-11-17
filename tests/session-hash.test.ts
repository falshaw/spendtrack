/**
 * The sessions table holds sha256(jwt), never the JWT. A database dump used to
 * contain tokens that were live for 24 hours; now it contains digests that
 * cannot be replayed as a cookie.
 */
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  session: {
    create: vi.fn(),
    findUnique: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  },
}));
const jar = vi.hoisted(() => ({
  store: new Map<string, string>(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (k: string) => (jar.store.has(k) ? { value: jar.store.get(k) } : undefined),
    set: (k: string, v: string) => void jar.store.set(k, v),
    delete: (k: string) => void jar.store.delete(k),
  }),
}));

import { createSession, deleteSession, getSession, sessionKey } from "@/lib/auth";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

beforeEach(() => {
  vi.clearAllMocks();
  jar.store.clear();
  process.env.JWT_SECRET = "k".repeat(48);
  db.session.create.mockResolvedValue({});
  db.session.deleteMany.mockResolvedValue({ count: 0 });
});

describe("session storage", () => {
  it("stores the digest and puts the raw JWT only in the cookie", async () => {
    const token = await createSession("u1", "alice@example.com");
    const stored = db.session.create.mock.calls[0][0].data.token;
    expect(stored).toBe(sha(token));
    expect(stored).not.toBe(token);
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(jar.store.get("spendtrack_session")).toBe(token);
  });

  it("purges expired sessions at login, and a failed purge never blocks the login", async () => {
    db.session.deleteMany.mockRejectedValueOnce(new Error("db hiccup"));
    await expect(createSession("u1", "alice@example.com")).resolves.toBeTypeOf("string");
    expect(db.session.deleteMany.mock.calls[0][0].where.expiresAt.lt).toBeInstanceOf(Date);
    expect(db.session.create).toHaveBeenCalled();
  });

  it("looks a session up by digest", async () => {
    const token = await createSession("u1", "alice@example.com");
    db.session.findUnique.mockResolvedValue({ expiresAt: new Date(Date.now() + 60_000) });
    const session = await getSession();
    expect(session?.userId).toBe("u1");
    expect(db.session.findUnique).toHaveBeenCalledWith({ where: { token: sha(token) } });
  });

  it("rejects a valid JWT whose session row is gone (logged out / pre-hash row)", async () => {
    await createSession("u1", "alice@example.com");
    db.session.findUnique.mockResolvedValue(null);
    expect(await getSession()).toBeNull();
  });

  it("deletes an expired row by digest and returns no session", async () => {
    const token = await createSession("u1", "alice@example.com");
    db.session.findUnique.mockResolvedValue({ expiresAt: new Date(Date.now() - 1000) });
    expect(await getSession()).toBeNull();
    expect(db.session.delete).toHaveBeenCalledWith({ where: { token: sha(token) } });
  });

  it("logs out by digest and clears the cookie", async () => {
    const token = await createSession("u1", "alice@example.com");
    db.session.deleteMany.mockClear();
    await deleteSession();
    expect(db.session.deleteMany).toHaveBeenCalledWith({ where: { token: sessionKey(token) } });
    expect(jar.store.has("spendtrack_session")).toBe(false);
  });
});
