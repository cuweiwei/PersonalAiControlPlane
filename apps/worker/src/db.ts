import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS worker_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS accepted_jobs (
  attempt_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  offer_digest TEXT NOT NULL,
  fencing_token INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ACCEPTED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED')),
  checkpoint_json TEXT,
  result_json TEXT,
  accepted_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS consumed_grants (
  jti TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER NOT NULL
);
`;

export class WorkerDatabase {
  readonly connection: InstanceType<typeof DatabaseSync>;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.connection = new DatabaseSync(path);
    this.connection.exec("PRAGMA journal_mode = WAL");
    this.connection.exec("PRAGMA synchronous = FULL");
    this.connection.exec("PRAGMA busy_timeout = 5000");
    this.connection.exec("PRAGMA trusted_schema = OFF");
    this.connection.exec(SCHEMA);
    this.connection.prepare("INSERT OR IGNORE INTO worker_state(key, value) VALUES ('sequence', '-1')").run();
  }
  transaction<T>(callback: () => T): T { this.connection.exec("BEGIN IMMEDIATE"); try { const value = callback(); this.connection.exec("COMMIT"); return value; } catch (error) { this.connection.exec("ROLLBACK"); throw error; } }
  close(): void { this.connection.close(); }
}
