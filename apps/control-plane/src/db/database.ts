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
  ,created_seq INTEGER
  ,current_run_id TEXT
  ,revision INTEGER NOT NULL DEFAULT 1
  ,purpose TEXT NOT NULL DEFAULT 'USER'
  ,source_ref_json TEXT
  ,preference_snapshot_json TEXT
  ,settings_version INTEGER
  ,request_snapshot_json TEXT
  ,archived_at INTEGER
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
  run_id TEXT,
  attempt_in_run INTEGER NOT NULL DEFAULT 1,
  resolved_execution_json TEXT,
  deadline_at INTEGER,
  occupancy TEXT NOT NULL DEFAULT 'RELEASED',
  cancel_requested_at INTEGER,
  cancel_ack_at INTEGER,
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
  credential_expires_at INTEGER,
  last_error_code TEXT,
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
  worker_id TEXT REFERENCES workers(id),
  finalized_at INTEGER,
  onboarding_id TEXT
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
  descriptor_hash TEXT,
  grant_status TEXT NOT NULL DEFAULT 'DISCOVERED',
  superseded_at INTEGER,
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
  present INTEGER NOT NULL DEFAULT 1,
  last_seen_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE(worker_id, runtime, model_id)
);

CREATE TABLE IF NOT EXISTS worker_providers (
  worker_id TEXT NOT NULL REFERENCES workers(id),
  provider TEXT NOT NULL,
  evidence_level TEXT NOT NULL,
  provider_verified INTEGER NOT NULL DEFAULT 0,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(worker_id, provider)
);

