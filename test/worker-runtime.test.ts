import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { canonicalJson, sha256 } from "../packages/crypto/src/index.ts";
import { generateActionGrantKey, signActionGrant } from "../packages/identity/src/index.ts";
import { WorkerConnectionVerifier, type CapabilityDescriptor, type WorkerEnvelope } from "../packages/worker/src/index.ts";
import { WorkerDatabase } from "../apps/worker/src/db.ts";
import { OutboundWorkerRuntime, type WorkerJobOffer } from "../apps/worker/src/runtime.ts";
import { OrchestratorDatabase } from "../apps/orchestrator/src/db.ts";
import { OrchestratorRuntime } from "../apps/orchestrator/src/runtime.ts";
import { TaskEngine } from "../apps/orchestrator/src/task-engine.ts";
import { WorkerExecutionPort } from "../apps/orchestrator/src/worker-execution.ts";
import { ApprovalService } from "../apps/orchestrator/src/approval-service.ts";

function setup(overrides: Partial<WorkerJobOffer> = {}) {
  const now = 1_700_000_000_000;
  const grantKey = generateActionGrantKey("grant-1");
  const workerKeys = generateKeyPairSync("ed25519");
  const descriptorBase = { kind: "codex.execute", version: "1.0.0", health: "HEALTHY" as const, properties: { loginMode: "chatgpt", sandboxModes: ["workspace_write"], maxConcurrency: 1 } };
  const descriptor: CapabilityDescriptor = { ...descriptorBase, descriptorHash: sha256(canonicalJson(descriptorBase)) };
  const claims = {
    iss: "pai-identity-gateway",
    sub: "pai-orchestrator",
    aud: "pai-worker:worker-1",
    jti: "grant-jti-1",
    iat: Math.floor(now / 1000),
    nbf: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + 120,
    taskId: "task-1",
    attemptId: "attempt-1",
    planDigest: "sha256:plan",
    policyVersion: 1,
    fencingToken: 7,
    actions: ["codex.execute"],
    resources: ["repo:test"],
    capabilityIds: ["cap-1"],
    budget: {},
    sandbox: { roots: ["repo:test"] },
    hardStopApprovalId: null,
  };
  const offer: WorkerJobOffer = {
    workerId: "worker-1",
    capabilityId: "cap-1",
    capabilityDescriptorHash: descriptor.descriptorHash,
    attemptId: "attempt-1",
    taskId: "task-1",
    planDigest: "sha256:plan",
    policyVersion: 1,
    fencingToken: 7,
    leaseId: "lease-1",
    requiredAction: "codex.execute",
    resources: ["repo:test"],
    budget: {},
    sandbox: { roots: ["repo:test"] },
    hardStopApprovalId: null,
    actionGrant: signActionGrant({ ...claims, ...("fencingToken" in overrides ? { fencingToken: overrides.fencingToken! } : {}) }, grantKey),
    input: { promptRef: "sha256:input" },
    ...overrides,
  };
  return { now, grantKey, workerKeys, descriptor, offer };
}

test("outbound worker persists acceptance before execution and resends a durable result without re-executing", async () => {
  const { now, grantKey, workerKeys, descriptor, offer } = setup();
  const db = new WorkerDatabase(":memory:");
  const frames: WorkerEnvelope[] = [];
  let polls = 0;
  let executions = 0;
  const runtime = new OutboundWorkerRuntime({
    workerId: "worker-1",
    connectionId: "connection-1",
    db,
    clock: () => now,
    transport: {
      async poll() { polls += 1; return [offer]; },
      async send(frame) { frames.push(frame); },
    },
    adapter: {
      capabilityId: "cap-1",
      descriptor,
      async probe() { return "HEALTHY"; },
      async execute(job) {
        executions += 1;
        assert.equal((db.connection.prepare("SELECT state FROM accepted_jobs WHERE attempt_id = ?").get(job.attemptId) as { state: string }).state, "RUNNING");
        assert.equal(frames.at(-1)?.type, "job.accept");
        return { outcome: "COMPLETED", result: { artifact: "sha256:result" }, checkpoint: { portable: true } };
      },
    },
    resolveGrantKey: (kid) => kid === grantKey.kid ? { kid, state: "ACTIVE", publicKey: grantKey.publicKey } : undefined,
    signFrame: (payload) => sign(null, payload, workerKeys.privateKey),
  });

  assert.equal(await runtime.pollOnce(), 1);
  assert.equal(await runtime.pollOnce(), 1);
  assert.equal(polls, 2);
  assert.equal(executions, 1);
  assert.deepEqual(frames.map((frame) => frame.type), ["job.accept", "job.result", "job.result"]);
  assert.equal((db.connection.prepare("SELECT state FROM accepted_jobs WHERE attempt_id = 'attempt-1'").get() as { state: string }).state, "COMPLETED");
  const verifier = new WorkerConnectionVerifier("connection-1", "worker-1", workerKeys.publicKey, () => now);
  for (const frame of frames) assert.equal(verifier.verify(frame).ok, true);
  db.close();
});

