/**
 * One weak-value check for every secret the stack is configured with: JWT_SECRET
 * (src/lib/auth.ts, src/proxy.ts), SEED_ADMIN_PASSWORD and the database passwords
 * (prisma/seed.ts). Pure — no Node or Next imports — so the edge proxy and the
 * one-shot seed can both use it. The parser sidecar carries the same list in
 * scripts/statement_service.py (WEAK_MARKERS) for PARSER_TOKEN.
 */

// Substrings of dev/placeholder values, incl. every value in .env.example.
export const KNOWN_WEAK = [
  "changeme",
  "change-me",
  "placeholder",
  "your-secret",
  "min_32_chars",
  "example-secret",
];

/** True when `value` is missing, shorter than `minLength`, or a known placeholder. */
export function isWeakSecret(value: string | undefined | null, minLength: number): boolean {
  if (!value || value.length < minLength) return true;
  const v = value.toLowerCase();
  return KNOWN_WEAK.some((w) => v.includes(w));
}
