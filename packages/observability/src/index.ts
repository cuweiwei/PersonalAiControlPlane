const SENSITIVE_KEY = /(token|secret|password|authorization|cookie|private[_-]?key)/i;
const MAX_STRING_LENGTH = 2_000;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[REDACTED_DEPTH]";
  if (typeof value === "string") return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}...[TRUNCATED]` : value;
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, SENSITIVE_KEY.test(key) ? "[REDACTED]" : redact(child, depth + 1)]));
  return "[REDACTED]";
}

export function logEvent(level: "debug" | "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ level, event, ...redact(fields) as Record<string, unknown>, observed_at: new Date().toISOString() })}\n`);
}
