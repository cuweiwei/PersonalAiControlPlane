import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDispatchRequest } from "../packages/contracts/src/dispatch.ts";
import { canonicalJson, sha256 } from "../packages/contracts/src/index.ts";
import { ControlPlaneDatabase } from "../apps/control-plane/src/db/database.ts";
import { DispatchService } from "../apps/control-plane/src/dispatch/dispatch-service.ts";
import { FakeSemanticRouterProvider } from "../apps/control-plane/src/dispatch/providers/fake-provider.ts";
import type { DispatchExecutionAdapter, NormalizedMatch, SemanticRouterProvider } from "../apps/control-plane/src/dispatch/dispatch-types.ts";
import { EventHub } from "../apps/control-plane/src/events/event-hub.ts";
import { ArtifactStorage } from "../apps/control-plane/src/artifacts/artifact-storage.ts";
import { TaskService } from "../apps/control-plane/src/tasks/task-service.ts";
import { WorkerService } from "../apps/control-plane/src/workers/worker-service.ts";
import { SettingsService } from "../apps/control-plane/src/settings/settings-service.ts";
import { HealthMonitor } from "../apps/control-plane/src/systems/health-monitor.ts";
import { createControlPlaneServer } from "../apps/control-plane/src/server.ts";
import type { WorkerCoordinator } from "../apps/control-plane/src/workers/worker-channel.ts";
import { parseDispatchReleasePayload, parseDispatchRulePayload } from "../apps/control-plane/src/dispatch/rule-registry.ts";
import { DispatchLearningService } from "../apps/control-plane/src/dispatch/learning/learning-service.ts";

function request(overrides: Record<string, unknown> = {}) {
  return parseDispatchRequest({
    schema_version: 1,
    request_id: "req-1",
    ingress_key: "telegram:owner:1",
    source: { channel: "telegram", conversation_ref: "telegram:owner", event_ref: "event-1" },
    subject_ref: "owner",
    text: "ContextHub status",
    received_at: "2026-09-21T01:00:00Z",
    timezone: "Asia/Taipei",
    locale: "zh-TW",
    context: { session_revision: 12, standalone: true, pending_interaction: false },
    privacy_class: "LOCAL_ONLY",
    ...overrides,
  });
}

class TestAdapter implements DispatchExecutionAdapter {
  readonly operationId = "service.health_check";
  readonly descriptorHash = "sha256:test-adapter-v1";
  readonly supportsOperationDedup = true;
  calls = 0;
  async execute(action: any): Promise<any> {
    this.calls += 1;
    return { schemaVersion: 1, status: "HEALTHY", observedAt: new Date().toISOString(), sourceRef: "system-health:contexthub", serviceRef: action.parameters.service_ref, message: null };
  }
}

function setup(options: { enabled?: boolean; semantic?: boolean; provider?: FakeSemanticRouterProvider; routingBudgetMs?: number } = {}) {
  const db = new ControlPlaneDatabase(":memory:");
  db.run("INSERT INTO systems(id, name, type, base_url, health_path, enabled) VALUES ('contexthub', 'ContextHub', 'memory', 'http://127.0.0.1:1', '/health', 1)");
  const adapter = new TestAdapter();
  const dispatch = new DispatchService(db, { enabled: options.enabled ?? true, semanticEnabled: options.semantic ?? false, provider: options.provider, routingBudgetMs: options.routingBudgetMs, adapters: [adapter], proposalTtlMs: 30_000 });
  if (options.provider) {
    const active = dispatch.registry.activeRelease()!;
    const release = dispatch.registry.createRelease({ ...active.manifest, providerBundles: [options.provider.describe().bundleId], calibrationProfiles: ["profile-1"] }, "test");
    dispatch.registry.activateRelease(release.id, active.revision, "test");
  }
  return { db, dispatch, adapter };
}

test("dispatch stays disabled by default and deterministic prepare has no execution side effect", async () => {
  const db = new ControlPlaneDatabase(":memory:");
  const adapter = new TestAdapter();
  const dispatch = new DispatchService(db, { adapters: [adapter] });
  const result = await dispatch.prepare(request());
  assert.equal(result.disposition, "FALLBACK");
  assert.equal(result.reason, "DISPATCH_DISABLED");
  assert.equal(adapter.calls, 0);
  db.close();
});

