/**
 * Read-only broker sync. Credentials come from the environment only and are never
 * written to the database; this module only issues GET requests.
 *
 *   Trading 212   TRADING212_API_KEY (+ TRADING212_API_SECRET). Key + secret → HTTP
 *                 Basic auth (the current API keys); a key alone is sent as-is in the
 *                 Authorization header (legacy keys). TRADING212_ENV=demo uses the
 *                 practice account. Create the key with read-only permissions.
 *   IBKR          IBKR_FLEX_TOKEN + IBKR_FLEX_QUERY_ID — a Flex Web Service token and an
 *                 Activity Flex query. A Flex token can only download reports.
 *
 * A broker without credentials is simply "not connected"; its stored data (demo or
 * manual) stays untouched. One broker failing never fails the other, and a history
 * list that fails or is rate limited part-way keeps what was read and says so.
 */
import { prisma } from "./prisma";
import { logWarn } from "./logger";
import {
  type BrokerCode,
  type BrokerSnapshot,
  flexReference,
  mapT212Dividends,
  mapT212Flows,
  mapT212Orders,
  mapT212Snapshot,
  parseFlexStatement,
  t212NextPath,
  type T212Dividend,
  type T212HistoricalOrder,
  type T212Position,
  type T212Summary,
  type T212Transaction,
} from "./broker-map";

const UA = "SpendTrack (self-hosted; read-only portfolio sync)";
const FLEX_BASE = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService";

export const BROKER_LABEL: Record<BrokerCode | "MANUAL", string> = {
  TRADING212: "Trading 212",
  IBKR: "Interactive Brokers",
  MANUAL: "Manual holdings",
};

export interface BrokerConfig {
  broker: BrokerCode;
  configured: boolean;
  /** The env vars to set, for the "not connected" hint. */
  env: string[];
}

export function brokerConfigs(env: NodeJS.ProcessEnv = process.env): BrokerConfig[] {
  return [
    { broker: "TRADING212", configured: !!env.TRADING212_API_KEY?.trim(), env: ["TRADING212_API_KEY", "TRADING212_API_SECRET"] },
    { broker: "IBKR", configured: !!(env.IBKR_FLEX_TOKEN?.trim() && env.IBKR_FLEX_QUERY_ID?.trim()), env: ["IBKR_FLEX_TOKEN", "IBKR_FLEX_QUERY_ID"] },
  ];
}

/**
 * The broker credentials are instance-wide, so only one user may pull them: the one
 * named in BROKER_SYNC_USER_EMAIL, or — when it is unset — the only user of a
 * single-user install. Otherwise another account could copy the owner's broker data.
 */
export async function maySync(userId: string, env: NodeJS.ProcessEnv = process.env): Promise<{ ok: boolean; reason?: string }> {
  const named = env.BROKER_SYNC_USER_EMAIL?.trim().toLowerCase();
  if (named) {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    return u?.email.toLowerCase() === named ? { ok: true } : { ok: false, reason: "Broker sync is limited to the user named in BROKER_SYNC_USER_EMAIL." };
  }
  const users = await prisma.user.count();
  return users <= 1 ? { ok: true } : { ok: false, reason: "This install has several users: set BROKER_SYNC_USER_EMAIL to the one the broker credentials belong to." };
}

export class BrokerError extends Error {
  constructor(message: string, readonly rateLimited = false) {
    super(message);
    this.name = "BrokerError";
  }
}

type Fetch = typeof fetch;

// ─── Trading 212 ────────────────────────────────────────────────────────

export function t212Auth(env: NodeJS.ProcessEnv = process.env): string {
  const key = env.TRADING212_API_KEY?.trim();
  const secret = env.TRADING212_API_SECRET?.trim();
  if (!key) throw new BrokerError("Trading 212 is not configured (TRADING212_API_KEY).");
  return secret ? "Basic " + Buffer.from(`${key}:${secret}`).toString("base64") : key;
}

