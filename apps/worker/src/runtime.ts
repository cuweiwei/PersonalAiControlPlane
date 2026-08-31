import { canonicalJson, sha256, uuidv7, type JsonValue } from "../../../packages/crypto/src/index.ts";
import { verifyActionGrant, type ActionGrantVerificationKey } from "../../../packages/identity/src/index.ts";
import { signWorkerEnvelopeWithSigner, validateJobOffer, type CapabilityDescriptor, type WorkerEnvelope } from "../../../packages/worker/src/index.ts";
import { WorkerDatabase } from "./db.ts";

export type WorkerJobOffer = {
  workerId: string;
  capabilityId: string;
  capabilityDescriptorHash: string;
  attemptId: string;
  taskId: string;
  planDigest: string;
  policyVersion: number;
  fencingToken: number;
  leaseId: string;
  requiredAction: string;
  resources: string[];
  budget: Record<string, JsonValue>;
  sandbox: Record<string, JsonValue>;
  hardStopApprovalId: string | null;
  actionGrant: string;
  input: Record<string, JsonValue>;
};

export type WorkerCapabilityAdapter = {
  capabilityId: string;
  descriptor: CapabilityDescriptor;
  probe(): Promise<"HEALTHY" | "DEGRADED" | "UNHEALTHY">;
  execute(job: WorkerJobOffer): Promise<{ outcome: "COMPLETED" | "FAILED"; result: Record<string, JsonValue>; checkpoint?: Record<string, JsonValue> }>;
};

export type OutboundWorkerTransport = {
  poll(): Promise<WorkerJobOffer[]>;
  send(frame: WorkerEnvelope): Promise<void>;
};

export type WorkerRuntimeOptions = {
  workerId: string;
  connectionId: string;
  db: WorkerDatabase;
  transport: OutboundWorkerTransport;
  adapter: WorkerCapabilityAdapter;
  resolveGrantKey(kid: string): ActionGrantVerificationKey | undefined;
  signFrame(payload: Buffer): Buffer | Promise<Buffer>;
  clock?: () => number;
};

export class OutboundWorkerRuntime {
  private readonly options: WorkerRuntimeOptions;
  private readonly clock: () => number;
  constructor(options: WorkerRuntimeOptions) { this.options = options; this.clock = options.clock ?? Date.now; }

  async pollOnce(): Promise<number> {
    const offers = await this.options.transport.poll();
    for (const offer of offers) await this.processOffer(offer);
    return offers.length;
  }

  async heartbeat(): Promise<void> {
    await this.send("worker.heartbeat", {
      health: await this.options.adapter.probe(),
      capabilityId: this.options.adapter.capabilityId,
      capabilityDescriptorHash: this.options.adapter.descriptor.descriptorHash,
    });
  }