test("tier 0 proposal commits once, executes through a typed adapter, and replays the receipt", async () => {
  const { db, dispatch, adapter } = setup();
  const first = await dispatch.prepare(request());
  assert.equal(first.disposition, "PROPOSED");
  assert.equal(first.tier_id, "exact-v1");
  const actionHash = String(first.action_hash);
  const commitInput = { operationKey: String(first.operation_key), actionHash, sessionRevision: 12, ownershipRef: "hermes-intake-1" };
  const accepted = dispatch.commit(String(first.proposal_id), commitInput);
  const replay = dispatch.commit(String(first.proposal_id), commitInput);
  assert.equal(replay.operation_id, accepted.operation_id);
  assert.throws(() => dispatch.commit(String(first.proposal_id), { ...commitInput, ownershipRef: "other-intake" }), /DISPATCH_COMMIT_CONFLICT/);
  assert.throws(() => dispatch.commit(String(first.proposal_id), { ...commitInput, sessionRevision: 13 }), /DISPATCH_COMMIT_CONFLICT/);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const status = dispatch.getRequest("owner", "telegram:owner:1")!;
  assert.equal((status.operation as any).status, "SUCCEEDED");
  assert.equal(adapter.calls, 1);
  db.close();
});

test("restart recovery marks an in-flight operation unknown without replaying it", async () => {
  const { db, dispatch, adapter } = setup();
  const first = await dispatch.prepare(request({ request_id: "req-recovery", ingress_key: "telegram:owner:recovery", source: { channel: "telegram", conversation_ref: "telegram:owner", event_ref: "event-recovery" } }));
  const input = { operationKey: String(first.operation_key), actionHash: String(first.action_hash), sessionRevision: 12, ownershipRef: "hermes-recovery" };
  const accepted = dispatch.commit(String(first.proposal_id), input);
  db.run("UPDATE dispatch_operations SET status = 'EXECUTING', certainty = 'KNOWN' WHERE id = ?", accepted.operation_id);
  const restarted = new DispatchService(db, { enabled: true, adapters: [adapter] });
  assert.equal(restarted.recoverPending(), 0);
  const row = db.one<{ status: string; certainty: string; validation_state: string; result_json: string }>("SELECT status, certainty, validation_state, result_json FROM dispatch_operations WHERE id = ?", accepted.operation_id)!;
  assert.equal(row.status, "UNKNOWN");
  assert.equal(row.certainty, "UNKNOWN");
  assert.equal(row.validation_state, "FAILED");
  assert.match(row.result_json, /RECOVERY_RECONCILIATION_REQUIRED/);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(adapter.calls, 1);
  db.close();
});

test("resolve wins the proposal race and a late commit cannot start an operation", async () => {
  const { db, dispatch } = setup();
  const first = await dispatch.prepare(request({ request_id: "req-2", ingress_key: "telegram:owner:2", source: { channel: "telegram", conversation_ref: "telegram:owner", event_ref: "event-2" } }));
  const actionHash = String(first.action_hash);
  const input = { operationKey: String(first.operation_key), actionHash };
  assert.equal(dispatch.resolveToHermes(String(first.proposal_id), input).status, "RELEASED");
  assert.deepEqual(dispatch.resolveToHermes(String(first.proposal_id), input), { schema_version: 1, proposal_id: first.proposal_id, operation_key: input.operationKey, disposition: "NOT_STARTED_RELEASED", status: "RELEASED" });
  assert.throws(() => dispatch.commit(String(first.proposal_id), { ...input, sessionRevision: 12, ownershipRef: "hermes-intake-2" }), /DISPATCH_PROPOSAL_RELEASED/);
  assert.equal(db.one<{ count: number }>("SELECT COUNT(*) AS count FROM dispatch_operations")?.count, 0);
  db.close();
});

