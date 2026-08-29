import { createHash } from "node:crypto";
import { canonicalJson, sha256, uuidv7 } from "../../../packages/crypto/src/index.ts";
import { OrchestratorDatabase } from "./db.ts";

export type ApprovalStatus = "OPEN" | "APPROVED" | "REJECTED" | "EXPIRED" | "CANCELLED";

export type ApprovalBounds = {
  actions: string[];
  resources: string[];
  capabilityIds: string[];
  workers: string[];
  filesystemRoots: string[];
  networkDestinations: string[];
  recipients: string[];
  mergeMode: string;
  deploymentMode: string;
  budget: Record<string, number>;
};

export type ApprovalRequest = {
  id: string;
  goalId: string;
  taskId: string | null;
  planDigest: string;
  policyVersion: number;
  requiredScope: ApprovalBounds;
  risk: Record<string, unknown>;
  channelLimits: Record<string, unknown>;
  status: ApprovalStatus;
  expiresAt: number;
  correlationId: string | null;
  createdAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
};

export type ApprovalGrant = {
  id: string;
  requestId: string;
  signedGrantDigest: string;
  boundedScope: ApprovalBounds;
  approver: string;
  authTime: number;
  issuedAt: number;
  expiresAt: number;
  revokedAt: number | null;
};

function asJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function subset(requested: readonly string[], approved: readonly string[]): boolean {
  return approved.every((value) => requested.includes(value));
}

function modeWithin(requested: string, approved: string): boolean {
  if (requested === approved) return true;
  if (approved === "none" && requested !== "none") return true;
  return false;
}

function validBounds(value: unknown): value is ApprovalBounds {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const bounds = value as Record<string, unknown>;
  const arrays = ["actions", "resources", "capabilityIds", "workers", "filesystemRoots", "networkDestinations", "recipients"];
  if (arrays.some((key) => !Array.isArray(bounds[key]) || (bounds[key] as unknown[]).some((entry) => typeof entry !== "string"))) return false;
  if (typeof bounds.mergeMode !== "string" || typeof bounds.deploymentMode !== "string" || !bounds.budget || typeof bounds.budget !== "object" || Array.isArray(bounds.budget)) return false;
  return Object.values(bounds.budget as Record<string, unknown>).every((entry) => typeof entry === "number" && Number.isFinite(entry) && entry >= 0);
}

function scopeWithin(requested: ApprovalBounds, approved: ApprovalBounds): boolean {
  if (!subset(requested.actions, approved.actions) || !subset(requested.resources, approved.resources) || !subset(requested.capabilityIds, approved.capabilityIds) || !subset(requested.workers, approved.workers) || !subset(requested.filesystemRoots, approved.filesystemRoots) || !subset(requested.networkDestinations, approved.networkDestinations) || !subset(requested.recipients, approved.recipients)) return false;
  if (!modeWithin(requested.mergeMode, approved.mergeMode) || !modeWithin(requested.deploymentMode, approved.deploymentMode)) return false;
  return Object.entries(approved.budget).every(([key, value]) => Number.isFinite(value) && value >= 0 && requested.budget[key] !== undefined && value <= requested.budget[key]) && Object.keys(requested.budget).every((key) => approved.budget[key] === undefined || Object.prototype.hasOwnProperty.call(requested.budget, key));
}

export class ApprovalService {
  private readonly db: OrchestratorDatabase;
  private readonly clock: () => number;

  constructor(db: OrchestratorDatabase, clock: () => number = Date.now) {
    this.db = db;
    this.clock = clock;
  }

