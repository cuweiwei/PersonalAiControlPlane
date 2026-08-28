import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createConsistentFileBackup, markRestoreDrill, verifyBackupManifest } from "../packages/backup/src/index.ts";
import { isCheckpointCompatible, validateCheckpointManifest, type CheckpointManifest } from "../packages/checkpoints/src/index.ts";
import { configDigest, parseSystemConfig, startupGates, type SystemConfig } from "../packages/config/src/index.ts";
import { ComputeBroker, QuotaTracker } from "../packages/compute/src/index.ts";
import { redact, safeLog, CounterRegistry } from "../packages/observability/src/index.ts";

function validConfig(): SystemConfig {
  return { schemaVersion: 1, deployment: { environment: "development", canonicalOrigin: null, identityMode: "development" }, database: { orchestratorPath: ":memory:", identityPath: ":memory:", archivePath: ":memory:" }, worker: { protocolVersion: "1.0", heartbeatIntervalMs: 30_000, staleAfterMs: 90_000 }, scheduler: { offerTtlMs: 15_000, tickMs: 2_000, maxCodexConcurrency: 1 }, codex: { forcedLoginMethod: "chatgpt", allowApiKeyFallback: false }, conversation: { globalRetentionDays: null, warningBytes: 100, criticalBytes: 200 }, storage: { artifactRoot: "/tmp/pai-artifacts", maxArtifactBytes: 1000 } };
}

test("config parser and startup gates fail closed for production", () => {
  const config = parseSystemConfig(validConfig());
  assert.match(configDigest(config), /^sha256:/);
  assert.deepEqual(startupGates(config, { identityReady: false, databaseReady: true, auditChainValid: true }), { ready: true, reasons: [] });
  assert.throws(() => parseSystemConfig({ ...validConfig(), deployment: { environment: "production", canonicalOrigin: null, identityMode: "development" } }), /production requires/);
  assert.deepEqual(startupGates({ ...config, deployment: { environment: "production", canonicalOrigin: "https://pai.tailnet", identityMode: "passkey" } }, { identityReady: false, databaseReady: true, auditChainValid: true }), { ready: false, reasons: ["identity-gateway-not-ready"] });
});

test("observability redacts secrets and keeps metric labels bounded", () => {
  const event = safeLog("info", "test", { token: "secret", nested: { password: "pw", text: "ok" }, long: "x".repeat(2100) }, "req");
  assert.deepEqual(event.fields.token, "[REDACTED]");
  assert.deepEqual((event.fields.nested as Record<string, unknown>).password, "[REDACTED]");
  assert.match(String(event.fields.long), /TRUNCATED/);
  assert.deepEqual(redact({ authorization: "Bearer x" }), { authorization: "[REDACTED]" });
  const counters = new CounterRegistry();
  assert.equal(counters.increment("test", { outcome: "ok" }), 1);
  assert.deepEqual(counters.snapshot(), { "test{outcome=ok}": 1 });
});

test("checkpoint manifest validates portable references and compatibility", () => {
  const manifest: CheckpointManifest = { schemaVersion: 1, goalId: "g", taskId: "t", planRevision: 1, planDigest: "sha256:plan", attempt: 1, createdAt: new Date().toISOString(), inputDigest: "sha256:input", completedSteps: [], currentState: {}, nextActions: ["resume"], decisions: [], changedFiles: [], tests: ["npm test"], knownIssues: [], artifacts: ["sha256:" + "a".repeat(64)], usageActuals: { tokens: 3 }, externalOperations: [], providerResume: { kind: "none", reference: null }, compatibility: { capabilityKind: "codex.execute", capabilityVersion: "1.0.0", workerPlatform: null } };
  const result = validateCheckpointManifest(manifest);
  assert.equal(result.valid, true);
  assert.equal(isCheckpointCompatible(manifest, { goalId: "g", taskId: "t", planDigest: "sha256:plan", capabilityKind: "codex.execute", capabilityVersion: "1.0.0" }), true);
  assert.equal(validateCheckpointManifest({ ...manifest, artifacts: ["not-a-digest"] }).valid, false);
});

test("backup manifest requires an explicit restore drill", () => {
  const root = mkdtempSync(join(tmpdir(), "pai-backup-"));
  const source = join(root, "source.db"); const destination = join(root, "backup.db");
  writeFileSync(source, "db");
  const manifest = createConsistentFileBackup(source, destination, { schemaVersionObserved: 1, migrationChecksums: ["m1"], artifactDigests: [] });
  assert.equal(verifyBackupManifest(manifest).valid, false);
  assert.equal(verifyBackupManifest(markRestoreDrill(manifest, true)).valid, true);
});

test("quota observations override optimistic state on explicit limit errors", () => {
  const quota = new QuotaTracker();
  assert.equal(quota.observe("AVAILABLE_ESTIMATE", "historical"), "AVAILABLE_ESTIMATE");
  assert.equal(quota.observe("AVAILABLE_ESTIMATE", "limit-error", 1_700_000_100_000), "EXHAUSTED");
  assert.equal(quota.probeEligible(1_700_000_100_001), true);
});

test("compute broker reserves only registered non-exhausted providers", async () => {
  const broker = new ComputeBroker();
  let providerId: string;
  const provider = {
    describe: async () => ({ providerId: "p", providerClass: "deterministic" as const, capabilities: ["read"] as string[], quota: "AVAILABLE_ESTIMATE" as const }),
    probe: async () => ({ status: "HEALTHY" as const, observedAt: 1 }),
    estimate: async () => ({ providerId: "p", qualityEligible: true, estimatedCostMicros: 0, latencyMs: 1, confidence: "HIGH" as const }),
    reserve: async () => ({ reservationId: "r", providerId: "p", expiresAt: 2 }),
    async *execute() { yield { eventId: "e", type: "RESULT" as const, payload: {} }; },
    checkpoint: async () => ({}),
    async *resume() { yield { eventId: "e2", type: "RESULT" as const, payload: {} }; },
    cancel: async () => ({ accepted: true, uncertain: false }),
  };
  providerId = "p";
  broker.register(provider, await provider.describe(), await provider.probe());
  assert.equal((await broker.reserve(providerId, { taskId: "t", action: "read", inputDigest: "sha256:i", budget: {} })).reservationId, "r");
  assert.equal(broker.observeQuota("p", "EXHAUSTED", "limit-error", 200), "EXHAUSTED");
  await assert.rejects(() => broker.reserve("p", { taskId: "t", action: "read", inputDigest: "sha256:i", budget: {} }), /unavailable/);
});
