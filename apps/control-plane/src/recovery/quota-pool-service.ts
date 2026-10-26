import { createHash } from "node:crypto";
import { canonicalJson, uuidv7, type CreateQuotaPoolInput, type QuotaBucket, type QuotaConfidence, type QuotaObservationSource, type QuotaPoolBindingEvidence, type QuotaPoolIdentityState, type RecordQuotaObservationInput } from "../../../../packages/contracts/src/index.ts";
import { ControlPlaneDatabase } from "../db/database.ts";

type Row = Record<string, any>;
type Runtime = "opencode" | "codex";
type PoolState = "READY" | "BLOCKED" | "UNKNOWN";

const SHA256_REFERENCE = /^sha256:[0-9a-f]{64}$/;
const RUNTIMES = new Set<Runtime>(["opencode", "codex"]);
const SOURCES = new Set<QuotaObservationSource>(["PROVIDER_STRUCTURED_ERROR", "PROVIDER_USAGE_API", "CODEX_APP_SERVER", "OWNER_REPORTED"]);
const CONFIDENCE = new Set<QuotaConfidence>(["HIGH", "MEDIUM", "LOW", "UNKNOWN"]);
const BUCKETS = new Set<QuotaBucket>(["FIVE_HOUR", "WEEKLY", "OTHER", "UNKNOWN"]);
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const DEFAULT_FRESHNESS_MS = 15 * 60_000;

function digest(value: unknown): string { return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex"); }
function boundedActor(value: string): string { const actor = value.trim(); if (!actor || actor.length > 120) throw new Error("INVALID_ACTOR"); return actor; }
function assertSha256Reference(value: unknown, errorCode: string): string {
  if (typeof value !== "string" || !SHA256_REFERENCE.test(value)) throw new Error(errorCode);
  return value;
}
function assertTime(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`INVALID_${field.toUpperCase()}`);
  return value;
}
function toIso(value: unknown): string | null { return value === null || value === undefined ? null : new Date(Number(value)).toISOString(); }

export type QuotaBucketReadiness = {
  bucket: "FIVE_HOUR" | "WEEKLY";
  ready: boolean;
  state: "READY" | "BLOCKED" | "UNKNOWN";
  observedAt: string | null;
  resetsAt: string | null;
  nextCheckAt: string | null;
  source: string | null;
  confidence: string | null;
};

export type QuotaPoolReadiness = {
  poolId: string;
  provider: string;
  identityState: QuotaPoolIdentityState;
  state: PoolState;
  quotaReady: boolean;
  fiveHour: QuotaBucketReadiness;
  weekly: QuotaBucketReadiness;
  observedAt: string | null;
};

/**
 * Persists masked, bounded quota evidence. This service never dispatches a model
 * turn; quota readiness is only one input to the separate recovery gates.
 */
export class QuotaPoolService {
  private readonly db: ControlPlaneDatabase;
  private readonly freshnessMs: number;

  constructor(db: ControlPlaneDatabase, freshnessMs = DEFAULT_FRESHNESS_MS) {
    if (!Number.isSafeInteger(freshnessMs) || freshnessMs <= 0 || freshnessMs > 24 * 60 * 60_000) throw new Error("INVALID_QUOTA_FRESHNESS");
    this.db = db;
    this.freshnessMs = freshnessMs;
  }

  createPool(input: CreateQuotaPoolInput, actor: string, now = Date.now()): Record<string, unknown> {
    const principal = boundedActor(actor);
    const provider = typeof input.provider === "string" ? input.provider.trim().toLowerCase() : "";
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(provider)) throw new Error("INVALID_QUOTA_PROVIDER");
    const identityState = input.identity_state ?? "UNKNOWN";
    if (identityState !== "UNKNOWN" && identityState !== "OWNER_CONFIRMED") throw new Error("INVALID_QUOTA_POOL_IDENTITY");
    const fingerprint = input.account_fingerprint == null ? null : assertSha256Reference(input.account_fingerprint, "INVALID_ACCOUNT_FINGERPRINT");
    if (identityState === "OWNER_CONFIRMED" && !fingerprint) throw new Error("ACCOUNT_FINGERPRINT_REQUIRED");
    assertTime(now, "created_at");

