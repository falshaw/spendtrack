import { prisma } from "./prisma";
import { setDailyRates, dailyRatesInfo } from "./currency";
import { logError } from "./logger";
import { ECB_DAILY_URL, ECB_HIST_90D_URL, businessDaysSince, parseEcbXml, refreshModeFor, type EcbRate } from "./ecb";

/**
 * Server-side bridge between the `fx_rates` table and the pure lookup in
 * currency.ts. Every server entry point that converts money awaits
 * `ensureFxRates()` first; the table is re-read at most every TTL, and a failed
 * read leaves the previous rates (or the static table) in place — FX must never
 * take a page down.
 */
const TTL_MS = 10 * 60_000;
let loadedAt = 0;
let inflight: Promise<void> | null = null;

export async function ensureFxRates(force = false): Promise<void> {
  if (!force && Date.now() - loadedAt < TTL_MS) return;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const rows = await prisma.fxRate.findMany({ select: { currency: true, date: true, perEur: true } });
      setDailyRates(
        rows.map((r) => ({
          currency: r.currency,
          date: r.date.toISOString().slice(0, 10),
          perEur: Number(r.perEur.toString()),
        })),
      );
      loadedAt = Date.now();
    } catch (err) {
      logError("fx rate load failed — static table stays in use", { err });
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export { dailyRatesInfo };

/** Upsert ECB rows. Returns how many rows were written. */
export async function saveRates(rates: EcbRate[]): Promise<number> {
  let n = 0;
  // Chunked so one 90-day backfill (~2,000 rows) is a handful of statements, not 2,000.
  for (let i = 0; i < rates.length; i += 200) {
    const chunk = rates.slice(i, i + 200);
    await prisma.$transaction(
      chunk.map((r) =>
        prisma.fxRate.upsert({
          where: { currency_date: { currency: r.currency, date: new Date(r.date + "T00:00:00Z") } },
          create: { currency: r.currency, date: new Date(r.date + "T00:00:00Z"), perEur: r.perEur.toString(), source: "ECB" },
          update: { perEur: r.perEur.toString(), source: "ECB" },
        }),
      ),
    );
    n += chunk.length;
  }
  return n;
}

/** Fetch an ECB feed and store it. `hist90` backfills the last ~90 business days. */
export async function fetchAndSaveEcb(mode: "daily" | "hist90"): Promise<{ rows: number; dates: number; latest: string | null }> {
  const url = mode === "hist90" ? ECB_HIST_90D_URL : ECB_DAILY_URL;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`ECB feed answered HTTP ${res.status}`);
  const rates = parseEcbXml(await res.text());
  const rows = await saveRates(rates);
  const dates = new Set(rates.map((r) => r.date));
  await ensureFxRates(true);
  return { rows, dates: dates.size, latest: [...dates].sort().pop() ?? null };
}

// ─── Auto-refresh (F8) ───────────────────────────────────
// Called without `await` from the (app) layout, so every page view can top the
// table up when it has fallen behind — but at most one fetch at a time and at most
// one attempt per 6 hours, and a failure only logs: the container may have no
// outbound network at all, which is what `npm run fx:update` on the host is for.

export const ECB_REFRESH_COOLDOWN_MS = 6 * 60 * 60_000;

export interface EcbRefreshState {
  /** ISO time of the last attempt (null = none since the process started). */
  lastAttemptAt: string | null;
  /** The last attempt's error, cleared by a success. */
  lastError: string | null;
  /** Newest fixing date in the table at the last check. */
  latest: string | null;
  /** Business days missing at the last check. */
  gapDays: number | null;
}

let refreshState: EcbRefreshState = { lastAttemptAt: null, lastError: null, latest: null, gapDays: null };
let refreshInflight: Promise<void> | null = null;
let lastAttemptMs = 0;
let lastCheckMs = 0;
const CHECK_TTL_MS = 10 * 60_000; // the staleness query itself runs at most every 10 min

export function ecbRefreshState(): EcbRefreshState {
  return { ...refreshState };
}

/** Tests only: forget the cooldown and the last result. */
export function resetEcbRefreshForTests(): void {
  refreshState = { lastAttemptAt: null, lastError: null, latest: null, gapDays: null };
  refreshInflight = null;
  lastAttemptMs = 0;
  lastCheckMs = 0;
}

/**
 * Fetch the ECB feed when the newest stored fixing is more than 3 TARGET business
 * days old. Never throws. Resolves when the check (and any fetch) is done.
 */
export function maybeRefreshEcb(now: Date = new Date()): Promise<void> {
  if (refreshInflight) return refreshInflight;
  if (lastAttemptMs && now.getTime() - lastAttemptMs < ECB_REFRESH_COOLDOWN_MS) return Promise.resolve();
  if (lastCheckMs && now.getTime() - lastCheckMs < CHECK_TTL_MS) return Promise.resolve();
  lastCheckMs = now.getTime();
  refreshInflight = (async () => {
    try {
      const agg = await prisma.fxRate.aggregate({ _max: { date: true } });
      const latest = agg._max.date ? agg._max.date.toISOString().slice(0, 10) : null;
      const today = now.toISOString().slice(0, 10);
      const gap = latest ? businessDaysSince(latest, today) : Number.POSITIVE_INFINITY;
      refreshState = { ...refreshState, latest, gapDays: Number.isFinite(gap) ? gap : null };
      const mode = refreshModeFor(gap);
      if (!mode) return;
      lastAttemptMs = now.getTime();
      refreshState.lastAttemptAt = now.toISOString();
      try {
        const r = await fetchAndSaveEcb(mode);
        const gapAfter = r.latest ? businessDaysSince(r.latest, today) : gap;
        refreshState = { ...refreshState, lastError: null, latest: r.latest ?? latest, gapDays: Number.isFinite(gapAfter) ? gapAfter : null };
      } catch (err) {
        refreshState.lastError = err instanceof Error ? err.message : String(err);
        logError("ECB auto-refresh failed — run `npm run fx:update` on the host", { err });
      }
    } catch (err) {
      logError("ECB staleness check failed", { err });
    } finally {
      refreshInflight = null;
    }
  })();
  return refreshInflight;
}
