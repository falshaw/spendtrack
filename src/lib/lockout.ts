/**
 * Durable per-account login lockout.
 *
 * The in-memory throttle in `ratelimit.ts` is a per-minute burst guard and it
 * resets on every container restart — so on its own it never actually locked
 * anything out. This lives on the `users` row, so a lockout survives a restart
 * and cannot be cleared by bouncing the app.
 *
 * Fail-closed by construction: every helper here lets its database error
 * propagate, and the login route's catch turns that into a 500 without issuing
 * a session. A lockout store that cannot be read must never mean "let them in".
 */
import { prisma } from "./prisma";

/** Consecutive failures that trip the lock. */
export const MAX_FAILED_ATTEMPTS = 5;
/** How long the account stays locked once tripped. */
export const LOCKOUT_MS = 15 * 60 * 1000;

export interface LockState {
  locked: boolean;
  /** Whole minutes remaining, rounded up — never 0 while still locked. */
  minutesLeft: number;
}

/** Is this account currently locked? Call BEFORE verifying the password. */
export function lockState(
  lockedUntil: Date | null | undefined,
  now: Date = new Date(),
): LockState {
  if (!lockedUntil || lockedUntil <= now) return { locked: false, minutesLeft: 0 };
  return {
    locked: true,
    minutesLeft: Math.max(1, Math.ceil((lockedUntil.getTime() - now.getTime()) / 60_000)),
  };
}

/**
 * Record a failed attempt. Returns the state the account is now in, so the
 * caller can tell the user the attempt that just tripped the lock did so.
 */
export async function registerFailure(
  userId: string,
  currentAttempts: number,
  now: Date = new Date(),
): Promise<LockState> {
  const attempts = currentAttempts + 1;
  if (attempts >= MAX_FAILED_ATTEMPTS) {
    const lockedUntil = new Date(now.getTime() + LOCKOUT_MS);
    // Counter back to 0: it starts again from scratch after the lock expires.
    await prisma.user.update({
      where: { id: userId },
      data: { failedLoginAttempts: 0, lockedUntil },
    });
    return lockState(lockedUntil, now);
  }
  // Guarded write: advance the counter only from the value this request read.
  // Two failures racing on one account would otherwise both write N+1 and one
  // would be lost, so the lock would arrive a request late.
  const guarded = await prisma.user.updateMany({
    where: { id: userId, failedLoginAttempts: currentAttempts },
    data: { failedLoginAttempts: attempts },
  });
  if (guarded.count === 0) {
    const fresh = await prisma.user.findUnique({
      where: { id: userId },
      select: { failedLoginAttempts: true, lockedUntil: true },
    });
    if (!fresh) return { locked: false, minutesLeft: 0 };
    const already = lockState(fresh.lockedUntil, now);
    if (already.locked) return already;
    return registerFailure(userId, fresh.failedLoginAttempts, now);
  }
  return { locked: false, minutesLeft: 0 };
}

/** Clear the counter and stamp the sign-in time after a successful sign-in. */
export async function clearFailures(userId: string, now: Date = new Date()): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: now },
  });
}
