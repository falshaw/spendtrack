/**
 * The bits that decide who gets in: password hashing, HS256 signing, the burst
 * limiter and the account lockout.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  user: { update: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));

import {
  BCRYPT_COST,
  encodeJwtSecret,
  hashPassword,
  signHs256,
  verifyHs256,
  verifyPassword,
} from "@/lib/auth-core";
import { clientIp, enforce, rateLimit, tooMany, MIN, HOUR } from "@/lib/ratelimit";
import {
  LOCKOUT_MS,
  MAX_FAILED_ATTEMPTS,
  clearFailures,
  lockState,
  registerFailure,
} from "@/lib/lockout";

describe("password hashing", () => {
  it("verifies a correct password and rejects a wrong one", async () => {
    const hash = await hashPassword("correct horse battery staple");
    await expect(verifyPassword("correct horse battery staple", hash)).resolves.toBe(true);
    await expect(verifyPassword("wrong", hash)).resolves.toBe(false);
  });

  it("salts — the same password hashes differently every time", async () => {
    const [a, b] = await Promise.all([hashPassword("same"), hashPassword("same")]);
    expect(a).not.toBe(b);
  });

  it("uses the shared bcrypt work factor", async () => {
    expect(BCRYPT_COST).toBe(12);
    expect(await hashPassword("x")).toMatch(/^\$2[aby]\$12\$/);
  });
});

describe("JWT secret handling", () => {
  it("refuses a missing secret", () => {
    expect(() => encodeJwtSecret(undefined)).toThrow(/required/i);
    expect(() => encodeJwtSecret("")).toThrow(/required/i);
  });

  it("enforces a minimum length when asked", () => {
    expect(() => encodeJwtSecret("short", { minLength: 32 })).toThrow(/at least 32/);
    expect(encodeJwtSecret("x".repeat(32), { minLength: 32 })).toBeInstanceOf(Uint8Array);
  });
});

describe("HS256 tokens", () => {
  const secret = encodeJwtSecret("y".repeat(32), { minLength: 32 });

  it("round-trips a payload", async () => {
    const token = await signHs256({ userId: "u1" }, secret, { jti: "j1" });
    const payload = await verifyHs256(token, secret);
    expect(payload.userId).toBe("u1");
    expect(payload.jti).toBe("j1");
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signHs256({ userId: "u1" }, secret);
    const other = encodeJwtSecret("z".repeat(32), { minLength: 32 });
    await expect(verifyHs256(token, other)).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    const token = await signHs256({ userId: "u1" }, secret, { expiresIn: "-1s" });
    await expect(verifyHs256(token, secret)).rejects.toThrow();
  });

  it("pins the algorithm, so an alg:none token cannot pass", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify({ userId: "attacker" })).toString("base64url");
    await expect(verifyHs256(`${header}.${body}.`, secret)).rejects.toThrow();
  });
});

describe("rate limiter", () => {
  it("allows up to the limit then refuses", () => {
    const key = `test-${Math.random()}`;
    for (let i = 0; i < 3; i++) expect(rateLimit(key, 3, MIN).ok).toBe(true);
    const blocked = rateLimit(key, 3, MIN);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(0);
  });

  it("keeps separate keys separate", () => {
    const a = `a-${Math.random()}`;
    const b = `b-${Math.random()}`;
    expect(rateLimit(a, 1, MIN).ok).toBe(true);
    expect(rateLimit(a, 1, MIN).ok).toBe(false);
    expect(rateLimit(b, 1, MIN).ok).toBe(true);
  });

  it("starts a fresh window once the old one has passed", () => {
    const key = `win-${Math.random()}`;
    expect(rateLimit(key, 1, 1).ok).toBe(true);
    expect(rateLimit(key, 1, 1).ok).toBe(false);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 50);
      expect(rateLimit(key, 1, 1).ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("enforce returns null while allowed and a 429 once not", () => {
    const key = `enf-${Math.random()}`;
    expect(enforce(key, 1, MIN)).toBeNull();
    const res = enforce(key, 1, MIN);
    expect(res?.status).toBe(429);
    expect(res?.headers.get("Retry-After")).toBeTruthy();
  });

  it("tooMany carries Retry-After", () => {
    expect(tooMany(30).headers.get("Retry-After")).toBe("30");
  });

  it("ignores forwarded headers unless TRUST_PROXY=1 (no proxy → one shared bucket)", () => {
    vi.stubEnv("TRUST_PROXY", "");
    try {
      expect(clientIp(new Headers({ "x-forwarded-for": "2.2.2.2" }))).toBe("local");
      expect(clientIp(new Headers({ "cf-connecting-ip": "1.1.1.1" }))).toBe("local");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("prefers the Cloudflare header, then XFF, then unknown", () => {
    expect(clientIp(new Headers({ "cf-connecting-ip": "1.1.1.1", "x-forwarded-for": "2.2.2.2" }))).toBe("1.1.1.1");
    expect(clientIp(new Headers({ "x-forwarded-for": "2.2.2.2, 3.3.3.3" }))).toBe("2.2.2.2");
    expect(clientIp(new Headers())).toBe("unknown");
  });

  it("exports the window constants the routes use", () => {
    expect(MIN).toBe(60_000);
    expect(HOUR).toBe(3_600_000);
  });
});

describe("account lockout", () => {
  const now = new Date("2026-08-30T12:00:00Z");

  beforeEach(() => {
    vi.clearAllMocks();
    db.user.update.mockResolvedValue({});
    db.user.updateMany.mockResolvedValue({ count: 1 });
  });

  it("is unlocked with no lock set or once the lock has passed", () => {
    expect(lockState(null, now).locked).toBe(false);
    expect(lockState(new Date("2026-08-30T11:59:59Z"), now).locked).toBe(false);
  });

  it("reports whole minutes remaining, never rounding down to zero", () => {
    expect(lockState(new Date("2026-08-30T12:14:00Z"), now)).toEqual({
      locked: true,
      minutesLeft: 14,
    });
    // One second left is still locked, and must not read as "0 minutes".
    expect(lockState(new Date("2026-08-30T12:00:01Z"), now).minutesLeft).toBe(1);
  });

  it("counts a failure without locking below the threshold", async () => {
    const state = await registerFailure("u1", 0, now);
    expect(state.locked).toBe(false);
    // Guarded: only advances from the value this request read.
    expect(db.user.updateMany).toHaveBeenCalledWith({
      where: { id: "u1", failedLoginAttempts: 0 },
      data: { failedLoginAttempts: 1 },
    });
  });

  it("re-reads and continues when another request advanced the counter first", async () => {
    db.user.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValue({ count: 1 });
    db.user.findUnique.mockResolvedValue({
      failedLoginAttempts: MAX_FAILED_ATTEMPTS - 1,
      lockedUntil: null,
    });
    const state = await registerFailure("u1", 0, now);
    expect(state.locked).toBe(true);
    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { failedLoginAttempts: 0, lockedUntil: new Date(now.getTime() + LOCKOUT_MS) },
    });
  });

  it("locks on the fifth consecutive failure and resets the counter", async () => {
    const state = await registerFailure("u1", MAX_FAILED_ATTEMPTS - 1, now);
    expect(state.locked).toBe(true);
    expect(state.minutesLeft).toBe(15);
    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: {
        failedLoginAttempts: 0,
        lockedUntil: new Date(now.getTime() + LOCKOUT_MS),
      },
    });
  });

  it("clears the lock on a successful sign-in and records the sign-in time", async () => {
    await clearFailures("u1", now);
    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: now },
    });
  });

  it("fails closed — a database error propagates instead of being swallowed", async () => {
    db.user.update.mockRejectedValue(new Error("db down"));
    db.user.updateMany.mockRejectedValue(new Error("db down"));
    await expect(registerFailure("u1", 0, now)).rejects.toThrow("db down");
    await expect(clearFailures("u1")).rejects.toThrow("db down");
  });
});
