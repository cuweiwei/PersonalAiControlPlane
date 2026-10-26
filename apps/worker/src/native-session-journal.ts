import type { WorkerLocalDatabase } from "./local-db.ts";

export type NativeRuntime = "opencode" | "codex";
export type NativeSessionState = "BOUND" | "RUNNING" | "QUOTA_BLOCKED" | "COMPLETED" | "UNKNOWN" | "NEEDS_OWNER_ACTION";
export type NativeCheckpointPhase = "RUNNING" | "QUOTA_BLOCKED" | "COMPLETED" | "UNKNOWN" | "NEEDS_OWNER_ACTION";

export type BindNativeSessionInput = {
  taskId: string;
  attemptId: string;
  runtime: NativeRuntime;
  nativeSessionId: string;
  workspaceId: string;
  fenceEpoch: number;
  branch?: string | null;
  baselineSha?: string | null;
  lastHeadSha?: string | null;
};

export type NativeSessionRecord = {
  taskId: string;
  attemptId: string;
  runtime: NativeRuntime;
  nativeSessionId: string;
  workspaceId: string;
  fenceEpoch: number;
  branch: string | null;
  baselineSha: string | null;
  lastHeadSha: string | null;
  state: NativeSessionState;
  updatedAt: number;
};

export type RecordNativeCheckpointInput = {
  attemptId: string;
  fenceEpoch: number;
  expectedUpdatedAt: number;
  phase: NativeCheckpointPhase;
  branch?: string | null;
  baselineSha?: string | null;
  lastHeadSha?: string | null;
};

export type RecordUnsupportedResumeInput = {
  operationKey: string;
  attemptId: string;
  nativeSessionId: string;
  fenceEpoch: number;
  requestHash: string;
};

export type UnsupportedResumeRecord = {
  operationKey: string;
  attemptId: string;
  state: "UNSUPPORTED";
  nativeMessageId: null;
  requestHash: string;
  createdAt: number;
  updatedAt: number;
  dispatchAllowed: false;
  reason: "NATIVE_RESUME_UNSUPPORTED";
};

type SessionRow = {
  task_id: string;
  attempt_id: string;
  runtime: string;
  native_session_id: string;
  workspace_id: string;
  fence_epoch: number;
  branch: string | null;
  baseline_sha: string | null;
  last_head_sha: string | null;
  checkpoint_json: string | null;
  state: string;
  updated_at: number;
};

type ResumeOperationRow = {
  operation_key: string;
  attempt_id: string;
  native_session_id: string;
  state: string;
  native_message_id: string | null;
  request_hash: string;
  created_at: number;
  updated_at: number;
};

type NormalizedBinding = Omit<BindNativeSessionInput, "branch" | "baselineSha" | "lastHeadSha"> & {
  branch: string | null;
  baselineSha: string | null;
  lastHeadSha: string | null;
};

const ALLOWED_CHECKPOINT_TRANSITIONS: Record<NativeSessionState, readonly NativeSessionState[]> = {
  BOUND: ["RUNNING", "QUOTA_BLOCKED", "COMPLETED", "UNKNOWN", "NEEDS_OWNER_ACTION"],
  RUNNING: ["RUNNING", "QUOTA_BLOCKED", "COMPLETED", "UNKNOWN", "NEEDS_OWNER_ACTION"],
  QUOTA_BLOCKED: ["QUOTA_BLOCKED", "UNKNOWN", "NEEDS_OWNER_ACTION"],
  COMPLETED: ["COMPLETED"],
  UNKNOWN: ["UNKNOWN", "NEEDS_OWNER_ACTION"],
  NEEDS_OWNER_ACTION: ["NEEDS_OWNER_ACTION"],
};

/**
 * Worker-local session metadata only. This journal deliberately has no method
 * that invokes a native runtime or marks a resume operation as dispatched.
 */
export class NativeSessionJournal {
  private readonly db: WorkerLocalDatabase;
  private readonly clock: () => number;

  constructor(db: WorkerLocalDatabase, clock: () => number = Date.now) {
    this.db = db;
    this.clock = clock;
  }

  bind(input: BindNativeSessionInput): NativeSessionRecord {
    const normalized = validateBinding(input);
    const now = this.now();
    return this.db.transaction(() => {
      const existing = this.db.connection.prepare("SELECT * FROM native_session_journal WHERE attempt_id = ?").get(normalized.attemptId) as SessionRow | undefined;
      if (existing) {
        if (!sameBinding(existing, normalized)) throw journalError("NATIVE_SESSION_BINDING_CONFLICT");
        return toSessionRecord(existing);
      }
      this.db.connection.prepare(`
        INSERT INTO native_session_journal(
          task_id, attempt_id, runtime, native_session_id, workspace_id, fence_epoch,
          branch, baseline_sha, last_head_sha, checkpoint_json, state, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'BOUND', ?)
      `).run(
        normalized.taskId,
        normalized.attemptId,
        normalized.runtime,
        normalized.nativeSessionId,
        normalized.workspaceId,
        normalized.fenceEpoch,
        normalized.branch,
        normalized.baselineSha,
        normalized.lastHeadSha,
        now,
      );
      const inserted = this.findSession(normalized.attemptId);
      if (!inserted) throw journalError("NATIVE_SESSION_JOURNAL_WRITE_FAILED");
      return toSessionRecord(inserted);
    });
  }

