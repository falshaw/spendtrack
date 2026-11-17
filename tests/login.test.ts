/**
 * The login route end to end, over a mocked database.
 *
 * The lockout is the part worth pinning: it must refuse a locked account even
 * when the password is right, it must survive a restart (it lives on the user
 * row, not in memory), and it must fail closed if the database is unreachable.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
}));
const authFns = vi.hoisted(() => ({
  verifyPassword: vi.fn(),
  createSession: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/auth", () => ({
  verifyPassword: authFns.verifyPassword,
  createSession: authFns.createSession,
}));

import { POST } from "@/app/api/auth/login/route";
import { MAX_FAILED_ATTEMPTS } from "@/lib/lockout";

// The burst limiter is module-level and shared across the file, so every test
// signs in as a different address.
let n = 0;
const uniqueEmail = () => `alice${n++}-${Date.now()}@example.com`;

function login(email: string, password = "pw", ip = `10.0.0.${n % 250}`) {
  return new NextRequest("http://localhost/api/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "cf-connecting-ip": ip,
    },
    body: JSON.stringify({ email, password }),
  });
}

const user = (over: Record<string, unknown> = {}) => ({
  id: "u1",
  email: "alice@example.com",
  name: "Alice",
  passwordHash: "$2b$12$hash",
  failedLoginAttempts: 0,
  lockedUntil: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  db.user.update.mockResolvedValue({});
  db.user.updateMany.mockResolvedValue({ count: 1 });
  db.user.findFirst.mockResolvedValue(null); // unknown-email path falls back to the dummy hash
  authFns.createSession.mockResolvedValue("token");
});

describe("credentials", () => {
  it("401s an unknown email at the same cost as a wrong password (no enumeration by timing)", async () => {
    db.user.findUnique.mockResolvedValue(null);
    authFns.verifyPassword.mockResolvedValue(false);
    const res = await POST(login(uniqueEmail()));
    expect(res.status).toBe(401);
    // The check still runs — against a dummy hash — so the reply is not faster.
    expect(authFns.verifyPassword).toHaveBeenCalledTimes(1);
    expect(authFns.createSession).not.toHaveBeenCalled();
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("401s a wrong password and records the failure", async () => {
    db.user.findUnique.mockResolvedValue(user());
    authFns.verifyPassword.mockResolvedValue(false);
    const res = await POST(login(uniqueEmail()));
    expect(res.status).toBe(401);
    expect(db.user.updateMany).toHaveBeenCalledWith({
      where: { id: "u1", failedLoginAttempts: 0 },
      data: { failedLoginAttempts: 1 },
    });
    expect(authFns.createSession).not.toHaveBeenCalled();
  });

  it("signs in on a correct password and clears the counter", async () => {
    db.user.findUnique.mockResolvedValue(user({ failedLoginAttempts: 3 }));
    authFns.verifyPassword.mockResolvedValue(true);
    const res = await POST(login(uniqueEmail()));
    expect(res.status).toBe(200);
    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: expect.any(Date) },
    });
    expect(authFns.createSession).toHaveBeenCalled();
  });

  it("never returns the password hash", async () => {
    db.user.findUnique.mockResolvedValue(user());
    authFns.verifyPassword.mockResolvedValue(true);
    const body = JSON.stringify(await (await POST(login(uniqueEmail()))).json());
    expect(body).not.toContain("$2b$12$");
    expect(body).not.toContain("passwordHash");
  });
});

describe("lockout", () => {
  it("locks on the configured number of consecutive failures — and answers like any wrong password", async () => {
    db.user.findUnique.mockResolvedValue(
      user({ failedLoginAttempts: MAX_FAILED_ATTEMPTS - 1 }),
    );
    authFns.verifyPassword.mockResolvedValue(false);
    const res = await POST(login(uniqueEmail()));
    // 423 here told a caller without the password that the email exists.
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Invalid credentials");
    expect(db.user.update.mock.calls[0][0].data.lockedUntil).toBeInstanceOf(Date);
  });

  it("refuses a locked account even when the password is correct", async () => {
    db.user.findUnique.mockResolvedValue(
      user({ lockedUntil: new Date(Date.now() + 10 * 60_000) }),
    );
    authFns.verifyPassword.mockResolvedValue(true);
    const res = await POST(login(uniqueEmail()));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Invalid credentials");
    expect(authFns.createSession).not.toHaveBeenCalled();
    expect(db.user.update).not.toHaveBeenCalled(); // the lock is not cleared
  });

  it("gives a locked account the generic 401 on a wrong password, at full bcrypt cost", async () => {
    db.user.findUnique.mockResolvedValue(
      user({ lockedUntil: new Date(Date.now() + 10 * 60_000) }),
    );
    authFns.verifyPassword.mockResolvedValue(false);
    const res = await POST(login(uniqueEmail()));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Invalid credentials");
    expect(authFns.verifyPassword).toHaveBeenCalledTimes(1);
    // A locked account's counter and lock are left exactly as they were.
    expect(db.user.update).not.toHaveBeenCalled();
    expect(db.user.updateMany).not.toHaveBeenCalled();
    expect(authFns.createSession).not.toHaveBeenCalled();
  });

  it("lets a lock that has expired through", async () => {
    db.user.findUnique.mockResolvedValue(
      user({ lockedUntil: new Date(Date.now() - 1000) }),
    );
    authFns.verifyPassword.mockResolvedValue(true);
    expect((await POST(login(uniqueEmail()))).status).toBe(200);
  });
});

describe("failing closed", () => {
  it("500s rather than signing in when the lockout store cannot be read", async () => {
    db.user.findUnique.mockRejectedValue(new Error("connection refused"));
    const res = await POST(login(uniqueEmail()));
    expect(res.status).toBe(500);
    expect(authFns.createSession).not.toHaveBeenCalled();
  });

  it("500s rather than signing in when the failure cannot be recorded", async () => {
    db.user.findUnique.mockResolvedValue(user());
    authFns.verifyPassword.mockResolvedValue(false);
    db.user.updateMany.mockRejectedValue(new Error("read-only transaction"));
    const res = await POST(login(uniqueEmail()));
    expect(res.status).toBe(500);
  });

  it("never leaks the database error to the caller", async () => {
    db.user.findUnique.mockRejectedValue(new Error("password authentication failed"));
    const body = JSON.stringify(await (await POST(login(uniqueEmail()))).json());
    expect(body).not.toContain("password authentication");
  });
});

describe("input handling", () => {
  it("400s a body that is not a valid login", async () => {
    const res = await POST(login("not-an-email"));
    expect(res.status).toBe(400);
  });

  it("throttles repeated attempts from one address", async () => {
    db.user.findUnique.mockResolvedValue(null);
    const ip = "203.0.113.9";
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      codes.push((await POST(login(uniqueEmail(), "pw", ip))).status);
    }
    expect(codes).toContain(429);
  });
});
