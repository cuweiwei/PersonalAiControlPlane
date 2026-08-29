import { createPublicKey, verify } from "node:crypto";
import { canonicalJson, sha256, uuidv7, type JsonValue } from "../../../packages/crypto/src/index.ts";
import { signActionGrantWithOpaqueSigner, type ActionGrantClaims, type ActionGrantKeyState } from "../../../packages/identity/src/index.ts";
import { IdentityDatabase } from "./db.ts";

export type OpaqueSigningKeyAuthority = {
  sign(privateKeyRef: string, signingInput: Buffer): Buffer | Promise<Buffer>;
};

export type WorkloadRequestProof = {
  workloadId: string;
  timestamp: number;
  nonce: string;
  signature: string;
  idempotencyKey: string;
  method: "POST";
  path: "/api/v1/workloads/action-grants";
};

export type ActionGrantIssueInput = {
  audience: string;
  taskId: string;
  attemptId: string;
  planDigest: string;
  policyVersion: number;
  fencingToken: number;
  actions: string[];
  resources: string[];
  capabilityIds: string[];
  budget: Record<string, JsonValue>;
  sandbox: Record<string, JsonValue>;
  hardStopApprovalId: string | null;
  expiresInSeconds?: number;
};

export type IssuedActionGrant = { token: string; jti: string; kid: string; expiresAt: number; replayed: boolean };

export function workloadRequestSigningPayload(proof: Omit<WorkloadRequestProof, "signature" | "workloadId">, body: ActionGrantIssueInput): string {
  return canonicalJson({ method: proof.method, path: proof.path, timestamp: proof.timestamp, nonce: proof.nonce, idempotencyKey: proof.idempotencyKey, bodyDigest: sha256(canonicalJson(body as unknown as JsonValue)) } as unknown as JsonValue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 500) throw new Error(`INVALID_${name.toUpperCase()}`);
  return value;
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50 || value.some((item) => typeof item !== "string" || item.length === 0 || item.length > 500)) throw new Error(`INVALID_${name.toUpperCase()}`);
  return [...value];
}

export function parseActionGrantIssueInput(value: unknown): ActionGrantIssueInput {
  if (!isRecord(value)) throw new Error("INVALID_GRANT_REQUEST");
  const allowed = ["audience", "taskId", "attemptId", "planDigest", "policyVersion", "fencingToken", "actions", "resources", "capabilityIds", "budget", "sandbox", "hardStopApprovalId", "expiresInSeconds"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("UNKNOWN_GRANT_REQUEST_FIELD");
  if (!Number.isInteger(value.policyVersion) || Number(value.policyVersion) < 1 || !Number.isInteger(value.fencingToken) || Number(value.fencingToken) < 1) throw new Error("INVALID_GRANT_BINDING");
  if (!isRecord(value.budget) || !isRecord(value.sandbox)) throw new Error("INVALID_GRANT_BOUNDS");
  canonicalJson(value.budget as JsonValue);
  canonicalJson(value.sandbox as JsonValue);
  const expiresInSeconds = value.expiresInSeconds === undefined ? 300 : Number(value.expiresInSeconds);
  if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 300) throw new Error("INVALID_GRANT_LIFETIME");
  return {
    audience: stringField(value.audience, "audience"),
    taskId: stringField(value.taskId, "task_id"),
    attemptId: stringField(value.attemptId, "attempt_id"),
    planDigest: stringField(value.planDigest, "plan_digest"),
    policyVersion: Number(value.policyVersion),
    fencingToken: Number(value.fencingToken),
    actions: stringArray(value.actions, "actions"),
    resources: stringArray(value.resources, "resources"),
    capabilityIds: stringArray(value.capabilityIds, "capability_ids"),
    budget: value.budget as Record<string, JsonValue>,
    sandbox: value.sandbox as Record<string, JsonValue>,
    hardStopApprovalId: value.hardStopApprovalId === null ? null : stringField(value.hardStopApprovalId, "hard_stop_approval_id"),
    expiresInSeconds,
  };
}

export class WorkloadActionGrantService {
  private readonly db: IdentityDatabase;
  private readonly keyAuthority: OpaqueSigningKeyAuthority;
  private readonly clock: () => number;

  constructor(db: IdentityDatabase, keyAuthority: OpaqueSigningKeyAuthority, clock: () => number = Date.now) {
    this.db = db;
    this.keyAuthority = keyAuthority;
    this.clock = clock;
  }

  registerWorkload(kind: string, subject: string, publicKeyPem: string, ttlMs = 24 * 60 * 60 * 1000): string {
    if (!kind || !subject || !publicKeyPem || !Number.isInteger(ttlMs) || ttlMs < 60_000) throw new Error("INVALID_WORKLOAD_IDENTITY");
    createPublicKey(publicKeyPem);
    const id = uuidv7(this.clock());
    const now = this.clock();
    this.db.run("INSERT INTO workload_identities(id, kind, subject, public_key_pem, status, issued_at, expires_at) VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?)", id, kind, subject, publicKeyPem, now, now + ttlMs);
    return id;
  }

  registerSigningKey(kid: string, publicKeyPem: string, privateKeyRef: string, state: ActionGrantKeyState = "PENDING"): void {
    if (!kid || !privateKeyRef || !["PENDING", "ACTIVE"].includes(state)) throw new Error("INVALID_SIGNING_KEY");
    createPublicKey(publicKeyPem);
    if (state === "ACTIVE" && this.db.one("SELECT kid FROM signing_keys WHERE state = 'ACTIVE'")) throw new Error("ACTIVE_SIGNING_KEY_EXISTS");
    const now = this.clock();
    this.db.run("INSERT INTO signing_keys(kid, public_key_pem, private_key_ref, state, created_at, activated_at) VALUES (?, ?, ?, ?, ?, ?)", kid, publicKeyPem, privateKeyRef, state, now, state === "ACTIVE" ? now : null);
  }