CREATE TABLE IF NOT EXISTS worker_purge_tombstones (
  worker_id TEXT PRIMARY KEY,
  registration_id TEXT,
  fingerprint_digest TEXT NOT NULL,
  removed_at INTEGER NOT NULL,
  removed_by TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS worker_enrollment_tombstones (
  registration_id TEXT PRIMARY KEY,
  fingerprint_digest TEXT NOT NULL,
  removed_at INTEGER NOT NULL,
  removed_by TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_uuid TEXT NOT NULL UNIQUE,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  worker_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  previous_hash TEXT NOT NULL DEFAULT '',
  event_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_worker ON audit_events(worker_id, id);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  attempt_id TEXT,
  filename TEXT NOT NULL,
  media_type TEXT,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  display_filename TEXT,
  storage_state TEXT NOT NULL DEFAULT 'AVAILABLE',
  expired_at INTEGER,
  artifact_key TEXT,
  preview_kind TEXT
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
  last_error TEXT,
  run_id TEXT,
  event_kind TEXT NOT NULL DEFAULT 'TERMINAL',
  state TEXT NOT NULL DEFAULT 'PENDING',
  first_attempt_at INTEGER,
  last_attempt_at INTEGER,
  failure_streak INTEGER NOT NULL DEFAULT 0,
  receipt_revision INTEGER NOT NULL DEFAULT 0,
  reply_state TEXT NOT NULL DEFAULT 'UNKNOWN',
  reply_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_callback_outbox_due ON callback_outbox(delivered_at, available_at, claimed_until);

CREATE TABLE IF NOT EXISTS systems (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  base_url TEXT,
  health_path TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  entry_url TEXT
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

CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  run_number INTEGER NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('INITIAL', 'MANUAL', 'LEGACY')),
  status TEXT NOT NULL CHECK (status IN ('QUEUED', 'ASSIGNED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
  max_attempts INTEGER NOT NULL,
  attempts_used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  result_json TEXT,
  failure_json TEXT,
  UNIQUE(task_id, run_number)
);
CREATE TABLE IF NOT EXISTS task_dispatch_state (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id),
  run_id TEXT,
  primary_reason TEXT,
  reasons_json TEXT NOT NULL DEFAULT '[]',
  candidates_json TEXT NOT NULL DEFAULT '[]',
  reason_hash TEXT,
  blocked_since INTEGER,
  evaluated_at INTEGER,
  dispatch_not_before INTEGER
);
CREATE TABLE IF NOT EXISTS operation_receipts (
  scope TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(scope, operation_key)
);
CREATE TABLE IF NOT EXISTS runtime_metadata (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS worker_workspaces (
  worker_id TEXT NOT NULL REFERENCES workers(id),
  workspace_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL CHECK (state IN ('READY', 'MISSING', 'DISABLED', 'UNKNOWN')),
  config_version INTEGER NOT NULL DEFAULT 0,
  checked_at INTEGER NOT NULL,
  PRIMARY KEY(worker_id, workspace_id)
);
CREATE TABLE IF NOT EXISTS worker_preferences (
  worker_id TEXT PRIMARY KEY REFERENCES workers(id),
  version INTEGER NOT NULL DEFAULT 1,
  mode TEXT NOT NULL DEFAULT 'NORMAL' CHECK (mode IN ('NORMAL', 'IDLE_ONLY')),
  pause_id TEXT,
  pause_until INTEGER,
  pause_indefinite INTEGER NOT NULL DEFAULT 0,
  idle_threshold_seconds INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS worker_onboarding (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  selected_capabilities_json TEXT NOT NULL DEFAULT '[]',
  selected_workspaces_json TEXT NOT NULL DEFAULT '[]',
  registration_id TEXT,
  worker_id TEXT,
  last_step TEXT NOT NULL DEFAULT 'SELECT_PLATFORM',
  diagnostic_task_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  abandoned_at INTEGER
);
CREATE TABLE IF NOT EXISTS model_preferences (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  task_type TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  targets_json TEXT NOT NULL,
  allow_fallback INTEGER NOT NULL DEFAULT 1,
  deleted_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS model_test_batches (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  input_json TEXT NOT NULL,
  parameters_json TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('QUEUED', 'RUNNING', 'COMPLETED', 'CANCELLED')),
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE TABLE IF NOT EXISTS model_test_cases (
  batch_id TEXT NOT NULL REFERENCES model_test_batches(id),
  position INTEGER NOT NULL,
  target_json TEXT NOT NULL,
  task_id TEXT UNIQUE REFERENCES tasks(id),
  queue_deadline_at INTEGER,
  state TEXT NOT NULL CHECK (state IN ('PENDING', 'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED')),
  skip_reason TEXT,
  PRIMARY KEY(batch_id, position)
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
      const ensureColumn = (table: string, column: string, definition: string) => {
        const found = this.connection.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
        if (!found.some((entry) => entry.name === column)) this.connection.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      };
      // v2 production databases may have been created before the worker lifecycle
      // projection was introduced. Keep this migration additive and idempotent.
      ensureColumn("workers", "credential_expires_at", "INTEGER");
      ensureColumn("workers", "last_error_code", "TEXT");
      ensureColumn("worker_capabilities", "descriptor_hash", "TEXT");
      ensureColumn("worker_capabilities", "grant_status", "TEXT NOT NULL DEFAULT 'DISCOVERED'");
      ensureColumn("worker_capabilities", "superseded_at", "INTEGER");
      ensureColumn("worker_registration_requests", "finalized_at", "INTEGER");
      ensureColumn("worker_registration_requests", "onboarding_id", "TEXT");
      ensureColumn("tasks", "created_seq", "INTEGER");
      ensureColumn("tasks", "current_run_id", "TEXT");
      ensureColumn("tasks", "revision", "INTEGER NOT NULL DEFAULT 1");
      ensureColumn("tasks", "purpose", "TEXT NOT NULL DEFAULT 'USER'");
      ensureColumn("tasks", "source_ref_json", "TEXT");
      ensureColumn("tasks", "preference_snapshot_json", "TEXT");
      ensureColumn("tasks", "settings_version", "INTEGER");
      ensureColumn("tasks", "request_snapshot_json", "TEXT");
      ensureColumn("tasks", "archived_at", "INTEGER");
      ensureColumn("task_attempts", "run_id", "TEXT");
      ensureColumn("task_attempts", "attempt_in_run", "INTEGER NOT NULL DEFAULT 1");
      ensureColumn("task_attempts", "resolved_execution_json", "TEXT");
      ensureColumn("task_attempts", "deadline_at", "INTEGER");
      ensureColumn("task_attempts", "occupancy", "TEXT NOT NULL DEFAULT 'RELEASED'");
      ensureColumn("task_attempts", "cancel_requested_at", "INTEGER");
      ensureColumn("task_attempts", "cancel_ack_at", "INTEGER");
      ensureColumn("artifacts", "display_filename", "TEXT");
      ensureColumn("artifacts", "storage_state", "TEXT NOT NULL DEFAULT 'AVAILABLE'");
      ensureColumn("artifacts", "expired_at", "INTEGER");
      ensureColumn("artifacts", "artifact_key", "TEXT");
      ensureColumn("artifacts", "preview_kind", "TEXT");
      ensureColumn("callback_outbox", "run_id", "TEXT");
      ensureColumn("callback_outbox", "event_kind", "TEXT NOT NULL DEFAULT 'TERMINAL'");
      ensureColumn("callback_outbox", "state", "TEXT NOT NULL DEFAULT 'PENDING'");
      ensureColumn("callback_outbox", "first_attempt_at", "INTEGER");
      ensureColumn("callback_outbox", "last_attempt_at", "INTEGER");
      ensureColumn("callback_outbox", "failure_streak", "INTEGER NOT NULL DEFAULT 0");
      ensureColumn("callback_outbox", "receipt_revision", "INTEGER NOT NULL DEFAULT 0");
      ensureColumn("callback_outbox", "reply_state", "TEXT NOT NULL DEFAULT 'UNKNOWN'");
      ensureColumn("callback_outbox", "reply_json", "TEXT");
      ensureColumn("workers", "protocol_features_json", "TEXT NOT NULL DEFAULT '[]'");
      ensureColumn("workers", "inventory_revision", "INTEGER NOT NULL DEFAULT 0");
      ensureColumn("workers", "settings_applied_version", "INTEGER NOT NULL DEFAULT 0");
      ensureColumn("workers", "preferences_applied_version", "INTEGER NOT NULL DEFAULT 0");
      ensureColumn("workers", "availability_json", "TEXT");
      ensureColumn("worker_models", "present", "INTEGER NOT NULL DEFAULT 1");
      ensureColumn("worker_models", "last_seen_at", "INTEGER");
      ensureColumn("systems", "entry_url", "TEXT");
      this.connection.exec(`
        CREATE TABLE IF NOT EXISTS task_runs (
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), run_number INTEGER NOT NULL,
          trigger TEXT NOT NULL, status TEXT NOT NULL, max_attempts INTEGER NOT NULL,
          attempts_used INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, finished_at INTEGER,
          result_json TEXT, failure_json TEXT, UNIQUE(task_id, run_number)
        );
        CREATE TABLE IF NOT EXISTS task_dispatch_state (task_id TEXT PRIMARY KEY REFERENCES tasks(id), run_id TEXT, primary_reason TEXT, reasons_json TEXT NOT NULL DEFAULT '[]', candidates_json TEXT NOT NULL DEFAULT '[]', reason_hash TEXT, blocked_since INTEGER, evaluated_at INTEGER, dispatch_not_before INTEGER);
        CREATE TABLE IF NOT EXISTS operation_receipts (scope TEXT NOT NULL, operation_key TEXT NOT NULL, request_hash TEXT NOT NULL, status_code INTEGER NOT NULL, response_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(scope, operation_key));
        CREATE TABLE IF NOT EXISTS runtime_metadata (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS worker_workspaces (worker_id TEXT NOT NULL REFERENCES workers(id), workspace_id TEXT NOT NULL, display_name TEXT NOT NULL, capabilities_json TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL, config_version INTEGER NOT NULL DEFAULT 0, checked_at INTEGER NOT NULL, PRIMARY KEY(worker_id, workspace_id));
        CREATE TABLE IF NOT EXISTS worker_preferences (worker_id TEXT PRIMARY KEY REFERENCES workers(id), version INTEGER NOT NULL DEFAULT 1, mode TEXT NOT NULL DEFAULT 'NORMAL', pause_id TEXT, pause_until INTEGER, pause_indefinite INTEGER NOT NULL DEFAULT 0, idle_threshold_seconds INTEGER, updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS worker_onboarding (id TEXT PRIMARY KEY, platform TEXT NOT NULL, selected_capabilities_json TEXT NOT NULL DEFAULT '[]', selected_workspaces_json TEXT NOT NULL DEFAULT '[]', registration_id TEXT, worker_id TEXT, last_step TEXT NOT NULL DEFAULT 'SELECT_PLATFORM', diagnostic_task_ids_json TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, abandoned_at INTEGER);
        CREATE TABLE IF NOT EXISTS model_preferences (id TEXT PRIMARY KEY, name TEXT NOT NULL, task_type TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, targets_json TEXT NOT NULL, allow_fallback INTEGER NOT NULL DEFAULT 1, deleted_at INTEGER, updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS model_test_batches (id TEXT PRIMARY KEY, template_id TEXT NOT NULL, template_version INTEGER NOT NULL, input_json TEXT NOT NULL, parameters_json TEXT NOT NULL, input_hash TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, finished_at INTEGER);
        CREATE TABLE IF NOT EXISTS model_test_cases (batch_id TEXT NOT NULL REFERENCES model_test_batches(id), position INTEGER NOT NULL, target_json TEXT NOT NULL, task_id TEXT UNIQUE REFERENCES tasks(id), queue_deadline_at INTEGER, state TEXT NOT NULL, skip_reason TEXT, PRIMARY KEY(batch_id, position));
      `);
      this.connection.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_created_seq_unique ON tasks(created_seq) WHERE created_seq IS NOT NULL");
      this.connection.exec("CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC, id DESC)");
      this.connection.exec("CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, created_at DESC, id DESC)");
      this.connection.exec("CREATE INDEX IF NOT EXISTS idx_tasks_purpose_finished ON tasks(purpose, finished_at DESC, id DESC)");
      this.connection.exec("CREATE INDEX IF NOT EXISTS idx_task_runs_task_number ON task_runs(task_id, run_number)");
      this.connection.exec("CREATE INDEX IF NOT EXISTS idx_attempts_worker_occupancy ON task_attempts(worker_id, occupancy)");
      this.connection.exec("CREATE INDEX IF NOT EXISTS idx_callback_state_due ON callback_outbox(state, available_at, claimed_until)");
      this.connection.exec("CREATE INDEX IF NOT EXISTS idx_callback_task_run ON callback_outbox(task_id, run_id)");
      this.connection.exec("CREATE INDEX IF NOT EXISTS idx_artifacts_state_created ON artifacts(storage_state, created_at)");
      this.connection.exec("DROP INDEX IF EXISTS idx_artifacts_task_key; CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_task_key ON artifacts(attempt_id, artifact_key) WHERE artifact_key IS NOT NULL");
      const legacyTasks = this.connection.prepare("SELECT id, status, max_attempts, created_at, finished_at, current_attempt_id, attempt_count, current_run_id FROM tasks WHERE current_run_id IS NULL ORDER BY created_at, id").all() as Array<Record<string, any>>;
      for (const task of legacyTasks) {
        const runId = `legacy-${String(task.id)}`;
        this.connection.prepare("INSERT OR IGNORE INTO task_runs(id, task_id, run_number, trigger, status, max_attempts, attempts_used, created_at, finished_at) VALUES (?, ?, 1, 'LEGACY', ?, ?, ?, ?, ?)").run(runId, task.id, task.status, Number(task.max_attempts ?? 1), Number(task.attempt_count ?? 0), task.created_at, task.finished_at ?? null);
        this.connection.prepare("UPDATE tasks SET current_run_id = ? WHERE id = ? AND current_run_id IS NULL").run(runId, task.id);
        this.connection.prepare("UPDATE task_attempts SET run_id = ?, attempt_in_run = COALESCE(attempt_in_run, attempt_number) WHERE task_id = ? AND run_id IS NULL").run(runId, task.id);
      }
      this.connection.exec("UPDATE task_attempts SET occupancy = CASE WHEN status = 'OFFERED' THEN 'RESERVED' WHEN status IN ('ACCEPTED', 'RUNNING') THEN 'RUNNING' ELSE 'RELEASED' END WHERE occupancy = 'RELEASED'");
      const maxCreatedSeq = Number(this.connection.prepare("SELECT COALESCE(MAX(created_seq), 0) AS value FROM tasks").get()?.value ?? 0);
      let nextSequence = maxCreatedSeq + 1;
      const missingSequences = this.connection.prepare("SELECT id FROM tasks WHERE created_seq IS NULL ORDER BY created_at, id").all() as Array<{ id: string }>;
      for (const task of missingSequences) this.connection.prepare("UPDATE tasks SET created_seq = ? WHERE id = ?").run(nextSequence++, task.id);
      const nextTaskSeq = Number(this.connection.prepare("SELECT COALESCE(MAX(created_seq), 0) + 1 AS value FROM tasks").get()?.value ?? 1);
      this.connection.prepare("INSERT INTO runtime_metadata(key, value_json) VALUES ('next_task_seq', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json").run(JSON.stringify(nextTaskSeq));
      this.connection.prepare("INSERT INTO runtime_metadata(key, value_json) VALUES ('list_revision', '0') ON CONFLICT(key) DO NOTHING").run();
      const existing = this.connection.prepare("SELECT version FROM schema_migrations WHERE version = 1").get();
      if (!existing) this.connection.prepare("INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (1, ?, ?)").run("control-plane-v2", Date.now());
      const workerProjection = this.connection.prepare("SELECT version FROM schema_migrations WHERE version = 2").get();
      if (!workerProjection) this.connection.prepare("INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (2, ?, ?)").run("worker-management-projection", Date.now());
      for (const [version, checksum] of [[3, "task-runs-and-receipts"], [4, "artifact-callback-projection"], [5, "worker-preferences-and-workspaces"], [6, "model-tests-and-preferences"]] as const) {
        this.connection.prepare("INSERT OR IGNORE INTO schema_migrations(version, checksum, applied_at) VALUES (?, ?, ?)").run(version, checksum, Date.now());
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
