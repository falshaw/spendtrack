import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";
import { isWeakSecret } from "../src/lib/weak-secret";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

type Group = "INCOME" | "NEEDS" | "WANTS" | "SAVINGS";

// Default starter categories — no budgets, no transactions. The user sets
// their own monthly caps and enters/imports real data.
// `exclude` = money movement (own-account transfers, broker funding): kept out of
// every spend/income/budget total. The slugs match the keyword map in
// src/lib/categorise.ts, so imported rows land in these on their own.
const CATS: { slug: string; name: string; group: Group; color: string; exclude?: boolean }[] = [
  { slug: "salary", name: "Salary", group: "INCOME", color: "#008a9e" },
  { slug: "other-income", name: "Other Income", group: "INCOME", color: "#5a9a2c" },
  { slug: "rent", name: "Rent", group: "NEEDS", color: "#e2553c" },
  { slug: "groceries", name: "Groceries", group: "NEEDS", color: "#008a9e" },
  { slug: "utilities", name: "Utilities", group: "NEEDS", color: "#b97800" },
  { slug: "transport", name: "Transport", group: "NEEDS", color: "#7d4fb0" },
  { slug: "fuel", name: "Fuel", group: "NEEDS", color: "#a59c8e" },
  { slug: "insurance", name: "Insurance", group: "NEEDS", color: "#2f62b8" },
  { slug: "tax", name: "Tax", group: "NEEDS", color: "#a59c8e" },
  { slug: "fees", name: "Fees", group: "NEEDS", color: "#a59c8e" },
  { slug: "health", name: "Health", group: "NEEDS", color: "#a59c8e" },
  { slug: "dining", name: "Dining Out", group: "WANTS", color: "#5a9a2c" },
  { slug: "entertainment", name: "Entertainment", group: "WANTS", color: "#d64f8a" },
  { slug: "shopping", name: "Shopping", group: "WANTS", color: "#9a5a2a" },
  { slug: "subscriptions", name: "Subscriptions", group: "WANTS", color: "#a59c8e" },
  { slug: "travel", name: "Travel", group: "WANTS", color: "#a59c8e" },
  { slug: "cash", name: "Cash", group: "WANTS", color: "#a59c8e" },
  { slug: "savings", name: "Savings", group: "SAVINGS", color: "#5a9a2c" },
  { slug: "transfers", name: "Transfers", group: "SAVINGS", color: "#a59c8e", exclude: true },
];

function dbUrlPassword(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return decodeURIComponent(new URL(url).password) || undefined;
  } catch {
    return undefined;
  }
}

async function main() {
  // ── Refuse placeholder secrets ────────────────────────────────────
  // No default password, and none of the .env.example values either: a stack
  // brought up with only JWT_SECRET changed must not log in with a password that
  // is printed in this repo. Same KNOWN_WEAK list as JWT_SECRET (src/lib/weak-secret.ts).
  const seedPassword = process.env.SEED_ADMIN_PASSWORD;
  if (!seedPassword || isWeakSecret(seedPassword, 12)) {
    throw new Error(
      "SEED_ADMIN_PASSWORD must be set to a strong value (12+ characters, not a placeholder) — the seed has no default password",
    );
  }
  for (const [name, value] of [
    ["the DATABASE_URL password", dbUrlPassword(process.env.DATABASE_URL)],
    ["SPENDTRACK_APP_DB_PASSWORD", process.env.SPENDTRACK_APP_DB_PASSWORD],
  ] as const) {
    // SPENDTRACK_APP_DB_PASSWORD is optional here (only the init container passes it).
    if (name === "SPENDTRACK_APP_DB_PASSWORD" && value === undefined) continue;
    if (isWeakSecret(value, 16)) {
      throw new Error(`${name} is missing or a weak/placeholder value — use 16+ random characters (openssl rand -hex 32)`);
    }
  }
  const passwordHash = await bcrypt.hash(seedPassword, 12);
  const email = process.env.SEED_ADMIN_EMAIL ?? "admin@example.com";
  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: {
      email,
      passwordHash,
      name: "Demo User",
      role: "admin",
    },
  });
  console.log(`✓ user: ${user.email}`);

  // ── Default categories (no budgets) ───────────────────────────────
  for (let i = 0; i < CATS.length; i++) {
    const c = CATS[i];
    await prisma.category.upsert({
      where: { id: `seed-cat-${c.slug}` },
      update: {},
      create: {
        id: `seed-cat-${c.slug}`,
        userId: user.id,
        name: c.name,
        group: c.group,
        color: c.color,
        excludeFromTotals: c.exclude ?? false,
        sortOrder: i,
      },
    });
  }
  console.log(`✓ ${CATS.length} default categories (no budgets, no transactions)`);

  console.log(`\nSeed complete. Login: ${email} with SEED_ADMIN_PASSWORD`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
