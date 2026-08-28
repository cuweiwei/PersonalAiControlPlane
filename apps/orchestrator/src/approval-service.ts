import { sha256, uuidv7 } from "../../../packages/crypto/src/index.ts";
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
    if (!input.goalId || !input.planDigest || !Number.isInteger(input.policyVersion) || input.policyVersion < 1 || input.expiresAt <= now) throw new Error("approval request is invalid or already expired");
    const id = uuidv7(now);
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
    return this.getRequest(id)!;
  }

  approve(requestId: string, approver: string, authTime: number, signedGrant: string, boundedScope: ApprovalBounds): ApprovalGrant {
    const now = this.clock();
    const request = this.getRequest(requestId);
    if (!request) throw new Error("approval request not found");
    if (request.status !== "OPEN" || request.expiresAt <= now) throw new Error("approval request is not open");
    if (!approver || !Number.isFinite(authTime) || !signedGrant) throw new Error("approval decision is incomplete");
    const grantId = uuidv7(now);
    const digest = sha256(signedGrant);
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
      return this.getGrant(grantId)!;
    });
  }

  reject(requestId: string, actor: string): ApprovalRequest {
    const now = this.clock();
    this.db.run("UPDATE approval_requests SET status = 'REJECTED', decided_at = ?, decided_by = ? WHERE id = ? AND status = 'OPEN' AND expires_at > ?", now, actor, requestId, now);
    return this.getRequest(requestId)!;
  }

  expireOpen(now = this.clock()): number {
    const result = this.db.connection.prepare("UPDATE approval_requests SET status = 'EXPIRED', decided_at = ? WHERE status = 'OPEN' AND expires_at <= ?").run(now, now);
    return Number(result.changes);
  }

  revokeGrant(grantId: string, actor: string): boolean {
    const now = this.clock();
    const result = this.db.connection.prepare("UPDATE approval_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now, grantId);
    if (Number(result.changes) > 0) {
      this.db.run("INSERT INTO audit_events(event_id, actor, action, target, decision, policy_version, metadata_json, previous_hash, hash, occurred_at) VALUES (?, ?, 'approval.grant.revoked', ?, 'ALLOW', 1, ?, (SELECT hash FROM audit_events ORDER BY sequence DESC LIMIT 1), ?, ?)", uuidv7(now), actor, `approval-grant:${grantId}`, JSON.stringify({}), sha256(`${grantId}:${now}`), now);
      return true;
    }
    return false;
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