  private async processOffer(offer: WorkerJobOffer): Promise<void> {
    if (offer.workerId !== this.options.workerId) return this.reject(offer, "WORKER_MISMATCH");
    const existing = this.options.db.connection.prepare("SELECT offer_digest, state, result_json FROM accepted_jobs WHERE attempt_id = ?").get(offer.attemptId) as { offer_digest: string; state: string; result_json: string | null } | undefined;
    const offerDigest = sha256(canonicalJson(offer as unknown as JsonValue));
    if (existing) {
      if (existing.offer_digest !== offerDigest) return this.reject(offer, "OFFER_REPLAY_CONFLICT");
      if (existing.result_json) await this.send("job.result", JSON.parse(existing.result_json));
      return;
    }
    if (offer.capabilityId !== this.options.adapter.capabilityId || offer.capabilityDescriptorHash !== this.options.adapter.descriptor.descriptorHash) return this.reject(offer, "CAPABILITY_MISMATCH");
    if (await this.options.adapter.probe() !== "HEALTHY") return this.reject(offer, "CAPABILITY_UNHEALTHY");
    const grant = verifyActionGrant(offer.actionGrant, {
      issuer: "pai-identity-gateway",
      audience: `pai-worker:${this.options.workerId}`,
      taskId: offer.taskId,
      attemptId: offer.attemptId,
      planDigest: offer.planDigest,
      policyVersion: offer.policyVersion,
      fencingToken: offer.fencingToken,
      allowedActions: [offer.requiredAction],
      allowedResources: offer.resources,
      allowedCapabilityIds: [offer.capabilityId],
      expectedBudget: offer.budget,
      expectedSandbox: offer.sandbox,
      hardStopApprovalId: offer.hardStopApprovalId,
      resolveKey: this.options.resolveGrantKey,
      consumeJti: (jti, exp) => this.consumeGrant(jti, exp),
      nowSeconds: Math.floor(this.clock() / 1000),
    });
    if (!grant.ok) return this.reject(offer, grant.code.toUpperCase().replaceAll(".", "_"));
    const validation = validateJobOffer({
      workerId: offer.workerId,
      capabilityId: offer.capabilityId,
      capabilityDescriptorHash: offer.capabilityDescriptorHash,
      attemptId: offer.attemptId,
      planDigest: offer.planDigest,
      fencingToken: offer.fencingToken,
      leaseId: offer.leaseId,
      grantDigest: grant.grant.grantDigest,
      grantActions: grant.grant.claims.actions,
      requiredAction: offer.requiredAction,
    }, {
      workerId: this.options.workerId,
      capabilityId: this.options.adapter.capabilityId,
      capabilityDescriptorHash: this.options.adapter.descriptor.descriptorHash,
      attemptId: offer.attemptId,
      planDigest: offer.planDigest,
      fencingToken: offer.fencingToken,
      leaseId: offer.leaseId,
      grantDigest: grant.grant.grantDigest,
      requiredAction: offer.requiredAction,
    });
    if (!validation.valid) return this.reject(offer, validation.reason.toUpperCase().replaceAll("-", "_"));
    const active = this.options.db.connection.prepare("SELECT attempt_id FROM accepted_jobs WHERE capability_id = ? AND state IN ('ACCEPTED', 'RUNNING')").get(offer.capabilityId);
    if (active) return this.reject(offer, "CAPABILITY_BUSY");
    this.options.db.connection.prepare("INSERT INTO accepted_jobs(attempt_id, task_id, capability_id, offer_digest, fencing_token, state, accepted_at, updated_at) VALUES (?, ?, ?, ?, ?, 'ACCEPTED', ?, ?)").run(offer.attemptId, offer.taskId, offer.capabilityId, offerDigest, offer.fencingToken, this.clock(), this.clock());
    await this.send("job.accept", { attemptId: offer.attemptId, taskId: offer.taskId, fencingToken: offer.fencingToken });
    this.options.db.connection.prepare("UPDATE accepted_jobs SET state = 'RUNNING', updated_at = ? WHERE attempt_id = ? AND state = 'ACCEPTED'").run(this.clock(), offer.attemptId);
    let execution: { outcome: "COMPLETED" | "FAILED"; result: Record<string, JsonValue>; checkpoint?: Record<string, JsonValue> };
    try { execution = await this.options.adapter.execute(offer); } catch { execution = { outcome: "FAILED", result: { code: "ADAPTER_EXECUTION_FAILED" } }; }
    const result = { attemptId: offer.attemptId, taskId: offer.taskId, fencingToken: offer.fencingToken, outcome: execution.outcome, result: execution.result, checkpoint: execution.checkpoint ?? null };
    this.options.db.connection.prepare("UPDATE accepted_jobs SET state = ?, checkpoint_json = ?, result_json = ?, updated_at = ? WHERE attempt_id = ? AND fencing_token = ?").run(execution.outcome, execution.checkpoint ? JSON.stringify(execution.checkpoint) : null, JSON.stringify(result), this.clock(), offer.attemptId, offer.fencingToken);
    await this.send("job.result", result);
  }

  private consumeGrant(jti: string, exp: number): boolean {
    try {
      this.options.db.connection.prepare("INSERT INTO consumed_grants(jti, expires_at, consumed_at) VALUES (?, ?, ?)").run(jti, exp, Math.floor(this.clock() / 1000));
      return true;
    } catch { return false; }
  }

  private async reject(offer: WorkerJobOffer, reason: string): Promise<void> {
    await this.send("job.reject", { attemptId: offer.attemptId, taskId: offer.taskId, fencingToken: offer.fencingToken, reason });
  }

  private async send(type: WorkerEnvelope["type"], payload: Record<string, JsonValue>): Promise<void> {
    const sequence = this.options.db.transaction(() => {
      const current = Number((this.options.db.connection.prepare("SELECT value FROM worker_state WHERE key = 'sequence'").get() as { value: string }).value);
      const next = current + 1;
      this.options.db.connection.prepare("UPDATE worker_state SET value = ? WHERE key = 'sequence'").run(String(next));
      return next;
    });
    const frame = await signWorkerEnvelopeWithSigner({ protocolVersion: "1.0", messageId: uuidv7(this.clock()), connectionId: this.options.connectionId, sequence, workerId: this.options.workerId, sentAt: new Date(this.clock()).toISOString(), nonce: uuidv7(this.clock()).replaceAll("-", ""), type, payload }, this.options.signFrame);
    await this.options.transport.send(frame);
  }
}
