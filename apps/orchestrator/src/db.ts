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
