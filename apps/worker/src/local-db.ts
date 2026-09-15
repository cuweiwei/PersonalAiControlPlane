import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS worker_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS assignments (
  attempt_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  task_type TEXT NOT NULL,
  offer_json TEXT NOT NULL,
  fence_epoch INTEGER NOT NULL DEFAULT 1,
  worker_boot_id TEXT,
  workspace_id TEXT,
  lease_expires_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('ACCEPTED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED')),
  accepted_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS results (
  attempt_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  result_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'DELIVERED')),
  created_at INTEGER NOT NULL,
  delivered_at INTEGER
);
CREATE TABLE IF NOT EXISTS process_registry (
  attempt_id TEXT PRIMARY KEY,
  pid INTEGER,
  process_identity TEXT,
  started_at INTEGER NOT NULL,
  workspace_resource_key TEXT,
  state TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export class WorkerLocalDatabase {
  readonly connection: InstanceType<typeof DatabaseSync>;
  constructor(path: string) { if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true }); this.connection = new DatabaseSync(path); this.connection.exec("PRAGMA journal_mode = WAL"); this.connection.exec("PRAGMA foreign_keys = ON"); this.connection.exec("PRAGMA busy_timeout = 5000"); this.connection.exec("PRAGMA synchronous = NORMAL"); this.connection.exec(SCHEMA); for (const [column, definition] of [["fence_epoch", "INTEGER NOT NULL DEFAULT 1"], ["worker_boot_id", "TEXT"], ["workspace_id", "TEXT"], ["lease_expires_at", "INTEGER"]] as const) { const found = this.connection.prepare("PRAGMA table_info(assignments)").all() as Array<{ name?: string }>; if (!found.some((entry) => entry.name === column)) this.connection.exec(`ALTER TABLE assignments ADD COLUMN ${column} ${definition}`); } }
  transaction<T>(callback: () => T): T { this.connection.exec("BEGIN IMMEDIATE"); try { const result = callback(); this.connection.exec("COMMIT"); return result; } catch (error) { this.connection.exec("ROLLBACK"); throw error; } }
  clearRuntimeData(): void { this.transaction(() => { this.connection.exec("DELETE FROM results; DELETE FROM assignments; DELETE FROM process_registry; DELETE FROM worker_state;"); }); }
  close(): void { this.connection.close(); }
}

export { WorkerLocalDatabase as WorkerDatabase };
