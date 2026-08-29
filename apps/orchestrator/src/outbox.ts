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
    return this.claimForTopics([], limit, leaseMs);
  }

  claimForTopics(topics: readonly string[], limit = 20, leaseMs = 30_000): OutboxRecord[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("outbox claim limit must be 1..100");
    if (topics.some((topic) => typeof topic !== "string" || topic.length === 0)) throw new Error("outbox topics are invalid");
    const now = this.clock();
    return this.db.transaction(() => {
      const topicClause = topics.length > 0 ? ` AND topic IN (${topics.map(() => "?").join(", ")})` : "";
      const rows = this.db.all<StoredOutboxRow>(
        `SELECT * FROM outbox
         WHERE delivered_at IS NULL AND dead_lettered_at IS NULL AND available_at <= ?
           AND (claimed_until IS NULL OR claimed_until <= ?)
           ${topicClause}
         ORDER BY available_at, id LIMIT ?`,
        now,
        now,
        ...topics,
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

  markFailed(id: string, claimToken: string, safeError: string, retryAfterMs = 1_000, maxAttempts = 10): "RETRY" | "DEAD_LETTER" {
    const now = this.clock();
    const message = safeError.slice(0, 500);
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error("outbox max attempts must be positive");
    const current = this.db.one<{ attempt_count: number }>(
      "SELECT attempt_count FROM outbox WHERE id = ? AND claim_token = ? AND delivered_at IS NULL AND dead_lettered_at IS NULL",
      id,
      claimToken,
    );
    if (!current) throw new Error("OUTBOX_NOT_PENDING");
    if (current.attempt_count >= maxAttempts) {
      const changed = this.db.connection.prepare(
        "UPDATE outbox SET dead_lettered_at = ?, dead_letter_reason = ?, claimed_until = NULL, claim_token = NULL, last_error = ? WHERE id = ? AND claim_token = ? AND delivered_at IS NULL AND dead_lettered_at IS NULL",
      ).run(now, message, message, id, claimToken);
      if (Number(changed.changes) !== 1) throw new Error("OUTBOX_NOT_PENDING");
      return "DEAD_LETTER";
    }
    const changed = this.db.connection.prepare(
      "UPDATE outbox SET available_at = ?, claimed_until = NULL, claim_token = NULL, last_error = ? WHERE id = ? AND claim_token = ? AND delivered_at IS NULL",
    ).run(now + Math.max(0, retryAfterMs), message, id, claimToken);
    if (Number(changed.changes) !== 1) throw new Error("OUTBOX_NOT_PENDING");
    return "RETRY";
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
