import { createPublicKey, randomBytes, type KeyObject } from "node:crypto";
import { canonicalJson, sha256, uuidv7, type JsonValue } from "../../../packages/crypto/src/index.ts";
import {
  createWorkerCredential,
  hashWorkerCredential,
  verifyEnrollmentProofSignature,
  verifyWorkerCredential,
  WorkerConnectionVerifier,
  type WorkerCredentialRecord,
  type WorkerEnvelope,
} from "../../../packages/worker/src/index.ts";
import type { WorkerJobOffer } from "../../worker/src/runtime.ts";
import { OrchestratorDatabase } from "./db.ts";

export type WorkerPollInput = {
  workerId: string;
  credential: string;
  connectionId: string;
  hello?: WorkerEnvelope;
};

export type WorkerPollResult = {
  connectionId: string;
  generation: number;
  offers: WorkerJobOffer[];
  heartbeatAt: number;
};

export type WorkerResult =
  | { status: "COMPLETED"; result: Record<string, JsonValue>; evidence: Record<string, JsonValue> }
  | { status: "FAILED"; evidence: Record<string, JsonValue> }
  | { status: "UNKNOWN"; externalOperationId?: string | null; evidence: Record<string, JsonValue> };

type PendingResult = { resolve: (result: WorkerResult) => void; timer: ReturnType<typeof setTimeout> };

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function publicKeyFromPem(pem: string): KeyObject {
  return createPublicKey(pem);
}

export class WorkerChannelService {
  private readonly db: OrchestratorDatabase;
  private readonly pending = new Map<string, PendingResult>();
  private readonly clocks: () => number;
  constructor(db: OrchestratorDatabase, clock: () => number = Date.now) {
    this.db = db;
    this.clocks = clock;
  }

  finalizeEnrollment(input: { requestId: string; challenge: string; serverNonce: string; workerSignature: string; now?: number }): { workerId: string; credential: string; credentialId: string; expiresAt: number; fingerprint: string } {
    const now = input.now ?? this.clocks();
    const request = this.db.one<{ id: string; public_key_pem: string; fingerprint: string; device_summary_json: string; challenge_hash: string; status: string; expires_at: number; finalized_worker_id: string | null }>("SELECT id, public_key_pem, fingerprint, device_summary_json, challenge_hash, status, expires_at, finalized_worker_id FROM worker_enrollment_requests WHERE id = ?", input.requestId);
    if (!request) throw Object.assign(new Error("worker enrollment request not found"), { status: 404, code: "ENROLLMENT_NOT_FOUND" });
    if (request.status !== "APPROVED") throw Object.assign(new Error("worker enrollment request is not approved"), { status: 409, code: "ENROLLMENT_NOT_APPROVED" });
    if (request.finalized_worker_id) throw Object.assign(new Error("worker enrollment request has already been finalized"), { status: 409, code: "ENROLLMENT_ALREADY_FINALIZED" });
    if (request.expires_at <= now) throw Object.assign(new Error("worker enrollment request has expired"), { status: 409, code: "ENROLLMENT_EXPIRED" });
    if (sha256(input.challenge) !== request.challenge_hash) throw Object.assign(new Error("worker enrollment challenge does not match"), { status: 409, code: "ENROLLMENT_CHALLENGE_MISMATCH" });
    let publicKey: KeyObject;
    try { publicKey = publicKeyFromPem(request.public_key_pem); } catch { throw Object.assign(new Error("worker public key is invalid"), { status: 400, code: "INVALID_ENROLLMENT_KEY" }); }
    if (!verifyEnrollmentProofSignature(input.challenge, input.serverNonce, input.workerSignature, publicKey)) throw Object.assign(new Error("worker enrollment proof is invalid"), { status: 401, code: "ENROLLMENT_PROOF_INVALID" });
    const summary = asRecord(JSON.parse(request.device_summary_json));
    const workerId = uuidv7(now);
    const credential = createWorkerCredential(workerId, now);
    const credentialHash = hashWorkerCredential(credential.secret);
    const name = typeof summary.name === "string" && summary.name.trim().length > 0 ? summary.name.trim().slice(0, 120) : `Worker ${workerId.slice(0, 8)}`;
    const platform = typeof summary.platform === "string" ? summary.platform.slice(0, 40) : "unknown";
    this.db.transaction(() => {
      this.db.run("INSERT INTO workers(id, identity_subject, name, platform, trust_state, protocol_min, protocol_max, public_key_pem, fingerprint, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, 'TRUSTED', '1.0', '1.0', ?, ?, ?, ?, ?)", workerId, `worker:${workerId}`, name, platform, request.public_key_pem, request.fingerprint, JSON.stringify(summary), now, now);
      this.db.run("INSERT INTO worker_credentials(id, worker_id, secret_hash, issued_at, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)", credential.id, workerId, credentialHash, credential.issuedAt, credential.expiresAt, now);
      const finalized = this.db.connection.prepare("UPDATE worker_enrollment_requests SET decided_at = COALESCE(decided_at, ?), status = 'APPROVED', finalized_worker_id = ? WHERE id = ? AND finalized_worker_id IS NULL").run(now, workerId, input.requestId);
      if (Number(finalized.changes) !== 1) throw Object.assign(new Error("worker enrollment request has already been finalized"), { status: 409, code: "ENROLLMENT_ALREADY_FINALIZED" });
    });
    return { workerId, credential: credential.secret, credentialId: credential.id, expiresAt: credential.expiresAt, fingerprint: request.fingerprint };
  }

