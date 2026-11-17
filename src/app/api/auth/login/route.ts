import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyPassword, createSession } from "@/lib/auth";
import { parseRequest, LoginSchema } from "@/lib/validators";
import { enforce, clientIp } from "@/lib/ratelimit";
import { logError, logInfo, logWarn, requestIdOf } from "@/lib/logger";
import {
  clearFailures,
  lockState,
  registerFailure,
} from "@/lib/lockout";

// Fallback for the unknown-email path when the users table is empty: a real
// bcrypt hash (cost 12) of a throwaway string. The result is never used.
const DUMMY_HASH = "$2b$12$VBKUNbVT68YoNR3PXd.mE./9q9TY8eqzqxDiJO6DXPPJJSD2XwwOi";

export async function POST(request: NextRequest) {
  const requestId = requestIdOf(request);
  try {
    const rlIp = clientIp(request.headers);
    const ipLimited = enforce(`login:ip:${rlIp}`, 10, 60000);
    if (ipLimited) return ipLimited;

    const parsed = await parseRequest(LoginSchema, request);
    if (!parsed.success) return parsed.response;
    const { email, password } = parsed.data;

    const emailLimited = enforce(`login:email:${email.toLowerCase().trim()}`, 5, 60000);
    if (emailLimited) return emailLimited;

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      // Same cost as a wrong password on a real account, so a caller cannot time
      // which emails exist. The cost that matters is the one baked into the STORED
      // hash, and a stored hash may use a different cost than BCRYPT_COST — so verify
      // against a stored hash and discard the result; the dummy only covers an empty
      // users table.
      const any = await prisma.user.findFirst({ select: { passwordHash: true } });
      await verifyPassword(password, any?.passwordHash ?? DUMMY_HASH);
      logWarn("login failed: unknown account", { route: "/api/auth/login", requestId });
      return NextResponse.json(
        { error: "Invalid credentials" },
        { status: 401 },
      );
    }

    // While the account is locked every caller gets the same generic 401, whatever
    // the password: answering differently for the right password turned the lock
    // into a password oracle (keep guessing during the lock, wait for the 423).
    // bcrypt still runs so timing matches the unlocked path; its result is unused.
    const locked = lockState(user.lockedUntil);
    if (locked.locked) {
      await verifyPassword(password, user.passwordHash);
      logWarn("login refused: account locked", { route: "/api/auth/login", userId: user.id, requestId });
      return NextResponse.json(
        { error: "Invalid credentials" },
        { status: 401 },
      );
    }
    const passwordOk = await verifyPassword(password, user.passwordHash);

    if (!passwordOk) {
      // The attempt that trips the lock reads like any other wrong password.
      const after = await registerFailure(user.id, user.failedLoginAttempts);
      logWarn(after.locked ? "login failed: lock tripped" : "login failed: wrong password", { route: "/api/auth/login", userId: user.id, requestId });
      return NextResponse.json(
        { error: "Invalid credentials" },
        { status: 401 },
      );
    }

    await clearFailures(user.id);

    const userAgent = request.headers.get("user-agent") ?? undefined;
    const ipKey = clientIp(request.headers);
    const ip = ipKey === "local" || ipKey === "unknown" ? undefined : ipKey;
    await createSession(user.id, user.email, userAgent, ip);
    logInfo("login ok", { route: "/api/auth/login", userId: user.id, requestId });

    return NextResponse.json({
      user: { id: user.id, email: user.email, name: user.name },
    });
  } catch (err) {
    // Fail-closed: anything that stops us reading or writing the lockout state
    // ends the request without a session.
    logError("login failed closed", { route: "/api/auth/login", requestId, err });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