  /** Local-only lookup. Callers must not project nativeSessionId to an API. */
  getByAttempt(attemptId: string): NativeSessionRecord | undefined {
    const id = requiredText(attemptId, "attemptId", 256);
    const row = this.findSession(id);
    return row ? toSessionRecord(row) : undefined;
  }

  recordCheckpoint(input: RecordNativeCheckpointInput): NativeSessionRecord {
    const attemptId = requiredText(input.attemptId, "attemptId", 256);
    const fenceEpoch = positiveInteger(input.fenceEpoch, "fenceEpoch");
    const expectedUpdatedAt = nonNegativeInteger(input.expectedUpdatedAt, "expectedUpdatedAt");
    const phase = oneOf(input.phase, ["RUNNING", "QUOTA_BLOCKED", "COMPLETED", "UNKNOWN", "NEEDS_OWNER_ACTION"] as const, "phase");
    const branch = optionalBranch(input.branch);
    const baselineSha = optionalSha(input.baselineSha, "baselineSha");
    const lastHeadSha = optionalSha(input.lastHeadSha, "lastHeadSha");
    const nextState = phase;
    const now = this.now();

    return this.db.transaction(() => {
      const current = this.findSession(attemptId);
      if (!current) throw journalError("NATIVE_SESSION_NOT_FOUND");
      if (current.fence_epoch !== fenceEpoch) throw journalError("NATIVE_SESSION_FENCE_CONFLICT");
      if (current.updated_at !== expectedUpdatedAt) throw journalError("NATIVE_SESSION_STALE_CHECKPOINT");
      if (!ALLOWED_CHECKPOINT_TRANSITIONS[current.state as NativeSessionState]?.includes(nextState)) throw journalError("NATIVE_SESSION_TERMINAL_STATE");

      const updatedAt = Math.max(now, current.updated_at + 1);
      const nextBranch = branch === undefined ? current.branch : branch;
      const nextBaselineSha = baselineSha === undefined ? current.baseline_sha : baselineSha;
      const nextLastHeadSha = lastHeadSha === undefined ? current.last_head_sha : lastHeadSha;
      // Only structured metadata is serialized here. Prompts, output, credentials,
      // provider payloads, and caller-supplied arbitrary JSON are not accepted.
      const checkpoint = JSON.stringify({ schema_version: 1, phase, observed_at: updatedAt });
      const result = this.db.connection.prepare(`
        UPDATE native_session_journal
        SET branch = ?, baseline_sha = ?, last_head_sha = ?, checkpoint_json = ?, state = ?, updated_at = ?
        WHERE attempt_id = ? AND fence_epoch = ? AND updated_at = ?
      `).run(nextBranch, nextBaselineSha, nextLastHeadSha, checkpoint, nextState, updatedAt, attemptId, fenceEpoch, expectedUpdatedAt);
      if (Number(result.changes) !== 1) throw journalError("NATIVE_SESSION_STALE_CHECKPOINT");
      const updated = this.findSession(attemptId);
      if (!updated) throw journalError("NATIVE_SESSION_JOURNAL_WRITE_FAILED");
      return toSessionRecord(updated);
    });
  }

  /**
   * Persist a denied resume request for idempotency/reconciliation. This does
   * not enqueue work, contact an executor, or return a native message ID.
   */
  recordUnsupportedResume(input: RecordUnsupportedResumeInput): UnsupportedResumeRecord {
    const operationKey = requiredText(input.operationKey, "operationKey", 256);
    const attemptId = requiredText(input.attemptId, "attemptId", 256);
    const nativeSessionId = requiredText(input.nativeSessionId, "nativeSessionId", 512);
    const fenceEpoch = positiveInteger(input.fenceEpoch, "fenceEpoch");
    const requestHash = validateRequestHash(input.requestHash);
    const now = this.now();

    return this.db.transaction(() => {
      const session = this.findSession(attemptId);
      if (!session) throw journalError("NATIVE_SESSION_NOT_FOUND");
      if (session.native_session_id !== nativeSessionId || session.fence_epoch !== fenceEpoch) throw journalError("NATIVE_SESSION_FENCE_CONFLICT");

      const existing = this.db.connection.prepare("SELECT * FROM native_resume_operations WHERE operation_key = ?").get(operationKey) as ResumeOperationRow | undefined;
      if (existing) {
        if (existing.attempt_id !== attemptId || existing.native_session_id !== nativeSessionId || existing.request_hash !== requestHash || existing.state !== "UNSUPPORTED" || existing.native_message_id !== null) {
          throw journalError("NATIVE_RESUME_OPERATION_CONFLICT");
        }
        return toUnsupportedResumeRecord(existing);
      }

      const priorForAttempt = this.db.connection.prepare("SELECT operation_key FROM native_resume_operations WHERE attempt_id = ? LIMIT 1").get(attemptId) as { operation_key: string } | undefined;
      if (priorForAttempt) throw journalError("NATIVE_RESUME_OPERATION_ALREADY_RECORDED");

      this.db.connection.prepare(`
        INSERT INTO native_resume_operations(
          operation_key, attempt_id, native_session_id, state, native_message_id,
          request_hash, created_at, updated_at
        ) VALUES (?, ?, ?, 'UNSUPPORTED', NULL, ?, ?, ?)
      `).run(operationKey, attemptId, nativeSessionId, requestHash, now, now);
      const inserted = this.db.connection.prepare("SELECT * FROM native_resume_operations WHERE operation_key = ?").get(operationKey) as ResumeOperationRow | undefined;
      if (!inserted) throw journalError("NATIVE_RESUME_JOURNAL_WRITE_FAILED");
      return toUnsupportedResumeRecord(inserted);
    });
  }