  authenticate(workerId: string, credential: string, now = this.clocks()): { publicKey: KeyObject; fingerprint: string } | undefined {
    const row = this.db.one<{ public_key_pem: string | null; fingerprint: string | null }>("SELECT public_key_pem, fingerprint FROM workers WHERE id = ? AND trust_state = 'TRUSTED'", workerId);
    if (!row?.public_key_pem || !row.fingerprint) return undefined;
    const credentialRow = this.db.one<WorkerCredentialRecord>("SELECT id, worker_id AS workerId, issued_at AS issuedAt, expires_at AS expiresAt, secret_hash AS secretHash, revoked_at AS revokedAt FROM worker_credentials WHERE worker_id = ? AND revoked_at IS NULL ORDER BY issued_at DESC LIMIT 1", workerId);
    if (!credentialRow || credentialRow.workerId !== workerId || !verifyWorkerCredential(credential, credentialRow, now)) return undefined;
    try { return { publicKey: publicKeyFromPem(row.public_key_pem), fingerprint: row.fingerprint }; } catch { return undefined; }
  }

  rotateCredential(workerId: string, currentCredential: string): { credentialId: string; credential: string; expiresAt: number } {
    const now = this.clocks();
    if (!this.authenticate(workerId, currentCredential, now)) throw Object.assign(new Error("worker credential is invalid or expired"), { status: 401, code: "WORKER_AUTH_REQUIRED" });
    const next = createWorkerCredential(workerId, now);
    this.db.transaction(() => {
      this.db.run("UPDATE worker_credentials SET revoked_at = ? WHERE worker_id = ? AND revoked_at IS NULL", now, workerId);
      this.db.run("INSERT INTO worker_credentials(id, worker_id, secret_hash, issued_at, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)", next.id, workerId, hashWorkerCredential(next.secret), next.issuedAt, next.expiresAt, now);
    });
    return { credentialId: next.id, credential: next.secret, expiresAt: next.expiresAt };
  }

  poll(input: WorkerPollInput): WorkerPollResult {
    const now = this.clocks();
    const auth = this.authenticate(input.workerId, input.credential, now);
    if (!auth) throw Object.assign(new Error("worker credential is invalid or expired"), { status: 401, code: "WORKER_AUTH_REQUIRED" });
    const current = this.db.one<{ connection_id: string; generation: number; last_sequence: number }>("SELECT connection_id, generation, last_sequence FROM worker_connections WHERE worker_id = ?", input.workerId);
    const connectionId = input.connectionId || current?.connection_id || randomBytes(16).toString("hex");
    let generation = current?.generation ?? 0;
    if (!current || current.connection_id !== connectionId) {
      generation += 1;
      this.db.run("INSERT INTO worker_connections(worker_id, connection_id, generation, last_sequence, state, updated_at) VALUES (?, ?, ?, -1, 'CONNECTED', ?) ON CONFLICT(worker_id) DO UPDATE SET connection_id = excluded.connection_id, generation = excluded.generation, last_sequence = -1, state = 'CONNECTED', updated_at = excluded.updated_at", input.workerId, connectionId, generation, now);
    }
    if (input.hello) this.receive(input.workerId, input.credential, input.hello);
    const rows = this.db.all<{ id: string; type: string; payload_json: string; attempt_id: string | null }>("SELECT id, type, payload_json, attempt_id FROM worker_channel_messages WHERE worker_id = ? AND (status = 'QUEUED' OR (status = 'DELIVERED' AND (connection_id IS NULL OR connection_id <> ?))) ORDER BY created_at LIMIT 20", input.workerId, connectionId);
    const offers: WorkerJobOffer[] = [];
    for (const row of rows) {
      if (row.type !== "job.offer") continue;
      try {
        offers.push(JSON.parse(row.payload_json) as WorkerJobOffer);
        this.db.run("UPDATE worker_channel_messages SET status = 'DELIVERED', connection_id = ?, delivered_at = ? WHERE id = ? AND status IN ('QUEUED', 'DELIVERED')", connectionId, now, row.id);
      } catch {
        this.db.run("UPDATE worker_channel_messages SET status = 'FAILED' WHERE id = ?", row.id);
      }
    }
    this.db.run("UPDATE workers SET last_heartbeat_at = ?, stale_at = ?, updated_at = ? WHERE id = ?", now, now + 90_000, now, input.workerId);
    this.db.run("UPDATE worker_connections SET last_heartbeat_at = ?, state = 'CONNECTED', updated_at = ? WHERE worker_id = ?", now, now, input.workerId);
    return { connectionId, generation, offers, heartbeatAt: now };
  }

