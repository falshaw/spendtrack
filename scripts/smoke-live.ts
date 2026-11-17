/**
 * Live smoke test against the RUNNING container (the baked image, not the source):
 *
 *   npm run test:live   # reads DATABASE_URL + JWT_SECRET from .env
 *   SMOKE_BASE=http://127.0.0.1:3000 npx tsx scripts/smoke-live.ts
 *
 * Mints a 10-minute session the way the app does (HS256 JWT in the cookie, sha256 of
 * it in `sessions`), loads every page, fails on a non-200, an error boundary or a
 * suspiciously small body, then deletes the session. The password is never needed.
 *
 * Why it exists: `healthy` proves /api/health answers, nothing more — a page can
 * throw for every user while the container stays green (a column rename breaks a
 * page until the image is rebuilt). A 307 to /login proves nothing either; the
 * proxy redirects unknown routes too.
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { SignJWT } from "jose";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:3000";
const dbUrl = process.env.DATABASE_URL ?? "";
const secret = process.env.JWT_SECRET;
if (!dbUrl || !secret) {
  console.error("DATABASE_URL and JWT_SECRET are required (both are in .env)");
  process.exit(2);
}

const PAGES = [
  "dashboard", "dashboard?scope=personal", "dashboard?scope=business",
  "accounts", "balances", "transactions", "budgets", "recurring", "income", "reports", "categories",
  "receipts", "rules", "goals", "net-worth",
];
const ERROR_MARKERS = /Application error|Something went wrong|Internal Server Error|NEXT_NOT_FOUND/i;

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: dbUrl }) });

async function main() {
  const user = await prisma.user.findFirstOrThrow({ select: { id: true, email: true } });
  const token = await new SignJWT({ userId: user.id, email: user.email })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(secret));
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      token: createHash("sha256").update(token).digest("hex"),
      expiresAt: new Date(Date.now() + 10 * 60_000),
      userAgent: "smoke-live",
    },
  });
  const cookie = `spendtrack_session=${token}`;
  let bad = 0;
  try {
    for (const p of PAGES) {
      const res = await fetch(`${BASE}/${p}`, { headers: { cookie }, redirect: "manual" });
      const html = await res.text();
      const ok = res.status === 200 && !ERROR_MARKERS.test(html) && html.length > 3000;
      if (!ok) bad++;
      console.log(`${ok ? "ok  " : "FAIL"} ${res.status} ${String(html.length).padStart(7)}  /${p}`);
    }
    const anon = await fetch(`${BASE}/dashboard`, { redirect: "manual" });
    const gated = anon.status >= 300 && anon.status < 400;
    if (!gated) bad++;
    console.log(`${gated ? "ok  " : "FAIL"} ${anon.status}          /dashboard without a session must redirect`);
  } finally {
    await prisma.session.delete({ where: { id: session.id } });
    await prisma.$disconnect();
  }
  console.log(bad ? `\n${bad} check(s) FAILED` : `\nall ${PAGES.length + 1} checks passed; smoke session deleted`);
  process.exitCode = bad ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
