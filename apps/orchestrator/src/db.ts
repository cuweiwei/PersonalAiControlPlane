import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const INITIAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  source_json TEXT NOT NULL,
  intent TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  constraints_json TEXT NOT NULL,
  memory_requirement TEXT NOT NULL CHECK (memory_requirement IN ('required', 'preferred', 'none')),
  status TEXT NOT NULL,
  active_plan_revision INTEGER,
  state_version INTEGER NOT NULL DEFAULT 0,
  policy_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS goals_status_updated_idx ON goals(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS plans (
  goal_id TEXT NOT NULL REFERENCES goals(id),
  revision INTEGER NOT NULL,
  plan_json TEXT NOT NULL,
  digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (goal_id, revision),
  UNIQUE (goal_id, digest)
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(id),
  plan_revision INTEGER NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 2,
  required INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0, 1)),
  side_effect_class TEXT NOT NULL DEFAULT 'NONE',
  definition_json TEXT NOT NULL DEFAULT '{}',
  capability_requirements_json TEXT NOT NULL DEFAULT '[]',
  budget_json TEXT NOT NULL DEFAULT '{}',
  sandbox_json TEXT NOT NULL DEFAULT '{}',
  retry_policy_json TEXT NOT NULL DEFAULT '{}',
  verification_json TEXT NOT NULL DEFAULT '{}',
  idempotency_key TEXT,
  state_version INTEGER NOT NULL DEFAULT 0,
  fencing_counter INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  error_json TEXT,
  ready_at INTEGER,
  cancel_requested_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (goal_id, plan_revision, idempotency_key),
  FOREIGN KEY (goal_id, plan_revision) REFERENCES plans(goal_id, revision)
);
CREATE INDEX IF NOT EXISTS tasks_ready_idx ON tasks(state, priority, ready_at);
CREATE INDEX IF NOT EXISTS tasks_goal_idx ON tasks(goal_id, plan_revision);

CREATE TABLE IF NOT EXISTS task_edges (
  goal_id TEXT NOT NULL,
  plan_revision INTEGER NOT NULL,
  from_task_id TEXT NOT NULL REFERENCES tasks(id),
  to_task_id TEXT NOT NULL REFERENCES tasks(id),
  PRIMARY KEY (goal_id, plan_revision, from_task_id, to_task_id),
  CHECK (from_task_id <> to_task_id)
);

CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  generation INTEGER NOT NULL,
  worker_id TEXT,
  provider_id TEXT,
  state TEXT NOT NULL,
  lease_id TEXT,
  fencing_token INTEGER,
  checkpoint_id TEXT,
  external_operation_id TEXT,
  usage_json TEXT NOT NULL DEFAULT '{}',
  result_class TEXT,
  started_at INTEGER,
  ended_at INTEGER,
  UNIQUE (task_id, generation)
);

CREATE TABLE IF NOT EXISTS leases (
  id TEXT PRIMARY KEY,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  attempt_id TEXT REFERENCES attempts(id),
  fencing_token INTEGER NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  released_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS live_resource_lease_idx
  ON leases(resource_type, resource_id) WHERE released_at IS NULL;

CREATE TABLE IF NOT EXISTS task_events (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  previous_state TEXT,
  new_state TEXT,
  actor TEXT NOT NULL,
  attempt_id TEXT,
  plan_digest TEXT,
  policy_version INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, sequence)
);

CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  available_at INTEGER NOT NULL,
  claimed_until INTEGER,
  claim_token TEXT,
  delivered_at INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS outbox_available_idx ON outbox(delivered_at, available_at, claimed_until);

CREATE TABLE IF NOT EXISTS idempotency_records (
  actor_id TEXT NOT NULL,
  route TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY (actor_id, route, key)
);

CREATE TABLE IF NOT EXISTS policy_revisions (
  version INTEGER PRIMARY KEY,
  policy_json TEXT NOT NULL,
  digest TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  decision TEXT NOT NULL,
  policy_version INTEGER NOT NULL,
  metadata_json TEXT NOT NULL,
  previous_hash TEXT,
  hash TEXT NOT NULL,
  occurred_at INTEGER NOT NULL
);
`;

const EXTENDED_SCHEMA = `
CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  schema_version INTEGER NOT NULL,
  artifact_hash TEXT,
  portable INTEGER NOT NULL DEFAULT 0 CHECK (portable IN (0, 1)),
  provider_kind TEXT,
  resume_reference_ref TEXT,
  next_action TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS approval_requests (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(id),
  task_id TEXT REFERENCES tasks(id),
  plan_digest TEXT NOT NULL,
  policy_version INTEGER NOT NULL,
  required_scope_json TEXT NOT NULL,
  risk_json TEXT NOT NULL DEFAULT '{}',
  channel_limits_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED')),
  expires_at INTEGER NOT NULL,
  correlation_id TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by TEXT
);
CREATE INDEX IF NOT EXISTS approval_requests_status_idx ON approval_requests(status, expires_at);

