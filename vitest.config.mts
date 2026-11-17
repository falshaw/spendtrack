import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // finance.ts imports the Prisma client at module level; the client never
    // connects in these tests but the adapter wants a connection string.
    env: {
      DATABASE_URL: "postgresql://test:test@127.0.0.1:5432/test",
      // The login tests isolate their rate-limit buckets by header; that only
      // works when the limiter trusts forwarded headers (behind-a-proxy mode).
      TRUST_PROXY: "1",
    },
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary"],
      // Scope: the logic and the API contracts. `src/components/**` and
      // `src/app/(app)/**` are React rendering with no component-test harness
      // here — including them would only move the percentage, not the
      // confidence, so they are excluded openly rather than quietly.
      include: ["src/lib/**/*.ts", "src/app/api/**/*.ts"],
      exclude: [
        // A 22-line Prisma singleton; nothing to assert that a mock wouldn't fake.
        "src/lib/prisma.ts",
      ],
      thresholds: {
        lines: 60,
        functions: 60,
        statements: 60,
        // Branch coverage lags on defensive `?? null` paths that only a real
        // database can produce; held at a level that still catches a regression.
        branches: 55,
      },
    },
  },
});