  verifyRequest(proof: WorkloadRequestProof, body: ActionGrantIssueInput): { workloadId: string; subject: string } {
    const now = this.clock();
    if (!proof.workloadId || !proof.nonce || proof.nonce.length > 200 || !proof.idempotencyKey || proof.idempotencyKey.length > 200 || !Number.isInteger(proof.timestamp) || Math.abs(now - proof.timestamp) > 60_000) throw new Error("WORKLOAD_PROOF_INVALID");
    const workload = this.db.one<{ id: string; subject: string; public_key_pem: string; status: string; expires_at: number }>("SELECT id, subject, public_key_pem, status, expires_at FROM workload_identities WHERE id = ?", proof.workloadId);
    if (!workload || workload.status !== "ACTIVE" || workload.expires_at <= now) throw new Error("WORKLOAD_IDENTITY_UNAVAILABLE");
    if (!/^[A-Za-z0-9_-]+$/.test(proof.signature)) throw new Error("WORKLOAD_SIGNATURE_INVALID");
    const signed = workloadRequestSigningPayload(proof, body);
    let valid = false;
    try { valid = verify(null, Buffer.from(signed, "utf8"), createPublicKey(workload.public_key_pem), Buffer.from(proof.signature, "base64url")); } catch { valid = false; }
    if (!valid) throw new Error("WORKLOAD_SIGNATURE_INVALID");
    try {
      this.db.run("INSERT INTO workload_request_nonces(workload_id, nonce, expires_at, consumed_at) VALUES (?, ?, ?, ?)", workload.id, proof.nonce, now + 10 * 60_000, now);
    } catch {
      throw new Error("WORKLOAD_REQUEST_REPLAY");
    }
    return { workloadId: workload.id, subject: workload.subject };
  }

  async issue(proof: WorkloadRequestProof, input: ActionGrantIssueInput): Promise<IssuedActionGrant> {
    const workload = this.verifyRequest(proof, input);
    const requestDigest = sha256(canonicalJson(input as unknown as JsonValue));
    const existing = this.db.one<{ request_digest: string; response_json: string; expires_at: number }>("SELECT request_digest, response_json, expires_at FROM workload_idempotency WHERE workload_id = ? AND key = ?", workload.workloadId, proof.idempotencyKey);
    if (existing) {
      if (existing.request_digest !== requestDigest) throw new Error("IDEMPOTENCY_CONFLICT");
      if (existing.expires_at <= this.clock()) throw new Error("IDEMPOTENCY_RECORD_EXPIRED");
      return { ...JSON.parse(existing.response_json) as Omit<IssuedActionGrant, "replayed">, replayed: true };
    }
    const key = this.db.one<{ kid: string; private_key_ref: string; state: ActionGrantKeyState }>("SELECT kid, private_key_ref, state FROM signing_keys WHERE state = 'ACTIVE' ORDER BY activated_at DESC LIMIT 1");
    if (!key) throw new Error("SIGNING_KEY_UNAVAILABLE");
    const nowSeconds = Math.floor(this.clock() / 1000);
    const jti = uuidv7(this.clock());
    const expiresAt = nowSeconds + (input.expiresInSeconds ?? 300);
    const claims: ActionGrantClaims = {
      iss: "pai-identity-gateway",
      sub: workload.subject,
      aud: input.audience,
      jti,
      iat: nowSeconds,
      nbf: nowSeconds,
      exp: expiresAt,
      taskId: input.taskId,
      attemptId: input.attemptId,
      planDigest: input.planDigest,
      policyVersion: input.policyVersion,
      fencingToken: input.fencingToken,
      actions: input.actions,
      resources: input.resources,
      capabilityIds: input.capabilityIds,
      budget: input.budget,
      sandbox: input.sandbox,
      hardStopApprovalId: input.hardStopApprovalId,
    };
    const token = await signActionGrantWithOpaqueSigner(claims, { kid: key.kid, state: key.state, sign: (signingInput) => this.keyAuthority.sign(key.private_key_ref, signingInput) });
    const response = { token, jti, kid: key.kid, expiresAt };
    this.db.run("INSERT INTO workload_idempotency(workload_id, key, request_digest, response_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)", workload.workloadId, proof.idempotencyKey, requestDigest, JSON.stringify(response), this.clock(), expiresAt * 1000);
    this.db.run("INSERT INTO identity_audit_events(event_id, actor, action, target, metadata_json, occurred_at) VALUES (?, ?, 'action-grant.issued', ?, ?, ?)", uuidv7(this.clock()), workload.subject, `task:${input.taskId}`, JSON.stringify({ audience: input.audience, attemptId: input.attemptId, kid: key.kid, jti, expiresAt }), this.clock());
    return { ...response, replayed: false };
  }

  verificationKeys(): Array<{ kid: string; state: ActionGrantKeyState; publicKeyPem: string }> {
    return this.db.all<{ kid: string; state: ActionGrantKeyState; public_key_pem: string }>("SELECT kid, state, public_key_pem FROM signing_keys WHERE state IN ('ACTIVE', 'RETIRING') ORDER BY kid").map((row) => ({ kid: row.kid, state: row.state, publicKeyPem: row.public_key_pem }));
  }
}
