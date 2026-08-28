import { canonicalJson, sha256, type JsonValue } from "../../crypto/src/index.ts";

const SECRET_KEY = /(secret|token|password|api[_-]?key|authorization|cookie|private[_-]?key|recovery|grant)/i;
const MAX_STRING = 2_000;

export function redact(value: unknown, depth = 0): JsonValue {
  if (depth > 8) return "[REDACTED_DEPTH]";
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[TRUNCATED]` : value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, SECRET_KEY.test(key) ? "[REDACTED]" : redact(child, depth + 1)]));
  }
  return "[REDACTED]";
}

export type SafeLogEvent = { level: "debug" | "info" | "warn" | "error"; event: string; requestId?: string; fields: Record<string, JsonValue>; observedAt: string };
export function safeLog(level: SafeLogEvent["level"], event: string, fields: Record<string, unknown>, requestId?: string, now = Date.now()): SafeLogEvent { return { level, event, requestId, fields: redact(fields) as Record<string, JsonValue>, observedAt: new Date(now).toISOString() }; }
export function logDigest(event: SafeLogEvent): string { return sha256(canonicalJson(event as unknown as JsonValue)); }

export class CounterRegistry {
  private readonly counters = new Map<string, number>();
  increment(name: string, labels: Record<string, string> = {}, amount = 1): number { if (!name || amount < 0) throw new Error("metric increment is invalid"); const key = `${name}{${Object.entries(labels).sort().map(([k, v]) => `${k}=${v}`).join(",")}}`; const value = (this.counters.get(key) ?? 0) + amount; this.counters.set(key, value); return value; }
  snapshot(): Record<string, number> { return Object.fromEntries(this.counters); }
}