  private findSession(attemptId: string): SessionRow | undefined {
    return this.db.connection.prepare("SELECT * FROM native_session_journal WHERE attempt_id = ?").get(attemptId) as SessionRow | undefined;
  }

  private now(): number {
    return nonNegativeInteger(this.clock(), "clock");
  }
}

function validateBinding(input: BindNativeSessionInput): NormalizedBinding {
  const runtime = oneOf(input.runtime, ["opencode", "codex"] as const, "runtime");
  return {
    taskId: requiredText(input.taskId, "taskId", 256),
    attemptId: requiredText(input.attemptId, "attemptId", 256),
    runtime,
    nativeSessionId: requiredText(input.nativeSessionId, "nativeSessionId", 512),
    workspaceId: requiredText(input.workspaceId, "workspaceId", 256),
    fenceEpoch: positiveInteger(input.fenceEpoch, "fenceEpoch"),
    branch: optionalBranch(input.branch) ?? null,
    baselineSha: optionalSha(input.baselineSha, "baselineSha") ?? null,
    lastHeadSha: optionalSha(input.lastHeadSha, "lastHeadSha") ?? null,
  };
}

function sameBinding(row: SessionRow, value: BindNativeSessionInput): boolean {
  return row.task_id === value.taskId && row.attempt_id === value.attemptId && row.runtime === value.runtime &&
    row.native_session_id === value.nativeSessionId && row.workspace_id === value.workspaceId && row.fence_epoch === value.fenceEpoch;
}

function toSessionRecord(row: SessionRow): NativeSessionRecord {
  return {
    taskId: row.task_id,
    attemptId: row.attempt_id,
    runtime: oneOf(row.runtime, ["opencode", "codex"] as const, "runtime"),
    nativeSessionId: row.native_session_id,
    workspaceId: row.workspace_id,
    fenceEpoch: row.fence_epoch,
    branch: row.branch,
    baselineSha: row.baseline_sha,
    lastHeadSha: row.last_head_sha,
    state: oneOf(row.state, ["BOUND", "RUNNING", "QUOTA_BLOCKED", "COMPLETED", "UNKNOWN", "NEEDS_OWNER_ACTION"] as const, "state"),
    updatedAt: row.updated_at,
  };
}

function toUnsupportedResumeRecord(row: ResumeOperationRow): UnsupportedResumeRecord {
  if (row.state !== "UNSUPPORTED" || row.native_message_id !== null) throw journalError("NATIVE_RESUME_OPERATION_CONFLICT");
  return {
    operationKey: row.operation_key,
    attemptId: row.attempt_id,
    state: "UNSUPPORTED",
    nativeMessageId: null,
    requestHash: row.request_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    dispatchAllowed: false,
    reason: "NATIVE_RESUME_UNSUPPORTED",
  };
}

function requiredText(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string") throw journalError("NATIVE_SESSION_INVALID_INPUT");
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) throw journalError(`NATIVE_SESSION_INVALID_${name.toUpperCase()}`);
  return normalized;
}

function optionalBranch(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const branch = requiredText(value, "branch", 512);
  if (/\s/.test(branch)) throw journalError("NATIVE_SESSION_INVALID_BRANCH");
  return branch;
}

function optionalSha(value: unknown, name: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const sha = requiredText(value, name, 64).toLowerCase();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) throw journalError(`NATIVE_SESSION_INVALID_${name.toUpperCase()}`);
  return sha;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw journalError(`NATIVE_SESSION_INVALID_${name.toUpperCase()}`);
  return Number(value);
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw journalError(`NATIVE_SESSION_INVALID_${name.toUpperCase()}`);
  return Number(value);
}

function oneOf<const T extends readonly string[]>(value: unknown, choices: T, name: string): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) throw journalError(`NATIVE_SESSION_INVALID_${name.toUpperCase()}`);
  return value as T[number];
}

function validateRequestHash(value: unknown): string {
  const hash = requiredText(value, "requestHash", 71);
  if (!/^sha256:[0-9a-f]{64}$/.test(hash)) throw journalError("NATIVE_SESSION_INVALID_REQUEST_HASH");
  return hash;
}

function journalError(code: string): Error {
  return new Error(code);
}