  createRequest(input: {
    goalId: string;
    taskId?: string | null;
    planDigest: string;
    policyVersion: number;
    requiredScope: ApprovalBounds;
    risk?: Record<string, unknown>;
    channelLimits?: Record<string, unknown>;
    expiresAt: number;
    correlationId?: string | null;
  }): ApprovalRequest {
    const now = this.clock();
    if (!input.goalId || !input.planDigest || !Number.isInteger(input.policyVersion) || input.policyVersion < 1 || input.expiresAt <= now || !validBounds(input.requiredScope)) throw new Error("approval request is invalid or already expired");
    const id = uuidv7(now);
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO approval_requests
         (id, goal_id, task_id, plan_digest, policy_version, required_scope_json, risk_json, channel_limits_json,
          status, expires_at, correlation_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?)`,
        id,
        input.goalId,
        input.taskId ?? null,
        input.planDigest,
        input.policyVersion,
        JSON.stringify(input.requiredScope),
        JSON.stringify(input.risk ?? {}),
        JSON.stringify(input.channelLimits ?? {}),
        input.expiresAt,
        input.correlationId ?? null,
        now,
      );
      this.appendAudit("approval.created", `approval:${id}`, "system", "ALLOW", input.policyVersion, { goalId: input.goalId, taskId: input.taskId ?? null });
    });
    return this.getRequest(id)!;
  }

  approve(requestId: string, approver: string, authTime: number, boundedScope: ApprovalBounds): ApprovalGrant {
    const now = this.clock();
    const request = this.getRequest(requestId);
    if (!request) throw new Error("approval request not found");
    if (request.status !== "OPEN" || request.expiresAt <= now) throw new Error("approval request is not open");
    if (!approver || !Number.isFinite(authTime) || authTime > now || now - authTime > 5 * 60_000 || !validBounds(boundedScope) || !scopeWithin(request.requiredScope, boundedScope)) throw new Error("approval decision is incomplete or broader than requested");
    const grantId = uuidv7(now);
    const digest = sha256(canonicalJson({ requestId, grantId, approver, authTime, boundedScope, policyVersion: request.policyVersion, planDigest: request.planDigest } as never));
    return this.db.transaction(() => {
      const current = this.getRequest(requestId);
      if (!current || current.status !== "OPEN" || current.expiresAt <= now) throw new Error("approval request is not open");
      this.db.run("UPDATE approval_requests SET status = 'APPROVED', decided_at = ?, decided_by = ? WHERE id = ? AND status = 'OPEN'", now, approver, requestId);
      this.db.run(
        `INSERT INTO approval_grants(id, request_id, signed_grant_digest, bounded_scope_json, approver, auth_time, issued_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        grantId,
        requestId,
        digest,
        JSON.stringify(boundedScope),
        approver,
        authTime,
        now,
        Math.min(current.expiresAt, now + 5 * 60_000),
      );
      this.appendAudit("approval.approved", `approval:${requestId}`, approver, "ALLOW", current.policyVersion, { grantId });
      return this.getGrant(grantId)!;
    });
  }

  reject(requestId: string, actor: string): ApprovalRequest {
    const now = this.clock();
    return this.db.transaction(() => {
      const current = this.getRequest(requestId);
      if (!current) throw new Error("approval request not found");
      if (current.status !== "OPEN") return current;
      if (current.expiresAt <= now) {
        this.db.run("UPDATE approval_requests SET status = 'EXPIRED', decided_at = ? WHERE id = ? AND status = 'OPEN'", now, requestId);
        this.appendAudit("approval.expired", `approval:${requestId}`, actor, "ALLOW", current.policyVersion, {});
        return this.getRequest(requestId)!;
      }
      this.db.run("UPDATE approval_requests SET status = 'REJECTED', decided_at = ?, decided_by = ? WHERE id = ? AND status = 'OPEN' AND expires_at > ?", now, actor, requestId, now);
      this.appendAudit("approval.rejected", `approval:${requestId}`, actor, "ALLOW", current.policyVersion, {});
      return this.getRequest(requestId)!;
    });
  }

  expireOpen(now = this.clock()): number {
    return this.db.transaction(() => {
      const result = this.db.connection.prepare("UPDATE approval_requests SET status = 'EXPIRED', decided_at = ? WHERE status = 'OPEN' AND expires_at <= ?").run(now, now);
      const count = Number(result.changes);
      if (count > 0) this.appendAudit("approval.expired", "approval:open", "system", "ALLOW", 1, { count });
      return count;
    });
  }

  revokeGrant(grantId: string, actor: string): boolean {
    const now = this.clock();
    return this.db.transaction(() => {
      const result = this.db.connection.prepare("UPDATE approval_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now, grantId);
      if (Number(result.changes) === 0) return false;
      this.appendAudit("approval.grant.revoked", `approval-grant:${grantId}`, actor, "ALLOW", 1, {});
      return true;
    });
  }

  private appendAudit(action: string, target: string, actor: string, decision: string, policyVersion: number, metadata: Record<string, unknown>): void {
    const previous = this.db.one<{ hash: string }>("SELECT hash FROM audit_events ORDER BY sequence DESC LIMIT 1");
    const eventId = uuidv7(this.clock());
    const occurredAt = this.clock();
    const payload = canonicalJson({ eventId, actor, action, target, decision, policyVersion, metadata, previousHash: previous?.hash ?? null, occurredAt } as never);
    const hash = createHash("sha256").update(payload).digest("hex");
    this.db.run(
      `INSERT INTO audit_events(event_id, actor, action, target, decision, policy_version, metadata_json, previous_hash, hash, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      eventId,
      actor,
      action,
      target,
      decision,
      policyVersion,
      JSON.stringify(metadata),
      previous?.hash ?? null,
      hash,
      occurredAt,
    );
  }

  getRequest(id: string): ApprovalRequest | undefined {
    const row = this.db.one<Record<string, unknown>>("SELECT * FROM approval_requests WHERE id = ?", id);
    if (!row) return undefined;
    return {
      id: String(row.id), goalId: String(row.goal_id), taskId: row.task_id === null ? null : String(row.task_id), planDigest: String(row.plan_digest), policyVersion: Number(row.policy_version), requiredScope: asJson<ApprovalBounds>(String(row.required_scope_json)), risk: asJson<Record<string, unknown>>(String(row.risk_json)), channelLimits: asJson<Record<string, unknown>>(String(row.channel_limits_json)), status: row.status as ApprovalStatus, expiresAt: Number(row.expires_at), correlationId: row.correlation_id === null ? null : String(row.correlation_id), createdAt: Number(row.created_at), decidedAt: row.decided_at === null ? null : Number(row.decided_at), decidedBy: row.decided_by === null ? null : String(row.decided_by),
    };
  }

  getGrant(id: string): ApprovalGrant | undefined {
    const row = this.db.one<Record<string, unknown>>("SELECT * FROM approval_grants WHERE id = ?", id);
    if (!row) return undefined;
    return {
      id: String(row.id), requestId: String(row.request_id), signedGrantDigest: String(row.signed_grant_digest), boundedScope: asJson<ApprovalBounds>(String(row.bounded_scope_json)), approver: String(row.approver), authTime: Number(row.auth_time), issuedAt: Number(row.issued_at), expiresAt: Number(row.expires_at), revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
    };
  }
}
