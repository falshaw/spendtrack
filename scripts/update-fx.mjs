#!/usr/bin/env node
/**
 * Pull ECB euro reference rates into `fx_rates`.
 *
 *   node scripts/update-fx.mjs            # today's fixing (eurofxref-daily.xml)
 *   node scripts/update-fx.mjs --hist90   # backfill the last ~90 business days
 *
 * Runs on the HOST against the published Postgres port (DATABASE_URL in .env,
 * host rewritten to 127.0.0.1:15432) — the fallback for when the container has
 * no outbound network. Inside the app the same thing is `POST /api/fx/update`.
 * Upserts, so re-running is a no-op. Free public data, no key.
 *
 * The parser is the app's own `src/lib/ecb.ts`, imported directly (Node 24 strips
 * the types) — one parser for both paths, not a copy that can drift.
 */
import "dotenv/config";
import pg from "pg";
import { ECB_DAILY_URL, ECB_HIST_90D_URL, parseEcbXml } from "../src/lib/ecb.ts";

const hist = process.argv.includes("--hist90");
const url = hist ? ECB_HIST_90D_URL : ECB_DAILY_URL;
const dbUrl = (process.env.DATABASE_URL ?? "").replace(/@[^/]+\//, "@127.0.0.1:15432/");
if (!dbUrl) {
  console.error("DATABASE_URL is required (it is in .env)");
  process.exit(2);
}

const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
if (!res.ok) {
  console.error(`ECB answered HTTP ${res.status} for ${url}`);
  process.exit(1);
}
const rates = parseEcbXml(await res.text());

const client = new pg.Client({ connectionString: dbUrl });
await client.connect();
try {
  await client.query("BEGIN");
  for (const r of rates) {
    await client.query(
      `INSERT INTO fx_rates (currency, date, per_eur, source) VALUES ($1, $2, $3, 'ECB')
       ON CONFLICT (currency, date) DO UPDATE SET per_eur = EXCLUDED.per_eur, source = 'ECB'`,
      [r.currency, r.date, r.perEur],
    );
  }
  await client.query("COMMIT");
} catch (e) {
  await client.query("ROLLBACK").catch(() => {});
  throw e;
} finally {
  await client.end();
}

const dates = [...new Set(rates.map((r) => r.date))].sort();
console.log(
  `fx_rates: upserted ${rates.length} rows — ${dates.length} fixing day(s), ${dates[0]} → ${dates[dates.length - 1]} (${hist ? "90-day history" : "daily"})`,
);
