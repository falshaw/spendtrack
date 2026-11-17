import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isWeakSecret } from "@/lib/weak-secret";

describe("isWeakSecret", () => {
  it("refuses every secret value shipped in .env.example", () => {
    const env = readFileSync(".env.example", "utf8");
    const values = env
      .split("\n")
      .filter((l) => /^(POSTGRES_PASSWORD|SPENDTRACK_APP_DB_PASSWORD|JWT_SECRET|SEED_ADMIN_PASSWORD|PARSER_TOKEN)=/.test(l))
      .map((l) => l.slice(l.indexOf("=") + 1));
    expect(values).toHaveLength(5);
    for (const v of values) expect(isWeakSecret(v, 12)).toBe(true);
  });

  it("refuses missing and short values", () => {
    expect(isWeakSecret(undefined, 12)).toBe(true);
    expect(isWeakSecret("", 12)).toBe(true);
    expect(isWeakSecret("a1b2c3d4e5", 12)).toBe(true);
  });

  it("accepts a long random value", () => {
    expect(isWeakSecret("9f86d081884c7d659a2feaa0c55ad015", 16)).toBe(false);
  });
});
