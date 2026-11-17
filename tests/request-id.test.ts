import { beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { SignJWT } from "jose";

// The proxy stamps a fresh x-request-id on EVERY request it passes on — public
// ones included — and never keeps one the client sent.

const SECRET = "test-secret-that-is-at-least-thirty-two-characters-long";
let proxy: (req: NextRequest) => Promise<Response>;

beforeAll(async () => {
  process.env.JWT_SECRET = SECRET;
  ({ proxy } = await import("@/proxy"));
});

const BASE = "http://127.0.0.1:3000";
const UUID = /^[0-9a-f-]{36}$/;

function req(path: string, init: { method?: string; headers?: Record<string, string>; cookie?: string } = {}) {
  const headers = new Headers({ host: "127.0.0.1:3000", ...init.headers });
  if (init.cookie) headers.set("cookie", `spendtrack_session=${init.cookie}`);
  return new NextRequest(`${BASE}${path}`, { method: init.method ?? "GET", headers });
}

describe("x-request-id", () => {
  it("is set on a public page and on the login route", async () => {
    for (const path of ["/", "/login", "/api/health"]) {
      const res = await proxy(req(path));
      expect(res.headers.get("x-middleware-next")).toBe("1");
      expect(res.headers.get("x-middleware-request-x-request-id")).toMatch(UUID);
    }
  });

  it("is set on a signed-in request next to the nonce", async () => {
    const token = await new SignJWT({ userId: "u1", email: "alice@example.com" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode(SECRET));
    const res = await proxy(req("/dashboard", { cookie: token }));
    expect(res.headers.get("x-middleware-request-x-request-id")).toMatch(UUID);
    expect(res.headers.get("content-security-policy")).toMatch(/nonce-/);
  });

  it("never keeps a request id the client sent", async () => {
    const res = await proxy(req("/login", { headers: { "x-request-id": "chosen-by-the-client" } }));
    const id = res.headers.get("x-middleware-request-x-request-id");
    expect(id).toMatch(UUID);
    expect(id).not.toBe("chosen-by-the-client");
  });

  it("still refuses a login POST without an Origin before any id is issued", async () => {
    expect((await proxy(req("/api/auth/login", { method: "POST" }))).status).toBe(403);
  });
});

describe("Host allowlist", () => {
  it("421 for an unknown or missing Host; loopback + container hosts pass; ALLOWED_HOSTS overrides", async () => {
    expect((await proxy(req("/api/health", { headers: { host: "evil.example" } }))).status).toBe(421);
    expect((await proxy(req("/login", { headers: { host: "evil.example" } }))).status).toBe(421);
    const noHost = req("/api/health");
    noHost.headers.delete("host");
    expect((await proxy(noHost)).status).toBe(421);
    for (const host of ["127.0.0.1:3000", "localhost:3000"]) {
      expect((await proxy(req("/api/health", { headers: { host } }))).status, host).not.toBe(421);
    }
    process.env.ALLOWED_HOSTS = "other.example:1";
    try {
      expect((await proxy(req("/api/health"))).status).toBe(421);
      expect((await proxy(req("/api/health", { headers: { host: "other.example:1" } }))).status).not.toBe(421);
    } finally {
      delete process.env.ALLOWED_HOSTS;
    }
  });
});