test("worker rejects stale grant bindings and capability mismatches without accepting or executing", async () => {
  const setupResult = setup();
  const { now, grantKey, workerKeys, descriptor } = setupResult;
  const offer = { ...setupResult.offer, fencingToken: 8 };
  const db = new WorkerDatabase(":memory:");
  const frames: WorkerEnvelope[] = [];
  let executed = false;
  const runtime = new OutboundWorkerRuntime({
    workerId: "worker-1", connectionId: "connection-1", db, clock: () => now,
    transport: { async poll() { return [offer]; }, async send(frame) { frames.push(frame); } },
    adapter: { capabilityId: "cap-1", descriptor, async probe() { return "HEALTHY"; }, async execute() { executed = true; return { outcome: "COMPLETED", result: {} }; } },
    resolveGrantKey: (kid) => kid === grantKey.kid ? { kid, state: "ACTIVE", publicKey: grantKey.publicKey } : undefined,
    signFrame: (payload) => sign(null, payload, workerKeys.privateKey),
  });
  await runtime.pollOnce();
  assert.equal(executed, false);
  assert.equal(frames[0].type, "job.reject");
  assert.equal(db.connection.prepare("SELECT COUNT(*) AS count FROM accepted_jobs").get()!.count, 0);
  db.close();
});

test("worker rejects budget, sandbox, and approval bindings that differ from the signed grant", async () => {
  const setupResult = setup();
  const { now, grantKey, workerKeys, descriptor } = setupResult;
  const offer = { ...setupResult.offer, budget: { tokens: 1 } };
  const db = new WorkerDatabase(":memory:");
  const frames: WorkerEnvelope[] = [];
  let executed = false;
  const runtime = new OutboundWorkerRuntime({
    workerId: "worker-1", connectionId: "connection-1", db, clock: () => now,
    transport: { async poll() { return [offer]; }, async send(frame) { frames.push(frame); } },
    adapter: { capabilityId: "cap-1", descriptor, async probe() { return "HEALTHY"; }, async execute() { executed = true; return { outcome: "COMPLETED", result: {} }; } },
    resolveGrantKey: (kid) => kid === grantKey.kid ? { kid, state: "ACTIVE", publicKey: grantKey.publicKey } : undefined,
    signFrame: (payload) => sign(null, payload, workerKeys.privateKey),
  });
  await runtime.pollOnce();
  assert.equal(executed, false);
  assert.equal(frames[0].type, "job.reject");
  assert.equal(frames[0].payload.reason, "GRANT_BINDING_INVALID");
  assert.equal(db.connection.prepare("SELECT COUNT(*) AS count FROM consumed_grants").get()!.count, 0);
  db.close();
});

