import assert from "node:assert/strict";
import test from "node:test";
import { ControlPlaneDatabase } from "../apps/control-plane/src/db/database.ts";
import { EventHub } from "../apps/control-plane/src/events/event-hub.ts";
import { QuotaPoolService } from "../apps/control-plane/src/recovery/quota-pool-service.ts";
import { WorkerService } from "../apps/control-plane/src/workers/worker-service.ts";

const now = 1_800_000_000_000;
const fingerprint = `sha256:${"a".repeat(64)}`;
const evidenceHash = `sha256:${"b".repeat(64)}`;

function fixture() {
  const db = new ControlPlaneDatabase(":memory:");
  const workers = new WorkerService(db, new EventHub());
  const first = workers.register({ name: "Quota Worker A", registrationSecret: "quota-worker-secret-a-123", platform: "win32", hardware: {} }, now);
  const second = workers.register({ name: "Quota Worker B", registrationSecret: "quota-worker-secret-b-123", platform: "darwin", hardware: {} }, now + 1);
  const firstApproved = workers.approveRegistration(first.registrationId, "test-owner", now + 2);
  const secondApproved = workers.approveRegistration(second.registrationId, "test-owner", now + 3);
  return { db, workers, service: new QuotaPoolService(db), workerIds: [String(firstApproved.workerId), String(secondApproved.workerId)] as const };
}

function observation(bucket: "FIVE_HOUR" | "WEEKLY", exhausted: boolean, at = now + 10) {
  return { bucket, exhausted, used_percent: exhausted ? 100 : 25, resets_at: exhausted ? at + 3_600_000 : null, observed_at: at, source: "PROVIDER_USAGE_API" as const, confidence: "HIGH" as const, evidence_hash: evidenceHash };
}

test("quota pools deduplicate confirmed account fingerprints and share bindings across workers", () => {
  const f = fixture();
  assert.equal(Number(f.db.one<any>("SELECT version FROM schema_migrations WHERE version = 17")?.version), 17);
  assert.equal(f.db.one("PRAGMA table_info(quota_pools)") !== undefined, true);
  const first = f.service.createPool({ provider: "OpenAI", account_fingerprint: fingerprint, identity_state: "OWNER_CONFIRMED" }, "test-owner", now + 5) as any;
  const duplicate = f.service.createPool({ provider: "openai", account_fingerprint: fingerprint, identity_state: "OWNER_CONFIRMED" }, "test-owner", now + 6) as any;
  assert.equal(first.id, duplicate.id);
  assert.throws(() => f.service.createPool({ provider: "openai", account_fingerprint: fingerprint, identity_state: "UNKNOWN" }, "test-owner", now + 6), /QUOTA_POOL_IDENTITY_CONFLICT/);
  f.service.bindWorker({ poolId: first.id, workerId: f.workerIds[0], runtime: "opencode", evidence: "OWNER_CONFIRMED" }, "test-owner", now + 7);
  f.service.bindWorker({ poolId: first.id, workerId: f.workerIds[1], runtime: "codex", evidence: "OWNER_CONFIRMED" }, "test-owner", now + 8);
  f.service.recordObservation(first.id, observation("FIVE_HOUR", false), "quota-adapter", now + 10);
  const ready = f.service.recordObservation(first.id, observation("WEEKLY", false, now + 11), "quota-adapter", now + 11);
  assert.equal(ready.state, "READY");
  assert.equal(ready.quotaReady, true);
  assert.equal((f.service.getPool(first.id) as any).bindings.length, 2);
  assert.equal(f.db.all("SELECT id FROM quota_pools").length, 1);
  assert.equal(f.workers.verifyAuditChain(), true);
  f.db.close();
});

