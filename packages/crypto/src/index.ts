import { createHash, randomBytes } from "node:crypto";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function sortValue(value: JsonValue): JsonValue {
  if (value === undefined) throw new Error("canonical JSON cannot encode undefined");
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, sortValue(child as JsonValue)]),
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("canonical JSON requires finite numbers");
  return value;
}

/** Deterministic JSON for v1 digests; object keys use code-unit ordering and arrays retain order. */
export function canonicalJson(value: JsonValue): string {
  const serialized = JSON.stringify(sortValue(value));
  if (serialized === undefined) throw new Error("canonical JSON cannot encode undefined");
  return serialized;
}

export function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function randomId(): string {
  return randomBytes(16).toString("hex");
}

/** UUIDv7-shaped ID with millisecond ordering and cryptographically random tail. */
export function uuidv7(nowMs = Date.now()): string {
  const bytes = randomBytes(16);
  const timestamp = BigInt(nowMs) & 0xffffffffffffn;
  for (let index = 0; index < 6; index += 1) {
    bytes[index] = Number((timestamp >> BigInt(40 - index * 8)) & 0xffn);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
