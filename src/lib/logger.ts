/**
 * One JSON line per event on stdout/stderr, so `docker logs spendtrack-app`
 * is greppable. Without it a Prisma error in a CRUD route becomes a bare 500
 * with no trace of which route or why.
 *
 * Deliberately tiny — no transports, no levels config. Never pass request
 * bodies or tokens in `fields`.
 */
type Level = "info" | "warn" | "error";

interface LogFields {
  route?: string;
  userId?: string;
  err?: unknown;
  [key: string]: unknown;
}

function serialiseError(err: unknown) {
  if (err instanceof Error) {
    // Prisma errors carry a `code` (P2002, P2025…) that is worth keeping.
    const code = (err as { code?: unknown }).code;
    return { name: err.name, message: err.message, ...(code ? { code } : {}) };
  }
  return { message: String(err) };
}

function emit(level: Level, msg: string, fields: LogFields = {}) {
  const { err, ...rest } = fields;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...rest,
    ...(err === undefined ? {} : { err: serialiseError(err) }),
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logInfo = (msg: string, fields?: LogFields) => emit("info", msg, fields);
export const logWarn = (msg: string, fields?: LogFields) => emit("warn", msg, fields);
export const logError = (msg: string, fields?: LogFields) => emit("error", msg, fields);

/** The correlation id `proxy.ts` puts on every request — pass it as `requestId` in log fields. */
export function requestIdOf(request: Request): string | undefined {
  return request.headers.get("x-request-id") ?? undefined;
}