test("unknown identity and stale, low-confidence, or owner-reported observations never establish quota readiness", () => {
  const f = fixture();
  const pool = f.service.createPool({ provider: "openai" }, "test-owner", now + 1) as any;
  f.service.bindWorker({ poolId: pool.id, workerId: f.workerIds[0], runtime: "opencode", evidence: "UNKNOWN" }, "test-owner", now + 2);
  f.service.recordObservation(pool.id, observation("FIVE_HOUR", false), "quota-adapter", now + 10);
  f.service.recordObservation(pool.id, observation("WEEKLY", false), "quota-adapter", now + 11);
  assert.equal(f.service.getReadiness(pool.id, now + 12).state, "UNKNOWN");

  const confirmed = f.service.createPool({ provider: "openai", account_fingerprint: fingerprint, identity_state: "OWNER_CONFIRMED" }, "test-owner", now + 20) as any;
  f.service.recordObservation(confirmed.id, { ...observation("FIVE_HOUR", false), confidence: "LOW" }, "quota-adapter", now + 21);
  f.service.recordObservation(confirmed.id, { ...observation("WEEKLY", false), source: "OWNER_REPORTED" }, "quota-adapter", now + 22);
  assert.equal(f.service.getReadiness(confirmed.id, now + 23).state, "UNKNOWN");
  assert.equal(f.service.getReadiness(confirmed.id, now + 15 * 60_000 + 22).state, "UNKNOWN");

  const missingEvidence = f.service.createPool({ provider: "openai", account_fingerprint: `sha256:${"f".repeat(64)}`, identity_state: "OWNER_CONFIRMED" }, "test-owner", now + 30) as any;
  f.service.recordObservation(missingEvidence.id, { ...observation("FIVE_HOUR", false), evidence_hash: null }, "quota-adapter", now + 31);
  f.service.recordObservation(missingEvidence.id, { ...observation("WEEKLY", false), used_percent: 50 }, "quota-adapter", now + 32);
  assert.equal(f.service.getReadiness(missingEvidence.id, now + 33).state, "UNKNOWN");
  const full = f.service.createPool({ provider: "openai", account_fingerprint: `sha256:${"e".repeat(64)}`, identity_state: "OWNER_CONFIRMED" }, "test-owner", now + 40) as any;
  f.service.recordObservation(full.id, observation("FIVE_HOUR", false, now + 41), "quota-adapter", now + 41);
  f.service.recordObservation(full.id, { ...observation("WEEKLY", false, now + 42), used_percent: 100 }, "quota-adapter", now + 42);
  assert.equal(f.service.getReadiness(full.id, now + 43).state, "UNKNOWN");
  f.db.close();
});

test("weekly exhaustion blocks a shared pool and a reset timestamp alone does not make it ready", () => {
  const f = fixture();
  const pool = f.service.createPool({ provider: "openai", account_fingerprint: fingerprint, identity_state: "OWNER_CONFIRMED" }, "test-owner", now + 1) as any;
  f.service.recordObservation(pool.id, observation("FIVE_HOUR", false), "quota-adapter", now + 10);
  const blocked = f.service.recordObservation(pool.id, observation("WEEKLY", true), "quota-adapter", now + 11);
  assert.equal(blocked.state, "BLOCKED");
  const afterResetTime = f.service.getReadiness(pool.id, now + 4_000_000);
  assert.equal(afterResetTime.state, "UNKNOWN");
  assert.equal(afterResetTime.quotaReady, false);
  f.service.recordObservation(pool.id, observation("WEEKLY", false, now + 4_000_001), "quota-adapter", now + 4_000_001);
  assert.equal(f.service.getReadiness(pool.id, now + 4_000_002).state, "UNKNOWN");
  f.service.recordObservation(pool.id, observation("FIVE_HOUR", false, now + 4_000_003), "quota-adapter", now + 4_000_003);
  assert.equal(f.service.getReadiness(pool.id, now + 4_000_004).state, "READY");
  f.db.close();
});

test("quota pool inputs reject raw identity and side-effect-bearing provider evidence", () => {
  const f = fixture();
  assert.throws(() => f.service.createPool({ provider: "openai", account_fingerprint: "person@example.com", identity_state: "OWNER_CONFIRMED" }, "test-owner", now), /INVALID_ACCOUNT_FINGERPRINT/);
  assert.throws(() => f.db.run("INSERT INTO quota_pools(id, provider, account_fingerprint, pool_status, updated_at, identity_state) VALUES ('raw-pool', 'openai', 'person@example.com', 'UNKNOWN', ?, 'UNKNOWN')", now), /INVALID_QUOTA_POOL_IDENTITY/);
  assert.throws(() => f.service.recordObservation("missing", { ...observation("FIVE_HOUR", false), evidence_hash: "provider raw response" }, "test-owner", now), /INVALID_EVIDENCE_HASH/);
  assert.throws(() => f.service.recordObservation("missing", { ...observation("FIVE_HOUR", false), used_percent: 101 }, "test-owner", now), /INVALID_QUOTA_PERCENT/);
  f.db.close();
});
