import { uuidv7 } from "../../../packages/crypto/src/index.ts";
import { OrchestratorDatabase, type SqlRow } from "./db.ts";

export type OutboxRecord = {
  id: string;
  topic: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  dedupeKey: string;
  claimToken: string;
  payload: Record<string, unknown>;
  attemptCount: number;
  availableAt: number;
};

type StoredOutboxRow = SqlRow & {
  id: string;
  topic: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: number;
  dedupe_key: string;
  claim_token: string | null;
  payload_json: string;
  attempt_count: number;
  available_at: number;
};

export class OutboxStore {
  private readonly db: OrchestratorDatabase;
  private readonly clock: () => number;

  constructor(db: OrchestratorDatabase, clock: () => number = Date.now) {
    this.db = db;
    this.clock = clock;
  }

  claim(limit = 20, leaseMs = 30_000): OutboxRecord[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("outbox claim limit must be 1..100");
    const now = this.clock();
    return this.db.transaction(() => {
      const rows = this.db.all<StoredOutboxRow>(
        `SELECT * FROM outbox
         WHERE delivered_at IS NULL AND available_at <= ?
           AND (claimed_until IS NULL OR claimed_until <= ?)
         ORDER BY available_at, id LIMIT ?`,
        now,
        now,
        limit,
      );
      const claims = new Map<string, string>();
      for (const row of rows) {
        const claimToken = uuidv7(now);
        claims.set(row.id, claimToken);
        this.db.run(
          "UPDATE outbox SET claimed_until = ?, claim_token = ?, attempt_count = attempt_count + 1 WHERE id = ? AND delivered_at IS NULL",
          now + leaseMs,
          claimToken,
          row.id,
        );
      }
      return rows.map((row) => this.fromRow(row, claims.get(row.id)!));
    });
  }

  markDelivered(id: string, claimToken: string): void {
    const changed = this.db.connection.prepare(
      "UPDATE outbox SET delivered_at = ?, claimed_until = NULL, claim_token = NULL, last_error = NULL WHERE id = ? AND claim_token = ? AND delivered_at IS NULL",
    ).run(this.clock(), id, claimToken);
    if (Number(changed.changes) !== 1) throw new Error("OUTBOX_NOT_PENDING");
  }

  markFailed(id: string, claimToken: string, safeError: string, retryAfterMs = 1_000): void {
    const now = this.clock();
    const message = safeError.slice(0, 500);
    const changed = this.db.connection.prepare(
      "UPDATE outbox SET available_at = ?, claimed_until = NULL, claim_token = NULL, last_error = ? WHERE id = ? AND claim_token = ? AND delivered_at IS NULL",
    ).run(now + Math.max(0, retryAfterMs), message, id, claimToken);
    if (Number(changed.changes) !== 1) throw new Error("OUTBOX_NOT_PENDING");
  }

  private fromRow(row: StoredOutboxRow, claimToken: string): OutboxRecord {
    return {
      id: row.id,
      topic: row.topic,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      aggregateVersion: row.aggregate_version,
      dedupeKey: row.dedupe_key,
      claimToken,
      payload: JSON.parse(row.payload_json),
      attemptCount: row.attempt_count + 1,
      availableAt: row.available_at,
    };
  }
}

export function enqueueOutbox(
  db: OrchestratorDatabase,
  topic: string,
  aggregateType: string,
  aggregateId: string,
  aggregateVersion: number,
  dedupeKey: string,
  payload: Record<string, unknown>,
  availableAt = Date.now(),
): string {
  const id = uuidv7(availableAt);
  db.run(
    `INSERT INTO outbox(id, topic, aggregate_type, aggregate_id, aggregate_version, dedupe_key, payload_json, available_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    topic,
    aggregateType,
    aggregateId,
    aggregateVersion,
    dedupeKey,
    JSON.stringify(payload),
    availableAt,
  );
  return id;
}