test("negative and semantic inputs abstain safely", async () => {
  const normalized: NormalizedMatch = { schemaVersion: 1, intent: "service.health_check", abstain: false, reason: "CALIBRATED_MATCH", assurance: "HIGH", calibratedProbability: 0.999, calibrationProfileId: "profile-1", alternatives: [], provenance: { providerId: "fake", modelRevision: "m1", bundleId: "b1", runtimeRevision: "r1", ruleSetHash: "rules", datasetRevision: "d1" } };
  const provider = new FakeSemanticRouterProvider(() => normalized);
  const { db, dispatch } = setup({ semantic: true, provider });
  const descriptor = provider.describe();
  Object.assign(normalized.provenance, { providerId: descriptor.providerId, modelRevision: descriptor.modelRevision, bundleId: descriptor.bundleId, runtimeRevision: descriptor.runtimeRevision, ruleSetHash: sha256(canonicalJson(dispatch.registry.activeRelease()!.manifest.ruleSet)) });
  const negative = await dispatch.prepare(request({ request_id: "req-3", ingress_key: "telegram:owner:3", source: { channel: "telegram", conversation_ref: "telegram:owner", event_ref: "event-3" }, text: "幫我看看 ContextHub 最近為什麼一直 restart" }));
  assert.equal(negative.disposition, "FALLBACK");
  assert.equal(negative.reason, "COMPLEX_REQUEST");
  const semantic = await dispatch.prepare(request({ request_id: "req-4", ingress_key: "telegram:owner:4", source: { channel: "telegram", conversation_ref: "telegram:owner", event_ref: "event-4" }, text: "ContextHub 還活著嗎？" }));
  assert.equal(semantic.disposition, "PROPOSED");
  assert.equal(semantic.tier_id, "semantic-v1");
  db.close();
});

