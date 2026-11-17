/**
 * Lightweight in-memory rate limiter (single app container; no Redis here).
 * Sliding fixed-window per key. Resets on restart — acceptable as a first line
 * against brute-force / abuse; the durable layer is the per-account lockout in
 * `lockout.ts` (there is no proxy in front of this app).
 */
import { NextResponse } from "next/server";

type Window = { count: number; reset: number };
const buckets = new Map<string, Window>();

export function rateLimit(key: string, max: number, windowMs: number): { ok: boolean; retryAfter: number } {
  const now = Date.now();
  // opportunistic prune to bound memory
  if (buckets.size > 5000) {
    for (const [k, w] of buckets) if (now > w.reset) buckets.delete(k);
  }
  const w = buckets.get(key);
  if (!w || now > w.reset) {
    buckets.set(key, { count: 1, reset: now + windowMs });
    return { ok: true, retryAfter: 0 };
  }
  w.count++;
  if (w.count > max) return { ok: false, retryAfter: Math.ceil((w.reset - now) / 1000) };
  return { ok: true, retryAfter: 0 };
}

/**
 * Rate-limit key for the caller.
 *
 * Forwarded-IP headers only mean something behind a proxy that overwrites them.
 * This app is bound to 127.0.0.1 with nothing in front, so a caller could send
 * a fresh `X-Forwarded-For` per request and get a fresh bucket — every per-IP
 * limit was bypassable by anyone who could reach the port.
 * Trust the headers only when TRUST_PROXY=1 says a proxy is there; otherwise
 * all callers share one bucket, which for a single-user loopback app is the
 * honest limit.
 */
export function clientIp(headers: Headers): string {
  if (process.env.TRUST_PROXY !== "1") return "local";
  return (
    headers.get("cf-connecting-ip") ||
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

export function tooMany(retryAfter: number) {
  return NextResponse.json(
    { error: "Too many requests. Please slow down and try again shortly." },
    { status: 429, headers: { "Retry-After": String(retryAfter) } },
  );
}

/** Convenience: enforce a limit, returning a 429 response or null if allowed. */
export function enforce(key: string, max: number, windowMs: number): NextResponse | null {
  const r = rateLimit(key, max, windowMs);
  return r.ok ? null : tooMany(r.retryAfter);
}

export const MIN = 60_000;
export const HOUR = 3_600_000;