CREATE TABLE IF NOT EXISTS approval_grants (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES approval_requests(id),
  signed_grant_digest TEXT NOT NULL,
  bounded_scope_json TEXT NOT NULL,
  approver TEXT NOT NULL,
  auth_time INTEGER NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'PAUSED', 'DISABLED')),
  timezone TEXT NOT NULL,
  recurrence TEXT NOT NULL,
  next_run_at INTEGER,
  misfire_policy TEXT NOT NULL,
  goal_template_json TEXT NOT NULL,
  state_version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS schedule_firings (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES schedules(id),
  intended_run_at INTEGER NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  goal_id TEXT REFERENCES goals(id),
  disposition TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workers (
  id TEXT PRIMARY KEY,
  identity_subject TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  trust_state TEXT NOT NULL,
  protocol_min TEXT NOT NULL,
  protocol_max TEXT NOT NULL,
  last_heartbeat_at INTEGER,
  stale_at INTEGER,
  wake_policy_json TEXT NOT NULL DEFAULT '{}',
  drain_state TEXT NOT NULL DEFAULT 'RUNNABLE',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS capabilities (
  id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL REFERENCES workers(id),
  kind TEXT NOT NULL,
  version TEXT NOT NULL,
  descriptor_hash TEXT NOT NULL,
  descriptor_json TEXT NOT NULL,
  discovered_state TEXT NOT NULL,
  grant_state TEXT NOT NULL,
  health TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(worker_id, kind, version, descriptor_hash)
);

CREATE TABLE IF NOT EXISTS resource_reservations (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  attempt_id TEXT REFERENCES attempts(id),
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  amount_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('HELD', 'RELEASED', 'COMMITTED', 'EXPIRED')),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  released_at INTEGER
);
CREATE INDEX IF NOT EXISTS resource_reservations_live_idx ON resource_reservations(resource_type, resource_id, status, expires_at);

CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  class TEXT NOT NULL,
  adapter TEXT NOT NULL,
  worker_id TEXT REFERENCES workers(id),
  status TEXT NOT NULL,
  descriptor_json TEXT NOT NULL DEFAULT '{}',
  last_probe_at INTEGER,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS quota_observations (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id),
  account_handle TEXT NOT NULL,
  window TEXT NOT NULL,
  used_json TEXT NOT NULL,
  remaining_json TEXT NOT NULL,
  confidence TEXT NOT NULL,
  source TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  recovery_at INTEGER
);