export function t212Base(env: NodeJS.ProcessEnv = process.env): string {
  return env.TRADING212_ENV?.trim().toLowerCase() === "demo" ? "https://demo.trading212.com/api/v0" : "https://live.trading212.com/api/v0";
}

async function t212Get<T>(path: string, auth: string, base: string, fetchImpl: Fetch): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(`${base}${path}`, {
      headers: { Authorization: auth, "User-Agent": UA, Accept: "application/json" },
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new BrokerError(`Trading 212 is not reachable (${e instanceof Error ? e.message : String(e)}).`);
  }
  if (res.status === 401 || res.status === 403) throw new BrokerError("Trading 212 rejected the API key (check the key, the secret and the key's read permissions).");
  if (res.status === 429) {
    const reset = res.headers.get("x-ratelimit-reset") ?? res.headers.get("retry-after");
    throw new BrokerError(`Trading 212 rate limit reached${reset ? ` (resets at ${reset})` : ""} — try again in a minute.`, true);
  }
  if (!res.ok) throw new BrokerError(`Trading 212 ${path.split("?")[0]} failed: HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Follow `nextPagePath`, bounded. A failure part-way keeps the pages already read. */
async function t212Paged<T>(
  list: "orders" | "dividends" | "transactions",
  auth: string,
  base: string,
  fetchImpl: Fetch,
  notes: string[],
  maxPages = 10,
): Promise<T[]> {
  const items: T[] = [];
  let path: string | null = `/equity/history/${list}?limit=50`;
  let page = 0;
  try {
    for (; page < maxPages && path; page++) {
      const body: { items?: T[]; nextPagePath?: string | null } = await t212Get(path, auth, base, fetchImpl);
      items.push(...(body.items ?? []));
      path = t212NextPath(body.nextPagePath, list);
    }
  } catch (e) {
    notes.push(`Trading 212 ${list}: ${e instanceof Error ? e.message : String(e)}${items.length ? ` — kept ${items.length} read before` : ""}`);
    return items;
  }
  if (path) notes.push(`Trading 212 ${list}: stopped after ${page} pages — older ${list} not fetched`);
  return items;
}

export async function fetchT212(env: NodeJS.ProcessEnv = process.env, fetchImpl: Fetch = fetch): Promise<BrokerSnapshot> {
  const auth = t212Auth(env);
  const base = t212Base(env);
  // Sequential: the summary endpoint allows one request per 5 s, positions one per second.
  const summary = await t212Get<T212Summary>("/equity/account/summary", auth, base, fetchImpl);
  const positions = await t212Get<T212Position[]>("/equity/positions", auth, base, fetchImpl);
  const snap = mapT212Snapshot(summary, Array.isArray(positions) ? positions : [], new Date());
  snap.trades = mapT212Orders(await t212Paged<T212HistoricalOrder>("orders", auth, base, fetchImpl, snap.notes));
  snap.dividends = mapT212Dividends(await t212Paged<T212Dividend>("dividends", auth, base, fetchImpl, snap.notes), snap.baseCurrency);
  snap.flows = mapT212Flows(await t212Paged<T212Transaction>("transactions", auth, base, fetchImpl, snap.notes), snap.baseCurrency);
  return snap;
}

// ─── IBKR Flex ──────────────────────────────────────────────────────────

async function flexGet(url: string, fetchImpl: Fetch): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { "User-Agent": UA }, cache: "no-store", signal: AbortSignal.timeout(45_000) });
  } catch (e) {
    throw new BrokerError(`IBKR Flex is not reachable (${e instanceof Error ? e.message : String(e)}).`);
  }
  if (res.status === 429) throw new BrokerError("IBKR Flex rate limit reached — try again in a minute.", true);
  if (!res.ok) throw new BrokerError(`IBKR Flex HTTP ${res.status}`);
  return res.text();
}

/** Flex error 1018 = too many requests; 1019 = the report is still being generated. */
function flexFail(stage: string, code: string | null, message: string | null): never {
  if (code === "1018") throw new BrokerError("IBKR Flex: too many requests — try again in a few minutes.", true);
  throw new BrokerError(`IBKR Flex ${stage} failed: ${message ?? "unknown error"}${code ? ` (code ${code})` : ""}`);
}

export async function fetchIbkrFlex(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: Fetch = fetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<BrokerSnapshot> {
  const token = env.IBKR_FLEX_TOKEN?.trim();
  const query = env.IBKR_FLEX_QUERY_ID?.trim();
  if (!token || !query) throw new BrokerError("IBKR is not configured (IBKR_FLEX_TOKEN, IBKR_FLEX_QUERY_ID).");

  const req = flexReference(
    await flexGet(`${FLEX_BASE}/SendRequest?t=${encodeURIComponent(token)}&q=${encodeURIComponent(query)}&v=3`, fetchImpl),
  );
  if (!req.ref) flexFail("request", req.code, req.message);

  // The report is generated asynchronously on IBKR's side: poll, bounded.
  for (let attempt = 0; attempt < 8; attempt++) {
    await sleep(attempt === 0 ? 3000 : 5000);
    const body = await flexGet(`${FLEX_BASE}/GetStatement?t=${encodeURIComponent(token)}&q=${req.ref}&v=3`, fetchImpl);
    if (body.includes("<FlexQueryResponse")) return parseFlexStatement(body);
    const r = flexReference(body);
    if (r.code !== "1019") flexFail("statement", r.code, r.message);
  }
  throw new BrokerError("IBKR Flex report still generating — try again in a minute.");
}

// ─── Apply to the database ──────────────────────────────────────────────

export interface SyncResult {
  broker: BrokerCode;
  ok: boolean;
  status: "OK" | "PARTIAL" | "ERROR" | "SKIPPED";
  message: string;
  rateLimited?: boolean;
  positions?: number;
  trades?: number;
  dividends?: number;
  flows?: number;
  totalValue?: number;
  currency?: string;
}

export async function ensureConnection(userId: string, broker: BrokerCode | "MANUAL") {
  return prisma.brokerConnection.upsert({
    where: { userId_broker: { userId, broker } },
    create: { userId, broker, label: BROKER_LABEL[broker] },
    update: {},
  });
}

/**
 * Store one snapshot: holdings replaced, history upserted on the broker's id (a re-sync
 * changes nothing), today's value recorded. An empty position list never wipes stored
 * holdings — an end-of-day Flex report does not yet carry same-day buys.
 */
export async function applySnapshot(userId: string, broker: BrokerCode, snap: BrokerSnapshot): Promise<SyncResult> {
  const conn = await ensureConnection(userId, broker);
  const current = await prisma.investmentHolding.count({ where: { connectionId: conn.id } });
  const keepHoldings = snap.positions.length === 0 && current > 0;
  const notes = [...snap.notes];
  if (keepHoldings) notes.push(`the report has no positions — kept the ${current} stored`);
  const base = { userId, connectionId: conn.id };

  await prisma.$transaction(async (tx) => {
    if (!keepHoldings) {
      await tx.investmentHolding.deleteMany({ where: { connectionId: conn.id } });
      if (snap.positions.length) {
        await tx.investmentHolding.createMany({
          data: mergeSameSymbol(snap.positions).map((p) => ({ ...base, ...p })),
        });
      }
    }
    for (const t of snap.trades) {
      const { externalId, ...data } = t;
      await tx.investmentTrade.upsert({
        where: { connectionId_externalId: { connectionId: conn.id, externalId } },
        create: { ...base, externalId, ...data },
        update: data,
      });
    }
    for (const d of snap.dividends) {
      const { externalId, ...data } = d;
      await tx.investmentDividend.upsert({
        where: { connectionId_externalId: { connectionId: conn.id, externalId } },
        create: { ...base, externalId, ...data },
        update: data,
      });
    }
    if (snap.flows.length) {
      await tx.investmentCashFlow.createMany({ data: snap.flows.map((f) => ({ ...base, ...f })), skipDuplicates: true });
    }
    for (const v of snap.values) {
      await tx.portfolioValue.upsert({
        where: { connectionId_date: { connectionId: conn.id, date: v.date } },
        create: { ...base, date: v.date, value: v.value, cash: v.cash, currency: snap.baseCurrency },
        update: { value: v.value, cash: v.cash, currency: snap.baseCurrency },
      });
    }
    await tx.brokerConnection.update({
      where: { id: conn.id },
      data: {
        baseCurrency: snap.baseCurrency,
        cash: snap.cash,
        totalValue: snap.totalValue,
        asOf: snap.asOf,
        status: notes.length ? "PARTIAL" : "OK",
        lastSyncAt: new Date(),
        lastSyncMessage: notes.length ? notes.join(" · ").slice(0, 1000) : null,
      },
    });
  }, { timeout: 60_000 });

  const counts = `${snap.positions.length} positions, ${snap.trades.length} trades, ${snap.dividends.length} dividends, ${snap.flows.length} cash flows`;
  return {
    broker,
    ok: true,
    status: notes.length ? "PARTIAL" : "OK",
    message: notes.length ? `${counts}. ${notes.join(" · ")}` : `${counts}.`,
    positions: snap.positions.length,
    trades: snap.trades.length,
    dividends: snap.dividends.length,
    flows: snap.flows.length,
    totalValue: snap.totalValue,
    currency: snap.baseCurrency,
  };
}

/** A broker can list one symbol twice (two share classes of one ticker); the table is unique per symbol. */
function mergeSameSymbol<T extends { symbol: string; quantity: number; value: number | null; unrealisedPnl: number | null }>(rows: T[]): T[] {
  const by = new Map<string, T>();
  for (const r of rows) {
    const seen = by.get(r.symbol);
    if (!seen) {
      by.set(r.symbol, { ...r });
      continue;
    }
    seen.quantity += r.quantity;
    seen.value = seen.value == null && r.value == null ? null : (seen.value ?? 0) + (r.value ?? 0);
    seen.unrealisedPnl = seen.unrealisedPnl == null && r.unrealisedPnl == null ? null : (seen.unrealisedPnl ?? 0) + (r.unrealisedPnl ?? 0);
  }
  return [...by.values()];
}

async function recordFailure(userId: string, broker: BrokerCode, message: string) {
  const conn = await ensureConnection(userId, broker);
  await prisma.brokerConnection.update({
    where: { id: conn.id },
    data: { status: "ERROR", lastSyncAt: new Date(), lastSyncMessage: message.slice(0, 1000) },
  });
}

/** Sync the configured brokers (or only `only`). Never throws for a broker failure. */
export async function syncBrokers(
  userId: string,
  only?: BrokerCode,
  deps: { env?: NodeJS.ProcessEnv; fetchT212?: () => Promise<BrokerSnapshot>; fetchIbkr?: () => Promise<BrokerSnapshot> } = {},
): Promise<SyncResult[]> {
  const env = deps.env ?? process.env;
  const fetchers: Record<BrokerCode, () => Promise<BrokerSnapshot>> = {
    TRADING212: deps.fetchT212 ?? (() => fetchT212(env)),
    IBKR: deps.fetchIbkr ?? (() => fetchIbkrFlex(env)),
  };
  const jobs = brokerConfigs(env).filter((c) => !only || c.broker === only);
  return Promise.all(
    jobs.map(async (c): Promise<SyncResult> => {
      if (!c.configured) {
        return { broker: c.broker, ok: false, status: "SKIPPED", message: `not connected — set ${c.env.join(" + ")}` };
      }
      try {
        return await applySnapshot(userId, c.broker, await fetchers[c.broker]());
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        logWarn("broker sync failed", { userId, broker: c.broker, err: e });
        try {
          await recordFailure(userId, c.broker, message);
        } catch (err) {
          logWarn("broker sync status write failed", { userId, broker: c.broker, err });
        }
        return { broker: c.broker, ok: false, status: "ERROR", message, rateLimited: e instanceof BrokerError && e.rateLimited };
      }
    }),
  );
}
