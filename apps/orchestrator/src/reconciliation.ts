import { sha256, uuidv7 } from "../../../packages/crypto/src/index.ts";
import { OrchestratorDatabase } from "./db.ts";

export type ReconciliationStatus = "OPEN" | "CONFIRMED" | "ABSENT" | "UNKNOWN" | "FAILED";

export type ReconciliationRecord = {
  id: string;
  taskId: string;
  attemptId: string | null;
  provider: string;
  operationKind: string;
  idempotencyKey: string;
  externalOperationId: string | null;
  requestDigest: string;
  expectedResource: Record<string, unknown>;
  startedAt: number;
  lastObservedState: string;
  reconciliationStrategy: string;
  status: ReconciliationStatus;
  lastObservedAt: number;
  resolvedAt: number | null;
};

export class ReconciliationService {
  private readonly db: OrchestratorDatabase;
  private readonly clock: () => number;

  constructor(db: OrchestratorDatabase, clock: () => number = Date.now) {
    this.db = db;
    this.clock = clock;
  }

  start(input: Omit<ReconciliationRecord, "id" | "requestDigest" | "status" | "lastObservedAt" | "resolvedAt"> & { request: unknown }): ReconciliationRecord {
    if (!input.taskId || !input.provider || !input.operationKind || !input.idempotencyKey) throw new Error("reconciliation identity is required");
    const now = this.clock();
    const id = uuidv7(now);
    const requestDigest = sha256(JSON.stringify(input.request));
    this.db.run(
      `INSERT INTO reconciliation_records
       (id, task_id, attempt_id, provider, operation_kind, idempotency_key, external_operation_id,
        request_digest, expected_resource_json, started_at, last_observed_state, reconciliation_strategy,
        status, last_observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)`,
      id,
      input.taskId,
      input.attemptId,
      input.provider,
      input.operationKind,
      input.idempotencyKey,
      input.externalOperationId,
      requestDigest,
      JSON.stringify(input.expectedResource),
      input.startedAt,
      input.lastObservedState,
      input.reconciliationStrategy,
      now,
    );
    return this.get(id)!;
  }

  observe(id: string, state: string, status: ReconciliationStatus = "UNKNOWN", externalOperationId?: string | null): ReconciliationRecord {
    const current = this.get(id);
    if (!current) throw new Error("reconciliation record not found");
    if (current.status !== "OPEN") return current;
    const now = this.clock();
    this.db.run("UPDATE reconciliation_records SET last_observed_state = ?, status = ?, external_operation_id = COALESCE(?, external_operation_id), last_observed_at = ?, resolved_at = CASE WHEN ? IN ('CONFIRMED', 'ABSENT', 'FAILED') THEN ? ELSE resolved_at END WHERE id = ? AND status = 'OPEN'", state, status, externalOperationId ?? null, now, status, now, id);
    return this.get(id)!;
  }

  get(id: string): ReconciliationRecord | undefined {
    const row = this.db.one<Record<string, unknown>>("SELECT * FROM reconciliation_records WHERE id = ?", id);
    if (!row) return undefined;
    return {
      id: String(row.id), taskId: String(row.task_id), attemptId: row.attempt_id === null ? null : String(row.attempt_id),
      provider: String(row.provider), operationKind: String(row.operation_kind), idempotencyKey: String(row.idempotency_key),
      externalOperationId: row.external_operation_id === null ? null : String(row.external_operation_id), requestDigest: String(row.request_digest),
      expectedResource: JSON.parse(String(row.expected_resource_json)), startedAt: Number(row.started_at), lastObservedState: String(row.last_observed_state),
      reconciliationStrategy: String(row.reconciliation_strategy), status: row.status as ReconciliationStatus, lastObservedAt: Number(row.last_observed_at),
      resolvedAt: row.resolved_at === null ? null : Number(row.resolved_at),
    };
  }
}
