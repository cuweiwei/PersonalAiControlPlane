import { canonicalJson, sha256, type JsonValue } from "../../crypto/src/index.ts";

export type SystemConfig = {
  schemaVersion: 1;
  deployment: { environment: "development" | "production"; canonicalOrigin: string | null; identityMode: "development" | "passkey" };
  database: { orchestratorPath: string; identityPath: string; archivePath: string };
  worker: { protocolVersion: string; heartbeatIntervalMs: number; staleAfterMs: number };
  scheduler: { offerTtlMs: number; tickMs: number; maxCodexConcurrency: number };
  codex: { forcedLoginMethod: "chatgpt"; allowApiKeyFallback: false };
  conversation: { globalRetentionDays: number | null; warningBytes: number; criticalBytes: number };
  storage: { artifactRoot: string; maxArtifactBytes: number };
};

const requiredTopLevel = ["schemaVersion", "deployment", "database", "worker", "scheduler", "codex", "conversation", "storage"] as const;

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[], scope: string): void { for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${scope}.${key} is not allowed`); }
function stringField(value: unknown, field: string, allowNull = false): string | null { if (allowNull && value === null) return null; if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a non-empty string`); return value; }
function positive(value: unknown, field: string): number { if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`); return value; }
function nonNegativeOrNull(value: unknown, field: string): number | null { if (value === null) return null; if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error(`${field} must be null or a non-negative integer`); return value; }

export function parseSystemConfig(value: unknown): SystemConfig {
  if (!record(value)) throw new Error("system config must be an object");
  rejectUnknown(value, requiredTopLevel, "config");
  if (value.schemaVersion !== 1) throw new Error("config.schemaVersion must be 1");
  for (const field of requiredTopLevel.slice(1)) if (!record(value[field])) throw new Error(`config.${field} must be an object`);
  const deployment = value.deployment as Record<string, unknown>;
  const database = value.database as Record<string, unknown>;
  const worker = value.worker as Record<string, unknown>;
  const scheduler = value.scheduler as Record<string, unknown>;
  const codex = value.codex as Record<string, unknown>;
  const conversation = value.conversation as Record<string, unknown>;
  const storage = value.storage as Record<string, unknown>;
  rejectUnknown(deployment, ["environment", "canonicalOrigin", "identityMode"], "config.deployment");
  rejectUnknown(database, ["orchestratorPath", "identityPath", "archivePath"], "config.database");
  rejectUnknown(worker, ["protocolVersion", "heartbeatIntervalMs", "staleAfterMs"], "config.worker");
  rejectUnknown(scheduler, ["offerTtlMs", "tickMs", "maxCodexConcurrency"], "config.scheduler");
  rejectUnknown(codex, ["forcedLoginMethod", "allowApiKeyFallback"], "config.codex");
  rejectUnknown(conversation, ["globalRetentionDays", "warningBytes", "criticalBytes"], "config.conversation");
  rejectUnknown(storage, ["artifactRoot", "maxArtifactBytes"], "config.storage");
  if (!["development", "production"].includes(deployment.environment as string)) throw new Error("config.deployment.environment is invalid");
  if (!["development", "passkey"].includes(deployment.identityMode as string)) throw new Error("config.deployment.identityMode is invalid");
  const canonicalOrigin = stringField(deployment.canonicalOrigin, "config.deployment.canonicalOrigin", true);
  if (deployment.environment === "production" && (!canonicalOrigin || deployment.identityMode !== "passkey")) throw new Error("production requires canonical origin and Passkey identity mode");
  if (deployment.environment === "production" && [database.orchestratorPath, database.identityPath, database.archivePath, storage.artifactRoot].some((path) => typeof path !== "string" || path.startsWith("./"))) throw new Error("production paths must be explicit persistent paths");
  if (codex.forcedLoginMethod !== "chatgpt" || codex.allowApiKeyFallback !== false) throw new Error("Codex must use ChatGPT login without API-key fallback");
  const globalRetentionDays = nonNegativeOrNull(conversation.globalRetentionDays, "config.conversation.globalRetentionDays");
  const parsed: SystemConfig = {
    schemaVersion: 1,
    deployment: { environment: deployment.environment as SystemConfig["deployment"]["environment"], canonicalOrigin, identityMode: deployment.identityMode as SystemConfig["deployment"]["identityMode"] },
    database: { orchestratorPath: stringField(database.orchestratorPath, "config.database.orchestratorPath")!, identityPath: stringField(database.identityPath, "config.database.identityPath")!, archivePath: stringField(database.archivePath, "config.database.archivePath")! },
    worker: { protocolVersion: stringField(worker.protocolVersion, "config.worker.protocolVersion")!, heartbeatIntervalMs: positive(worker.heartbeatIntervalMs, "config.worker.heartbeatIntervalMs"), staleAfterMs: positive(worker.staleAfterMs, "config.worker.staleAfterMs") },
    scheduler: { offerTtlMs: positive(scheduler.offerTtlMs, "config.scheduler.offerTtlMs"), tickMs: positive(scheduler.tickMs, "config.scheduler.tickMs"), maxCodexConcurrency: positive(scheduler.maxCodexConcurrency, "config.scheduler.maxCodexConcurrency") },
    codex: { forcedLoginMethod: "chatgpt", allowApiKeyFallback: false },
    conversation: { globalRetentionDays, warningBytes: positive(conversation.warningBytes, "config.conversation.warningBytes"), criticalBytes: positive(conversation.criticalBytes, "config.conversation.criticalBytes") },
    storage: { artifactRoot: stringField(storage.artifactRoot, "config.storage.artifactRoot")!, maxArtifactBytes: positive(storage.maxArtifactBytes, "config.storage.maxArtifactBytes") },
  };
  if (parsed.worker.staleAfterMs < parsed.worker.heartbeatIntervalMs * 2) throw new Error("worker staleAfterMs must allow at least two heartbeats");
  if (parsed.conversation.warningBytes >= parsed.conversation.criticalBytes) throw new Error("conversation warningBytes must be below criticalBytes");
  return parsed;
}

export function configDigest(config: SystemConfig): string { return sha256(canonicalJson(config as unknown as JsonValue)); }

export function startupGates(config: SystemConfig, evidence: { identityReady: boolean; databaseReady: boolean; auditChainValid: boolean }): { ready: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!evidence.databaseReady) reasons.push("database-not-ready");
  if (!evidence.auditChainValid) reasons.push("audit-chain-invalid");
  if (config.deployment.environment === "production" && !evidence.identityReady) reasons.push("identity-gateway-not-ready");
  return { ready: reasons.length === 0, reasons };
}
