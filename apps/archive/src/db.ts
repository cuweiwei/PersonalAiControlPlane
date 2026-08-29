import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const ARCHIVE_SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  external_account_handle TEXT NOT NULL,
  external_thread_id TEXT NOT NULL,
  title TEXT,
  scope_json TEXT NOT NULL,
  retention_override_json TEXT,
  effective_retention TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(source, external_account_handle, external_thread_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  external_message_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  role TEXT NOT NULL,
  sent_at INTEGER,
  normalized_content_json TEXT NOT NULL,
  format TEXT NOT NULL,
  checksum TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(conversation_id, external_message_id, revision)
);
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id, sent_at, id);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id),
  content_hash TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  artifact_ref TEXT NOT NULL,
  expires_at INTEGER,
  purge_status TEXT NOT NULL DEFAULT 'LIVE'
);
CREATE TABLE IF NOT EXISTS conversation_goal_links (
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  goal_id TEXT NOT NULL,
  first_message_id TEXT,
  last_message_id TEXT,
  link_reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(conversation_id, goal_id)
);
CREATE TABLE IF NOT EXISTS sync_cursors (
  connector TEXT NOT NULL,
  account_handle TEXT NOT NULL,
  cursor_ref TEXT,
  last_success_at INTEGER,
  lease_until INTEGER,
  failure_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER,
  PRIMARY KEY(connector, account_handle)
);
CREATE TABLE IF NOT EXISTS extractions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  message_start_id TEXT,
  message_end_id TEXT,
  extractor_version TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  status TEXT NOT NULL,
  candidate_ids_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS conversation_tombstones (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  idempotency_key TEXT,
  requested_at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  cutoff_external_message_id TEXT,
  block_future INTEGER NOT NULL DEFAULT 0 CHECK(block_future IN (0, 1)),
  completed_at INTEGER,
  purge_manifest_hash TEXT,
  status TEXT NOT NULL CHECK(status IN ('REQUESTED', 'PURGING', 'VERIFIED', 'FAILED'))
);
CREATE TABLE IF NOT EXISTS conversation_exports (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  requested_by TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('REQUESTED', 'RUNNING', 'COMPLETED', 'FAILED')),
  artifact_hash TEXT,
  manifest_json TEXT,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(requested_by, idempotency_key)
);
CREATE TABLE IF NOT EXISTS artifact_references (
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  purpose TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  released_at INTEGER,
  PRIMARY KEY(owner_type, owner_id, artifact_hash)
);
CREATE TABLE IF NOT EXISTS archive_outbox (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  available_at INTEGER NOT NULL,
  claimed_until INTEGER,
  claim_token TEXT,
  delivered_at INTEGER,
  dead_lettered_at INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
`;

export class ArchiveDatabase {
  readonly connection: InstanceType<typeof DatabaseSync>;
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.connection = new DatabaseSync(path);
    this.connection.exec("PRAGMA journal_mode = WAL");
    this.connection.exec("PRAGMA foreign_keys = ON");
    this.connection.exec("PRAGMA synchronous = FULL");
    this.connection.exec("PRAGMA busy_timeout = 5000");
    this.connection.exec("PRAGMA trusted_schema = OFF");
    this.migrate();
  }

  private migrate(): void {
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      this.connection.exec(ARCHIVE_SCHEMA);
      if (!this.connection.prepare("SELECT version FROM schema_migrations WHERE version = 1").get()) this.connection.prepare("INSERT INTO schema_migrations(version, checksum, applied_at) VALUES(1, ?, ?)").run("archive-schema-v1", Date.now());
      if (!this.connection.prepare("SELECT version FROM schema_migrations WHERE version = 2").get()) {
        const outboxColumns = this.connection.prepare("PRAGMA table_info(archive_outbox)").all() as Array<{ name: string }>;
        if (!outboxColumns.some((column) => column.name === "claim_token")) this.connection.exec("ALTER TABLE archive_outbox ADD COLUMN claim_token TEXT");
        if (!outboxColumns.some((column) => column.name === "dead_lettered_at")) this.connection.exec("ALTER TABLE archive_outbox ADD COLUMN dead_lettered_at INTEGER");
        const tombstoneColumns = this.connection.prepare("PRAGMA table_info(conversation_tombstones)").all() as Array<{ name: string }>;
        if (!tombstoneColumns.some((column) => column.name === "idempotency_key")) this.connection.exec("ALTER TABLE conversation_tombstones ADD COLUMN idempotency_key TEXT");
        this.connection.exec("CREATE UNIQUE INDEX IF NOT EXISTS conversation_tombstones_idempotency_idx ON conversation_tombstones(requested_by, idempotency_key) WHERE idempotency_key IS NOT NULL");
        this.connection.prepare("INSERT INTO schema_migrations(version, checksum, applied_at) VALUES(2, ?, ?)").run("archive-durable-jobs-v2", Date.now());
      }
      this.connection.exec("COMMIT");
    } catch (error) {
      this.connection.exec("ROLLBACK");
      throw error;
    }
  }

  transaction<T>(callback: () => T): T {
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.connection.exec("COMMIT");
      return result;
    } catch (error) {
      this.connection.exec("ROLLBACK");
      throw error;
    }
  }

  one<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, ...parameters: unknown[]): T | undefined { return this.connection.prepare(sql).get(...parameters) as T | undefined; }
  all<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, ...parameters: unknown[]): T[] { return this.connection.prepare(sql).all(...parameters) as T[]; }
  run(sql: string, ...parameters: unknown[]): void { this.connection.prepare(sql).run(...parameters); }
  close(): void { this.connection.close(); }
}
