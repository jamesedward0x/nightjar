/**
 * Structured single-line JSON logging with request ids and timings.
 *
 * Server-side only. Two rules are enforced here rather than by convention:
 *   1. Any field whose NAME looks secret is redacted before it can be printed.
 *   2. A log line is always one JSON object, so it survives Vercel's log drain.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

const SEVERITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Matches the field names we must never print. The Qwen key is the only real secret. */
const REDACT = /key|token|secret|authorization|password|bearer|cookie/i;

function threshold(): number {
  const raw = (process.env.NIGHTJAR_LOG_LEVEL ?? "info").toLowerCase() as LogLevel;
  return SEVERITY[raw] ?? SEVERITY.info;
}

function redact(fields: LogFields): LogFields {
  let dirty = false;
  const out: LogFields = {};
  for (const [name, value] of Object.entries(fields)) {
    if (REDACT.test(name)) {
      out[name] = "[redacted]";
      dirty = true;
    } else {
      out[name] = value;
    }
  }
  return dirty ? out : fields;
}

/** Stable-enough message from anything throwable, without leaking stack noise into logs. */
export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function newRequestId(): string {
  return globalThis.crypto.randomUUID();
}

export interface Logger {
  readonly scope: string;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(scope: string, fields?: LogFields): Logger;
}

function emit(level: LogLevel, scope: string, base: LogFields, message: string, fields?: LogFields): void {
  if (SEVERITY[level] < threshold()) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    scope,
    message,
    ...redact({ ...base, ...(fields ?? {}) }),
  };
  const text = JSON.stringify(line);
  if (level === "error") console.error(text);
  else if (level === "warn") console.warn(text);
  else console.log(text);
}

export function createLogger(scope: string, base: LogFields = {}): Logger {
  return {
    scope,
    debug: (message, fields) => emit("debug", scope, base, message, fields),
    info: (message, fields) => emit("info", scope, base, message, fields),
    warn: (message, fields) => emit("warn", scope, base, message, fields),
    error: (message, fields) => emit("error", scope, base, message, fields),
    child: (childScope, fields) => createLogger(scope + "." + childScope, { ...base, ...(fields ?? {}) }),
  };
}

export const logger = createLogger("nightjar");

/** Measure an async operation without changing its result or its throw behaviour. */
export async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - started };
}