  receive(workerId: string, credential: string, frame: WorkerEnvelope): void {
    const now = this.clocks();
    const auth = this.authenticate(workerId, credential, now);
    if (!auth) throw Object.assign(new Error("worker credential is invalid or expired"), { status: 401, code: "WORKER_AUTH_REQUIRED" });
    const connection = this.db.one<{ connection_id: string; last_sequence: number }>("SELECT connection_id, last_sequence FROM worker_connections WHERE worker_id = ?", workerId);
    if (!connection || connection.connection_id !== frame.connectionId) throw Object.assign(new Error("worker connection is not active"), { status: 409, code: "WORKER_CONNECTION_MISMATCH" });
    const verifier = new WorkerConnectionVerifier(frame.connectionId, workerId, auth.publicKey, () => now);
    const verification = verifier.verify(frame);
    if (!verification.ok || frame.sequence <= connection.last_sequence) throw Object.assign(new Error(verification.ok ? "worker frame sequence is not increasing" : verification.message), { status: 409, code: verification.ok ? "WORKER_SEQUENCE_REPLAY" : verification.code });
    const duplicate = this.db.one("SELECT message_id FROM worker_channel_inbound_messages WHERE worker_id = ? AND connection_id = ? AND message_id = ?", workerId, frame.connectionId, frame.messageId);
    if (duplicate) throw Object.assign(new Error("worker message was already accepted"), { status: 409, code: "WORKER_MESSAGE_REPLAY" });
    this.db.run("INSERT INTO worker_channel_inbound_messages(worker_id, connection_id, message_id, sequence, accepted_at) VALUES (?, ?, ?, ?, ?)", workerId, frame.connectionId, frame.messageId, frame.sequence, now);
    this.db.run("UPDATE worker_connections SET last_sequence = ?, last_heartbeat_at = ?, updated_at = ? WHERE worker_id = ?", frame.sequence, now, now, workerId);
    this.db.run("UPDATE workers SET last_heartbeat_at = ?, stale_at = ?, updated_at = ? WHERE id = ?", now, now + 90_000, now, workerId);
    const payload = asRecord(frame.payload);
    if (frame.type === "job.result" || frame.type === "job.reject") {
      const attemptId = typeof payload.attemptId === "string" ? payload.attemptId : undefined;
      if (attemptId) {
        this.db.run("UPDATE worker_channel_messages SET status = 'ACKED', acked_at = ? WHERE worker_id = ? AND attempt_id = ? AND status IN ('QUEUED', 'DELIVERED')", now, workerId, attemptId);
        const pending = this.pending.get(attemptId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(attemptId);
          if (frame.type === "job.result") pending.resolve({ status: payload.outcome === "COMPLETED" ? "COMPLETED" : "FAILED", result: (payload.result && typeof payload.result === "object" ? payload.result : {}) as Record<string, JsonValue>, evidence: { signedWorkerFrame: true } });
          else pending.resolve({ status: "FAILED", evidence: { code: typeof payload.reason === "string" ? payload.reason : "WORKER_REJECTED" } });
        }
      }
    }
  }

  queueOffer(job: WorkerJobOffer): void {
    const now = this.clocks();
    const payload = canonicalJson(job as unknown as JsonValue);
    this.db.run("INSERT INTO worker_channel_messages(id, worker_id, connection_id, attempt_id, type, payload_json, status, created_at) VALUES (?, ?, NULL, ?, 'job.offer', ?, 'QUEUED', ?)", uuidv7(now), job.workerId, job.attemptId, payload, now);
  }

  offer(job: WorkerJobOffer, timeoutMs = 30 * 60_000): Promise<WorkerResult> {
    this.queueOffer(job);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(job.attemptId);
        resolve({ status: "UNKNOWN", evidence: { code: "WORKER_RESULT_TIMEOUT" } });
      }, timeoutMs);
      this.pending.set(job.attemptId, { resolve, timer });
    });
  }

  close(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ status: "UNKNOWN", evidence: { code: "WORKER_CHANNEL_STOPPED" } });
    }
    this.pending.clear();
  }
}

/** Adapter for the existing ExecutionPort contract; HTTP remains asynchronous
 * and the durable queue is the source of truth for reconnect/replay. */
export class WorkerChannelOfferPort {
  private readonly channel: WorkerChannelService;
  constructor(channel: WorkerChannelService) { this.channel = channel; }
  offer(job: WorkerJobOffer): Promise<WorkerResult> { return this.channel.offer(job); }
}
