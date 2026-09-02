import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  correlation_id TEXT,
  group_id TEXT,
  parent_task_id TEXT,
  title TEXT NOT NULL,
  task_type TEXT NOT NULL,
  instruction TEXT NOT NULL,
  context_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  execution_json TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 50,
  status TEXT NOT NULL CHECK (status IN ('QUEUED', 'ASSIGNED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
  current_attempt_id TEXT,
  timeout_seconds INTEGER NOT NULL,
  max_attempts INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  result_summary_json TEXT,
  failure_code TEXT,
  failure_message TEXT,
  created_at INTEGER NOT NULL,
  assigned_at INTEGER,
  started_at INTEGER,
  finished_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_status_priority ON tasks(status, priority DESC, created_at, id);
CREATE INDEX IF NOT EXISTS idx_tasks_correlation ON tasks(correlation_id);
CREATE INDEX IF NOT EXISTS idx_tasks_group ON tasks(group_id);

CREATE TABLE IF NOT EXISTS task_attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  attempt_number INTEGER NOT NULL,
  worker_id TEXT NOT NULL REFERENCES workers(id),
  status TEXT NOT NULL CHECK (status IN ('OFFERED', 'ACCEPTED', 'RUNNING', 'REJECTED', 'LOST', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
  assigned_at INTEGER NOT NULL,
  accepted_at INTEGER,
  started_at INTEGER,
  finished_at INTEGER,
  failure_code TEXT,
  failure_message TEXT,
  result_json TEXT,
  is_late_result INTEGER NOT NULL DEFAULT 0,
  UNIQUE(task_id, attempt_number)
);
CREATE INDEX IF NOT EXISTS idx_attempts_worker_status ON task_attempts(worker_id, status);

CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_uuid TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  attempt_id TEXT,
  worker_id TEXT,
  event_type TEXT NOT NULL,
  payload_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, id);

CREATE TABLE IF NOT EXISTS workers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  hostname TEXT,
  status TEXT NOT NULL CHECK (status IN ('ONLINE', 'OFFLINE', 'DISABLED')),
  enabled INTEGER NOT NULL DEFAULT 1,
  drain INTEGER NOT NULL DEFAULT 0,
  removed_at INTEGER,
  agent_version TEXT,
  cpu_json TEXT,
  memory_json TEXT,
  gpu_json TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  max_concurrency INTEGER NOT NULL DEFAULT 1,
  last_heartbeat_at INTEGER,
  last_connected_at INTEGER,
  last_disconnected_at INTEGER,
  last_assigned_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workers_status ON workers(status, enabled, drain);

CREATE TABLE IF NOT EXISTS worker_tokens (
  worker_id TEXT PRIMARY KEY REFERENCES workers(id),
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS worker_registration_requests (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  registration_secret_hash TEXT NOT NULL,
  platform TEXT NOT NULL,
  hostname TEXT,
  agent_version TEXT,
  hardware_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED')),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by TEXT,
  worker_id TEXT REFERENCES workers(id)
);
CREATE INDEX IF NOT EXISTS idx_registration_status ON worker_registration_requests(status, expires_at);

CREATE TABLE IF NOT EXISTS worker_capabilities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_id TEXT NOT NULL REFERENCES workers(id),
  capability TEXT NOT NULL,
  runtime TEXT,
  runtime_version TEXT,
  max_concurrency INTEGER NOT NULL DEFAULT 1,
  descriptor_json TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(worker_id, capability, runtime)
);

CREATE TABLE IF NOT EXISTS worker_models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_id TEXT NOT NULL REFERENCES workers(id),
  runtime TEXT NOT NULL,
  model_id TEXT NOT NULL,
  display_name TEXT,
  status TEXT NOT NULL,
  context_length INTEGER,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL,
  UNIQUE(worker_id, runtime, model_id)
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  attempt_id TEXT,
  filename TEXT NOT NULL,
  media_type TEXT,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS task_artifacts (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  direction TEXT NOT NULL CHECK (direction IN ('INPUT', 'OUTPUT')),
  PRIMARY KEY(task_id, artifact_id)
);

CREATE TABLE IF NOT EXISTS callback_outbox (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  payload_json TEXT NOT NULL,
  available_at INTEGER NOT NULL,
  claimed_until INTEGER,
  claim_token TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  delivered_at INTEGER,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_callback_outbox_due ON callback_outbox(delivered_at, available_at, claimed_until);

CREATE TABLE IF NOT EXISTS systems (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  base_url TEXT,
  health_path TEXT,
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS system_health (
  system_id TEXT PRIMARY KEY REFERENCES systems(id),
  status TEXT NOT NULL,
  latency_ms INTEGER,
  message TEXT,
  checked_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export type SqlRow = Record<string, unknown>;

export class ControlPlaneDatabase {
  readonly connection: InstanceType<typeof DatabaseSync>;
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.connection = new DatabaseSync(path);
    this.connection.exec("PRAGMA journal_mode = WAL");
    this.connection.exec("PRAGMA foreign_keys = ON");
    this.connection.exec("PRAGMA busy_timeout = 5000");
    this.connection.exec("PRAGMA synchronous = NORMAL");
    this.connection.exec("PRAGMA trusted_schema = OFF");
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      this.connection.exec(SCHEMA);
      const existing = this.connection.prepare("SELECT version FROM schema_migrations WHERE version = 1").get();
      if (!existing) this.connection.prepare("INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (1, ?, ?)").run("control-plane-v2", Date.now());
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

  one<T extends SqlRow = SqlRow>(sql: string, ...parameters: any[]): T | undefined {
    return this.connection.prepare(sql).get(...parameters) as T | undefined;
  }

  all<T extends SqlRow = SqlRow>(sql: string, ...parameters: any[]): T[] {
    return this.connection.prepare(sql).all(...parameters) as T[];
  }

  run(sql: string, ...parameters: any[]): void {
    this.connection.prepare(sql).run(...parameters);
  }

  isWritable(): boolean {
    try {
      this.connection.exec("BEGIN IMMEDIATE");
      this.connection.exec("ROLLBACK");
      return true;
    } catch {
      try { this.connection.exec("ROLLBACK"); } catch { /* preserve the original readiness failure */ }
      return false;
    }
  }

  close(): void { this.connection.close(); }
}