test("dispatch HTTP contract exposes prepare, commit, and same-subject status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pai-dispatch-http-"));
  const db = new ControlPlaneDatabase(":memory:"); const events = new EventHub(); const tasks = new TaskService(db, events); const workers = new WorkerService(db); const artifacts = new ArtifactStorage(directory); const settings = new SettingsService(db); const health = new HealthMonitor(db, events); health.seed();
  const adapter = new TestAdapter(); const dispatch = new DispatchService(db, { enabled: true, adapters: [adapter] });
  const coordinator = { closeWorker: () => {}, handleUpgrade: () => {}, isConnected: () => true, offer: () => true } as unknown as WorkerCoordinator;
  const server = createControlPlaneServer({ db, tasks, workers, coordinator, artifacts, settings, health, events, dispatch, assetRoot: directory });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number }; const origin = `http://127.0.0.1:${address.port}`;
  const call = async (path: string, init: RequestInit = {}) => { const response = await fetch(`${origin}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } }); return { response, body: await response.json() as Record<string, any> }; };
  try {
    const prepared = await call("/api/v2/dispatch/prepare", { method: "POST", body: JSON.stringify({ schema_version: 1, request_id: "http-req-1", ingress_key: "http:owner:1", source: { channel: "web", conversation_ref: "web:owner", event_ref: "http-event-1" }, subject_ref: "owner", text: "ContextHub status", received_at: "2026-09-21T01:00:00Z", timezone: "Asia/Taipei", locale: "zh-TW", context: { session_revision: 1, standalone: true, pending_interaction: false }, privacy_class: "LOCAL_ONLY" }) });
    assert.equal(prepared.response.status, 200); assert.equal(prepared.body.disposition, "PROPOSED");
    const committed = await call(`/api/v2/dispatch/proposals/${prepared.body.proposal_id}/commit`, { method: "POST", body: JSON.stringify({ operation_key: prepared.body.operation_key, action_hash: prepared.body.action_hash, session_revision: 1, ownership_ref: "hermes-intake-http-1" }) });
    assert.equal(committed.response.status, 202);
    const status = await call(`/api/v2/dispatch/requests/${encodeURIComponent("http:owner:1")}`);
    let settled = status;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      settled = await call(`/api/v2/dispatch/requests/${encodeURIComponent("http:owner:1")}`);
      if (settled.body.operation?.status === "SUCCEEDED") break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(settled.response.status, 200); assert.equal(settled.body.operation.operation_id, committed.body.operation_id); assert.equal(settled.body.operation.status, "SUCCEEDED");
    assert.equal("schemaVersion" in (settled.body.operation.result ?? {}), false);
    assert.equal("serviceRef" in (settled.body.operation.result ?? {}), false);
    assert.equal(settled.body.operation.result.schema_version, 1);
    assert.equal(settled.body.operation.result.service_ref, "contexthub");
    assert.equal("operationSchemaVersion" in (settled.body.proposal.action ?? {}), false);
    assert.equal(settled.body.proposal.action.operation_schema_version, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); db.close(); await rm(directory, { recursive: true, force: true });
  }
});

test("semantic provider readiness and match obey one real promise deadline", async () => {
  const provider = {
    describe: () => ({ providerId: "fake", protocolVersion: 1 as const, modelRevision: "fake-model-v1", runtimeRevision: "fake-runtime-v1", bundleId: "fake-bundle-v1", bundleHash: "sha256:fake", supportedLanguageClasses: ["ZH_DOMINANT" as const], maxBytes: 8 * 1024, maxTokens: 128, privacyLocality: "LOCAL_ONLY" as const }),
    readiness: async () => { await new Promise((resolve) => setTimeout(resolve, 50)); return { ready: true, reason: "LATE" }; },
    match: async () => { throw new Error("UNREACHABLE"); },
    close: async () => {},
  } as SemanticRouterProvider;
  const { db, dispatch } = setup({ semantic: true, provider: provider as any, routingBudgetMs: 5 });
  const result = await dispatch.prepare(request({ request_id: "deadline", ingress_key: "deadline", text: "ContextHub 還活著嗎？", routing_budget_ms: 5 }));
  assert.equal(result.disposition, "FALLBACK");
  assert.equal(result.reason, "PROVIDER_TIMEOUT");
  db.close();
});

test("semantic self-reported provenance without release calibration binding abstains", async () => {
  const normalized: NormalizedMatch = { schemaVersion: 1, intent: "service.health_check", abstain: false, reason: "CALIBRATED_MATCH", assurance: "HIGH", calibratedProbability: 0.999, calibrationProfileId: "unknown-profile", alternatives: [], provenance: { providerId: "fake", modelRevision: "fake-model-v1", bundleId: "fake-bundle-v1", runtimeRevision: "fake-runtime-v1", ruleSetHash: "sha256:" + "0".repeat(64), datasetRevision: "dataset-1" } };
  const provider = new FakeSemanticRouterProvider(() => normalized);
  const { db, dispatch } = setup({ semantic: true, provider });
  const result = await dispatch.prepare(request({ request_id: "provenance", ingress_key: "provenance", text: "ContextHub 還活著嗎？" }));
  assert.equal(result.disposition, "FALLBACK");
  assert.equal(result.reason, "UNCALIBRATED");
  db.close();
});

test("dispatch binds principal to subject and rejects cross-subject prepare", async () => {
  const { db, dispatch } = setup();
  assert.rejects(dispatch.prepare(request({ subject_ref: "owner-1", request_id: "auth", ingress_key: "auth" }), "owner"), /DISPATCH_SUBJECT_MISMATCH/);
  db.close();
});

test("rule revisions require the bounded schema and atomically update the active release", () => {
  const { db, dispatch } = setup();
  assert.throws(() => parseDispatchRulePayload({ schema_version: 1, rule_id: "unsafe", revision: 1, intent: "service.health_check", bge_threshold: 0.8 }), /INVALID_DISPATCH_RULE_FIELD/);
  assert.throws(() => parseDispatchRulePayload({ schema_version: 1, rule_id: "unsafe", revision: 1, intent: "service.health_check", action: { script: "curl http://example.invalid" } }), /INVALID_DISPATCH_RULE_FIELD:action.script/);
  assert.throws(() => parseDispatchReleasePayload({ schema_version: 1, rule_set: [], unexpected: true }), /INVALID_DISPATCH_RULE_FIELD:release.unexpected/);
  const base = dispatch.registry.get("service-health-check", 1)!;
  const candidate = parseDispatchRulePayload({ schema_version: 1, rule_id: "service-health-check", revision: 2, intent: base.intent, match: { exact: ["{service} online"], aliases: [], semantic: { examples: [], negative_examples: [] } }, slots: { service: { type: "service_ref", required: true, extractor: "known_service_v1", allowed_values: ["contexthub"] } }, action: { kind: "single_operation", operation: "service.health_check", operation_schema_version: 1, logical_worker: "control-plane-health", parameters: { service_ref: "$slot.service" } }, risk: { declared_effect: "READ_ONLY", required_assurance: "HIGH" }, response: { template_id: "service-health-v1", result_schema_version: 1 }, provenance: { origin: "curated", evidence_refs: [] } });
  dispatch.createCandidate(candidate, "owner");
  assert.deepEqual(dispatch.transition(candidate.ruleId, candidate.revision, "SHADOW", 1, "owner", "TEST"), { ruleId: candidate.ruleId, revision: candidate.revision, state: "SHADOW", stateRevision: 2 });
  const active = dispatch.transition(candidate.ruleId, candidate.revision, "ACTIVE", 2, "owner", "TEST");
  assert.equal((active as any).state, "ACTIVE"); assert.equal(dispatch.registry.activeRelease()!.manifest.ruleSet.find((item) => item.ruleId === candidate.ruleId)?.revision, 2);
  db.close();
});

test("learning shadow is predict-only and promotion/degrade require independent evidence", () => {
  const { db, dispatch } = setup();
  const base = dispatch.registry.get("service-health-check", 1)!;
  dispatch.createCandidate({ ...base, revision: 2 }, "owner");
  dispatch.transition(base.ruleId, 2, "SHADOW", 1, "owner", "TEST_SHADOW");
  const releaseId = dispatch.registry.activeRelease()!.id;
  const learning = new DispatchLearningService(db);
  const action = { ...base.action, parameters: { service_ref: "contexthub" } };
  const datasetHash = sha256("shadow-dataset");
  const rejected = learning.evaluatePromotion({ ruleId: base.ruleId, revision: 2, releaseId, datasetRef: "dataset://shadow", datasetHash, splitManifest: { split: "holdout" }, reportRef: "report://empty" });
  assert.equal(rejected.eligible, false);
  for (let index = 0; index < 30; index += 1) {
    const occurredAt = Date.UTC(2026, 0, 1 + (index % 7));
    const observation = learning.observe(action, "SUCCEEDED", `shadow-event-${index}`, `shadow-request-${index}`, `receipt-${index}`, occurredAt) as { observation_id: string };
    const prediction = learning.recordShadowPrediction({ requestId: `shadow-request-${index}`, candidateRuleId: base.ruleId, candidateRevision: 2, releaseId, predictedAction: action, createdAt: occurredAt });
    assert.equal(prediction.comparison, "PENDING");
    assert.equal(learning.compareShadowPrediction({ shadowId: String(prediction.shadow_id), observationId: observation.observation_id }).comparison, "MATCH");
    learning.recordLabel({ observationId: observation.observation_id, label: "CORRECT", source: "owner", reviewer: "owner", evidenceRef: `evidence://shadow/${index}`, createdAt: occurredAt });
  }
  const eligible = learning.evaluatePromotion({ ruleId: base.ruleId, revision: 2, releaseId, datasetRef: "dataset://shadow", datasetHash, splitManifest: { split: "holdout", seed: 1 }, reportRef: "report://complete" });
  assert.equal(eligible.eligible, true);
  const wrongAction = { ...action, parameters: { service_ref: "hermes" } };
  const wrongObservation = learning.observe(wrongAction, "SUCCEEDED", "shadow-event-wrong", "shadow-request-wrong", "receipt-wrong", Date.UTC(2026, 0, 8)) as { observation_id: string };
  const wrongPrediction = learning.recordShadowPrediction({ requestId: "shadow-request-wrong", candidateRuleId: base.ruleId, candidateRevision: 2, releaseId, predictedAction: action, createdAt: Date.UTC(2026, 0, 8) });
  assert.equal(learning.compareShadowPrediction({ shadowId: String(wrongPrediction.shadow_id), observationId: wrongObservation.observation_id }).comparison, "MISMATCH");
  learning.recordLabel({ observationId: wrongObservation.observation_id, label: "INCORRECT", source: "owner", reviewer: "owner", evidenceRef: "evidence://wrong" });
  assert.equal(learning.assessDegradation({ ruleId: base.ruleId, revision: 2, releaseId }).action, "DISABLE");
  db.close();
});