test("orchestrator dispatches an exactly-bound grant through the outbound worker and completes the goal", async () => {
  const now = 1_700_000_000_000;
  const grantKey = generateActionGrantKey("grant-1");
  const workerKeys = generateKeyPairSync("ed25519");
  const descriptorBase = { kind: "codex.execute", version: "1.0.0", health: "HEALTHY" as const, properties: { loginMode: "chatgpt", sandboxModes: ["workspace_write"], maxConcurrency: 1 } };
  const descriptor: CapabilityDescriptor = { ...descriptorBase, descriptorHash: sha256(canonicalJson(descriptorBase)) };
  const workerDb = new WorkerDatabase(":memory:");
  const queued: WorkerJobOffer[] = [];
  const frames: WorkerEnvelope[] = [];
  let issuedApprovalId: string | null = null;
  const worker = new OutboundWorkerRuntime({
    workerId: "worker-1", connectionId: "connection-1", db: workerDb, clock: () => now,
    transport: { async poll() { return queued.splice(0); }, async send(frame) { frames.push(frame); } },
    adapter: { capabilityId: "cap-1", descriptor, async probe() { return "HEALTHY"; }, async execute(job) { return { outcome: "COMPLETED", result: { taskId: job.taskId } }; } },
    resolveGrantKey: (kid) => kid === grantKey.kid ? { kid, state: "ACTIVE", publicKey: grantKey.publicKey } : undefined,
    signFrame: (payload) => sign(null, payload, workerKeys.privateKey),
  });
  let jti = 0;
  const execution = new WorkerExecutionPort(
    { resolve: () => ({ workerId: "worker-1", capabilityId: "cap-1", capabilityDescriptorHash: descriptor.descriptorHash, action: "codex.execute", resources: ["repo:test"] }) },
    { async issue(input) { jti += 1; if (input.hardStopApprovalId) issuedApprovalId = input.hardStopApprovalId; return signActionGrant({ iss: "pai-identity-gateway", sub: "pai-orchestrator", aud: input.audience, jti: `grant-${jti}`, iat: Math.floor(now / 1000), nbf: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 120, taskId: input.taskId, attemptId: input.attemptId, planDigest: input.planDigest, policyVersion: input.policyVersion, fencingToken: input.fencingToken, actions: input.actions, resources: input.resources, capabilityIds: input.capabilityIds, budget: input.budget, sandbox: input.sandbox, hardStopApprovalId: input.hardStopApprovalId }, grantKey); } },
    { async offer(job) { queued.push(job); const before = frames.length; await worker.pollOnce(); const result = frames.slice(before).find((frame) => frame.type === "job.result"); if (!result) return { status: "UNKNOWN", evidence: {} }; return { status: result.payload.outcome === "COMPLETED" ? "COMPLETED" : "FAILED", result: result.payload, evidence: { signedWorkerFrame: true } } as const; } },
    () => now,
  );
  const db = new OrchestratorDatabase(":memory:");
  const engine = new TaskEngine(db, () => now);
  const planner = { async createPlan(goal: { id: string; intent: string }) { return { schemaVersion: 1 as const, goalId: goal.id, revision: 1, intent: goal.intent, acceptanceCriteria: [{ id: "done", description: "worker result verified", verificationTaskId: `${goal.id}:verify` }], tasks: [{ taskId: `${goal.id}:work`, type: "codex.execute", title: "Work", required: true, sideEffectClass: "NON_IDEMPOTENT_MUTATION" as const, idempotencyKey: `${goal.id}:work`, capabilityRequirements: [{ action: "codex.execute" }], budget: { tokens: 100 }, sandbox: { filesystemRoots: ["repo:test"] } }, { taskId: `${goal.id}:verify`, type: "codex.execute", title: "Verify", dependsOn: [`${goal.id}:work`], required: true, sideEffectClass: "READ_ONLY" as const, capabilityRequirements: [{ action: "codex.execute" }] }] }; } };
  const runtime = new OrchestratorRuntime(db, engine, { planner, executor: execution, clock: () => now });
  const created = engine.createGoal({ intent: "worker end to end", source: { kind: "web" } }, "owner", "worker-e2e");
  await runtime.runUntilIdle();
  const approvalService = new ApprovalService(db, () => now);
  const approval = db.one<{ id: string; required_scope_json: string }>("SELECT id, required_scope_json FROM approval_requests WHERE task_id = ?", `${String(created.body.goalId)}:work`)!;
  approvalService.approve(approval.id, "owner", now, JSON.parse(approval.required_scope_json));
  await runtime.runUntilIdle();
  assert.equal(engine.getGoal(String(created.body.goalId))?.status, "COMPLETED");
  assert.equal(issuedApprovalId, approval.id);
  assert.equal(workerDb.connection.prepare("SELECT COUNT(*) AS count FROM accepted_jobs WHERE state = 'COMPLETED'").get()!.count, 2);
  assert.equal(workerDb.connection.prepare("SELECT COUNT(*) AS count FROM consumed_grants").get()!.count, 2);
  db.close(); workerDb.close();
});