CREATE TABLE IF NOT EXISTS credential_handles (
  id TEXT PRIMARY KEY,
  alias TEXT NOT NULL UNIQUE,
  storage_class TEXT NOT NULL,
  adapter TEXT NOT NULL,
  purpose TEXT NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  health TEXT NOT NULL,
  expires_at INTEGER,
  last_verified_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS connector_runs (
  id TEXT PRIMARY KEY,
  connector TEXT NOT NULL,
  source_account_handle TEXT NOT NULL,
  cursor_ref TEXT,
  state TEXT NOT NULL,
  counters_json TEXT NOT NULL DEFAULT '{}',
  error_class TEXT,
  next_retry_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS proactive_triggers (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  domain TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  evidence_json TEXT NOT NULL,
  disposition TEXT NOT NULL,
  goal_id TEXT,
  notification_id TEXT,
  observed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS capability_proposals (
  id TEXT PRIMARY KEY,
  blocked_goal_id TEXT REFERENCES goals(id),
  blocked_task_id TEXT REFERENCES tasks(id),
  target_repository TEXT NOT NULL,
  contract_json TEXT NOT NULL,
  permission_json TEXT NOT NULL,
  estimate_json TEXT NOT NULL,
  risk_json TEXT NOT NULL,
  test_json TEXT NOT NULL,
  release_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
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

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  goal_id TEXT REFERENCES goals(id),
  task_id TEXT REFERENCES tasks(id),
  approval_id TEXT REFERENCES approval_requests(id),
  channel TEXT NOT NULL,
  recipient_handle TEXT NOT NULL,
  template TEXT NOT NULL,
  status TEXT NOT NULL,
  provider_correlation TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reconciliation_records (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  attempt_id TEXT REFERENCES attempts(id),
  provider TEXT NOT NULL,
  operation_kind TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  external_operation_id TEXT,
  request_digest TEXT NOT NULL,
  expected_resource_json TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  last_observed_state TEXT NOT NULL,
  reconciliation_strategy TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'CONFIRMED', 'ABSENT', 'UNKNOWN', 'FAILED')),
  last_observed_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS reconciliation_open_idx ON reconciliation_records(status, last_observed_at);
`;

const OWNER_MANAGEMENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS worker_enrollment_requests (
  id TEXT PRIMARY KEY,
  public_key_pem TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  device_summary_json TEXT NOT NULL,
  challenge_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED')),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by TEXT
);
CREATE INDEX IF NOT EXISTS worker_enrollment_status_idx ON worker_enrollment_requests(status, expires_at);
`;

export type SqlRow = Record<string, unknown>;

export class OrchestratorDatabase {
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
      this.connection.exec(INITIAL_SCHEMA);
      const migration = this.connection.prepare("SELECT version FROM schema_migrations WHERE version = 1").get();
      if (!migration) {
        this.connection.prepare(
          "INSERT INTO schema_migrations(version, checksum, applied_at) VALUES(1, ?, ?)",
        ).run("initial-schema-v1", Date.now());
      }
      const secondMigration = this.connection.prepare("SELECT version FROM schema_migrations WHERE version = 2").get();
      if (!secondMigration) {
        const goalColumns = this.connection.prepare("PRAGMA table_info(goals)").all() as Array<{ name: string }>;
        if (!goalColumns.some((column) => column.name === "active_plan_revision")) {
          this.connection.exec("ALTER TABLE goals ADD COLUMN active_plan_revision INTEGER");
        }
        this.connection.prepare(
          "INSERT INTO schema_migrations(version, checksum, applied_at) VALUES(2, ?, ?)",
        ).run("active-plan-column-v2", Date.now());
      }
      const thirdMigration = this.connection.prepare("SELECT version FROM schema_migrations WHERE version = 3").get();
      if (!thirdMigration) {
        const outboxColumns = this.connection.prepare("PRAGMA table_info(outbox)").all() as Array<{ name: string }>;
        if (!outboxColumns.some((column) => column.name === "claim_token")) {
          this.connection.exec("ALTER TABLE outbox ADD COLUMN claim_token TEXT");
        }
        this.connection.prepare(
          "INSERT INTO schema_migrations(version, checksum, applied_at) VALUES(3, ?, ?)",
        ).run("outbox-claim-token-v3", Date.now());
      }
      const fourthMigration = this.connection.prepare("SELECT version FROM schema_migrations WHERE version = 4").get();
      if (!fourthMigration) {
        this.connection.exec(EXTENDED_SCHEMA);
        this.connection.prepare(
          "INSERT INTO schema_migrations(version, checksum, applied_at) VALUES(4, ?, ?)",
        ).run("orchestrator-control-surfaces-v4", Date.now());
      }
      const fifthMigration = this.connection.prepare("SELECT version FROM schema_migrations WHERE version = 5").get();
      if (!fifthMigration) {
        const outboxColumns = this.connection.prepare("PRAGMA table_info(outbox)").all() as Array<{ name: string }>;
        if (!outboxColumns.some((column) => column.name === "dead_lettered_at")) {
          this.connection.exec("ALTER TABLE outbox ADD COLUMN dead_lettered_at INTEGER");
        }
        if (!outboxColumns.some((column) => column.name === "dead_letter_reason")) {
          this.connection.exec("ALTER TABLE outbox ADD COLUMN dead_letter_reason TEXT");
        }
        this.connection.prepare(
          "INSERT INTO schema_migrations(version, checksum, applied_at) VALUES(5, ?, ?)",
        ).run("outbox-dead-letter-v5", Date.now());
      }
      const sixthMigration = this.connection.prepare("SELECT version FROM schema_migrations WHERE version = 6").get();
      if (!sixthMigration) {
        this.connection.exec(OWNER_MANAGEMENT_SCHEMA);
        this.connection.prepare(
          "INSERT INTO schema_migrations(version, checksum, applied_at) VALUES(6, ?, ?)",
        ).run("owner-management-surfaces-v6", Date.now());
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

  one<T extends SqlRow = SqlRow>(sql: string, ...parameters: unknown[]): T | undefined {
    return this.connection.prepare(sql).get(...parameters) as T | undefined;
  }

  all<T extends SqlRow = SqlRow>(sql: string, ...parameters: unknown[]): T[] {
    return this.connection.prepare(sql).all(...parameters) as T[];
  }

  run(sql: string, ...parameters: unknown[]): void {
    this.connection.prepare(sql).run(...parameters);
  }

  close(): void {
    this.connection.close();
  }
}