    return this.db.transaction(() => {
      const existing = fingerprint ? this.db.one<Row>("SELECT id FROM quota_pools WHERE provider = ? AND account_fingerprint = ?", provider, fingerprint) : undefined;
      if (existing) {
        const existingPool = this.db.one<Row>("SELECT identity_state FROM quota_pools WHERE id = ?", String(existing.id));
        if (String(existingPool?.identity_state) !== identityState) throw new Error("QUOTA_POOL_IDENTITY_CONFLICT");
        return this.getPool(String(existing.id))!;
      }
      const id = `quota_${uuidv7(now)}`;
      this.db.run("INSERT INTO quota_pools(id, provider, account_fingerprint, alias_masked, pool_status, next_recheck_at, updated_at, identity_state) VALUES (?, ?, ?, NULL, 'UNKNOWN', NULL, ?, ?)", id, provider, fingerprint, now, identityState);
      this.appendAudit(principal, "quota.pool.created", null, { poolId: id, provider, identityState, fingerprintRecorded: fingerprint !== null }, now);
      return this.getPool(id)!;
    });
  }

  bindWorker(input: { poolId: string; workerId: string; runtime: Runtime; evidence: QuotaPoolBindingEvidence }, actor: string, now = Date.now()): Record<string, unknown> {
    const principal = boundedActor(actor);
    if (!input.poolId || !input.workerId || !RUNTIMES.has(input.runtime)) throw new Error("INVALID_QUOTA_POOL_BINDING");
    if (!["OWNER_CONFIRMED", "UNVERIFIED", "UNKNOWN"].includes(input.evidence)) throw new Error("INVALID_QUOTA_BINDING_EVIDENCE");
    assertTime(now, "verified_at");
    return this.db.transaction(() => {
      const pool = this.db.one<Row>("SELECT id, identity_state FROM quota_pools WHERE id = ?", input.poolId);
      if (!pool) throw new Error("QUOTA_POOL_NOT_FOUND");
      const worker = this.db.one<Row>("SELECT id FROM workers WHERE id = ? AND removed_at IS NULL", input.workerId);
      if (!worker) throw new Error("WORKER_NOT_FOUND");
      if (input.evidence === "OWNER_CONFIRMED" && pool.identity_state !== "OWNER_CONFIRMED") throw new Error("QUOTA_POOL_IDENTITY_UNCONFIRMED");
      const existing = this.db.one<Row>("SELECT usage_pool_id FROM quota_pool_bindings WHERE worker_id = ? AND runtime = ?", input.workerId, input.runtime);
      if (existing && String(existing.usage_pool_id) !== input.poolId) throw new Error("QUOTA_POOL_BINDING_CONFLICT");
      const verifiedAt = input.evidence === "OWNER_CONFIRMED" ? now : null;
      this.db.run("INSERT INTO quota_pool_bindings(usage_pool_id, worker_id, runtime, evidence_state, verified_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(worker_id, runtime) DO UPDATE SET evidence_state = excluded.evidence_state, verified_at = excluded.verified_at", input.poolId, input.workerId, input.runtime, input.evidence, verifiedAt);
      this.db.run("UPDATE quota_pools SET updated_at = ? WHERE id = ?", now, input.poolId);
      this.appendAudit(principal, "quota.pool.worker_bound", input.workerId, { poolId: input.poolId, runtime: input.runtime, evidence: input.evidence }, now);
      return { poolId: input.poolId, workerId: input.workerId, runtime: input.runtime, evidence: input.evidence, verifiedAt: toIso(verifiedAt) };
    });
  }

  recordObservation(poolId: string, input: RecordQuotaObservationInput, actor: string, now = Date.now()): QuotaPoolReadiness {
    const principal = boundedActor(actor);
    if (!BUCKETS.has(input.bucket) || typeof input.exhausted !== "boolean" && input.exhausted !== null) throw new Error("INVALID_QUOTA_OBSERVATION");
    if (input.used_percent !== undefined && input.used_percent !== null && (typeof input.used_percent !== "number" || !Number.isFinite(input.used_percent) || input.used_percent < 0 || input.used_percent > 100)) throw new Error("INVALID_QUOTA_PERCENT");
    if (input.resets_at !== undefined && input.resets_at !== null) assertTime(input.resets_at, "resets_at");
    const observedAt = assertTime(input.observed_at, "observed_at");
    if (observedAt > now + MAX_CLOCK_SKEW_MS) throw new Error("QUOTA_OBSERVATION_FROM_FUTURE");
    if (!SOURCES.has(input.source) || !CONFIDENCE.has(input.confidence)) throw new Error("INVALID_QUOTA_EVIDENCE");
    const evidenceHash = input.evidence_hash == null ? null : assertSha256Reference(input.evidence_hash, "INVALID_EVIDENCE_HASH");
    assertTime(now, "created_at");

    return this.db.transaction(() => {
      const pool = this.db.one<Row>("SELECT id FROM quota_pools WHERE id = ?", poolId);
      if (!pool) throw new Error("QUOTA_POOL_NOT_FOUND");
      const id = uuidv7(now);
      this.db.run("INSERT INTO quota_observations(id, usage_pool_id, bucket, exhausted, used_percent, resets_at, observed_at, source, confidence, evidence_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", id, poolId, input.bucket, input.exhausted === null ? null : input.exhausted ? 1 : 0, input.used_percent ?? null, input.resets_at ?? null, observedAt, input.source, input.confidence, evidenceHash, now);
      const readiness = this.getReadiness(poolId, now);
      this.db.run("UPDATE quota_pools SET pool_status = ?, next_recheck_at = ?, updated_at = ? WHERE id = ?", readiness.state, this.nextCheckAt(readiness), now, poolId);
      this.appendAudit(principal, "quota.observation.recorded", null, { poolId, bucket: input.bucket, exhausted: input.exhausted, source: input.source, confidence: input.confidence, evidenceHash }, now);
      return readiness;
    });
  }

  recordWorkerObservation(workerId: string, runtime: Runtime, input: RecordQuotaObservationInput, now = Date.now()): QuotaPoolReadiness {
    const worker = this.db.one<Row>("SELECT id FROM workers WHERE id = ? AND removed_at IS NULL AND enabled = 1", workerId);
    if (!worker || !RUNTIMES.has(runtime)) throw new Error("WORKER_NOT_FOUND");
    const binding = this.db.one<Row>(`SELECT p.id FROM quota_pools p JOIN quota_pool_bindings b ON b.usage_pool_id = p.id
      WHERE p.identity_state = 'OWNER_CONFIRMED' AND b.worker_id = ? AND b.runtime = ? AND b.evidence_state = 'OWNER_CONFIRMED'`, workerId, runtime);
    if (!binding) throw new Error("QUOTA_POOL_BINDING_UNVERIFIED");
    return this.recordObservation(String(binding.id), input, `worker:${workerId}`, now);
  }

  getReadiness(poolId: string, now = Date.now()): QuotaPoolReadiness {
    assertTime(now, "observed_at");
    const pool = this.db.one<Row>("SELECT id, provider, identity_state FROM quota_pools WHERE id = ?", poolId);
    if (!pool) throw new Error("QUOTA_POOL_NOT_FOUND");
    const latest = (bucket: "FIVE_HOUR" | "WEEKLY"): QuotaBucketReadiness => {
      const row = this.db.one<Row>("SELECT bucket, exhausted, used_percent, observed_at, resets_at, source, confidence, evidence_hash FROM quota_observations WHERE usage_pool_id = ? AND bucket = ? ORDER BY observed_at DESC, created_at DESC, id DESC LIMIT 1", poolId, bucket);
      if (!row) return { bucket, ready: false, state: "UNKNOWN", observedAt: null, resetsAt: null, nextCheckAt: null, source: null, confidence: null };
      const observed = Number(row.observed_at);
      const fresh = observed <= now && now - observed <= this.freshnessMs;
      const exhausted = row.exhausted === null || row.exhausted === undefined ? null : Number(row.exhausted) === 1;
      const trusted = ["PROVIDER_STRUCTURED_ERROR", "PROVIDER_USAGE_API", "CODEX_APP_SERVER"].includes(String(row.source)) && row.confidence === "HIGH" && typeof row.evidence_hash === "string" && SHA256_REFERENCE.test(String(row.evidence_hash));
      const claimsFull = row.used_percent !== null && row.used_percent !== undefined && Number(row.used_percent) >= 100;
      const state = !fresh ? "UNKNOWN" : exhausted === true ? "BLOCKED" : exhausted === false && trusted && !claimsFull ? "READY" : "UNKNOWN";
      const resetsAt = row.resets_at === null || row.resets_at === undefined ? null : Number(row.resets_at);
      const next = state === "READY" ? observed + this.freshnessMs : resetsAt !== null && resetsAt > now ? resetsAt : observed + this.freshnessMs;
      return { bucket, ready: state === "READY", state, observedAt: toIso(observed), resetsAt: toIso(resetsAt), nextCheckAt: toIso(next), source: String(row.source), confidence: String(row.confidence) };
    };
    const fiveHour = latest("FIVE_HOUR");
    const weekly = latest("WEEKLY");
    const identityState = String(pool.identity_state) as QuotaPoolIdentityState;
    const state: PoolState = fiveHour.state === "BLOCKED" || weekly.state === "BLOCKED" ? "BLOCKED" : identityState === "OWNER_CONFIRMED" && fiveHour.ready && weekly.ready ? "READY" : "UNKNOWN";
    const latestObservedAt = [fiveHour.observedAt, weekly.observedAt].filter((value): value is string => value !== null).sort().at(-1) ?? null;
    return { poolId, provider: String(pool.provider), identityState, state, quotaReady: state === "READY", fiveHour, weekly, observedAt: latestObservedAt };
  }

  listPools(now = Date.now()): QuotaPoolReadiness[] {
    return this.db.all<Row>("SELECT id FROM quota_pools ORDER BY provider, id").map((row) => this.getReadiness(String(row.id), now));
  }

  getPool(poolId: string): Record<string, unknown> | undefined {
    const pool = this.db.one<Row>("SELECT id, provider, identity_state, pool_status, next_recheck_at, updated_at, account_fingerprint FROM quota_pools WHERE id = ?", poolId);
    if (!pool) return undefined;
    const bindings = this.db.all<Row>("SELECT worker_id, runtime, evidence_state, verified_at FROM quota_pool_bindings WHERE usage_pool_id = ? ORDER BY worker_id, runtime", poolId).map((row) => ({ workerId: row.worker_id, runtime: row.runtime, evidence: row.evidence_state, verifiedAt: toIso(row.verified_at) }));
    const readiness = this.getReadiness(poolId);
    return { id: pool.id, provider: pool.provider, identityState: pool.identity_state, state: readiness.state, nextRecheckAt: toIso(this.nextCheckAt(readiness)), updatedAt: toIso(pool.updated_at), hasAccountFingerprint: pool.account_fingerprint !== null, bindings };
  }

  private nextCheckAt(readiness: QuotaPoolReadiness): number | null {
    const candidates = [readiness.fiveHour.nextCheckAt, readiness.weekly.nextCheckAt].filter((value): value is string => value !== null).map((value) => Date.parse(value));
    return candidates.length ? Math.min(...candidates) : null;
  }

  private appendAudit(actor: string, action: string, workerId: string | null, payload: Record<string, unknown>, now: number): void {
    const previousHash = String(this.db.one<Row>("SELECT event_hash FROM audit_events ORDER BY id DESC LIMIT 1")?.event_hash ?? "");
    const eventHash = digest({ actor, action, workerId, payload, previousHash, createdAt: now });
    this.db.run("INSERT INTO audit_events(event_uuid, actor, action, worker_id, payload_json, previous_hash, event_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", uuidv7(now), actor, action, workerId, JSON.stringify(payload), previousHash, eventHash, now);
  }
}
