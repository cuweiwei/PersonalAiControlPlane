import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const IDENTITY_SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS identity_users (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  disabled_at INTEGER
);

CREATE TABLE IF NOT EXISTS identity_profiles (
  user_id TEXT PRIMARY KEY REFERENCES identity_users(id),
  login TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS passkey_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES identity_users(id),
  credential_id TEXT NOT NULL UNIQUE,
  public_key_cose TEXT NOT NULL,
  sign_count INTEGER NOT NULL DEFAULT 0,
  transports_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS passkey_credentials_user_idx ON passkey_credentials(user_id, revoked_at);

CREATE TABLE IF NOT EXISTS auth_challenges (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('registration', 'authentication', 'step_up', 'recovery')),
  user_id TEXT REFERENCES identity_users(id),
  session_id TEXT,
  challenge_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_challenges_expiry_idx ON auth_challenges(expires_at, consumed_at);

CREATE TABLE IF NOT EXISTS registration_intents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES identity_users(id),
  challenge_id TEXT NOT NULL UNIQUE REFERENCES auth_challenges(id),
  login TEXT NOT NULL,
  display_name TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS registration_intents_expiry_idx ON registration_intents(expires_at, consumed_at);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES identity_users(id),
  session_hash TEXT NOT NULL UNIQUE,
  csrf_hash TEXT NOT NULL,
  auth_time INTEGER NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER,
  rotated_from TEXT REFERENCES sessions(id)
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id, revoked_at, expires_at);

CREATE TABLE IF NOT EXISTS recovery_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES identity_users(id),
  code_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE IF NOT EXISTS grant_nonces (
  jti TEXT PRIMARY KEY,
  audience TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS grant_nonces_expiry_idx ON grant_nonces(expires_at);

CREATE TABLE IF NOT EXISTS signing_keys (
  kid TEXT PRIMARY KEY,
  public_key_pem TEXT NOT NULL,
  private_key_ref TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('PENDING', 'ACTIVE', 'RETIRING', 'RETIRED', 'REVOKED')),
  created_at INTEGER NOT NULL,
  activated_at INTEGER,
  retired_at INTEGER,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS workload_identities (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL UNIQUE,
  public_key_pem TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'ROTATING', 'REVOKED', 'EXPIRED')),
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  rotated_at INTEGER,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS workload_request_nonces (
  workload_id TEXT NOT NULL REFERENCES workload_identities(id),
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER NOT NULL,
  PRIMARY KEY(workload_id, nonce)
);
CREATE INDEX IF NOT EXISTS workload_request_nonces_expiry_idx ON workload_request_nonces(expires_at);

CREATE TABLE IF NOT EXISTS workload_idempotency (
  workload_id TEXT NOT NULL REFERENCES workload_identities(id),
  key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(workload_id, key)
);

CREATE TABLE IF NOT EXISTS step_up_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES identity_users(id),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  scope_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  completed_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS identity_audit_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  occurred_at INTEGER NOT NULL
);
`;

export type SqlRow = Record<string, unknown>;

export class IdentityDatabase {
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
      this.connection.exec(IDENTITY_SCHEMA);
      const migration = this.connection.prepare("SELECT version FROM schema_migrations WHERE version = 1").get();
      if (!migration) this.connection.prepare("INSERT INTO schema_migrations(version, checksum, applied_at) VALUES(1, ?, ?)").run("identity-schema-v1", Date.now());
      const secondMigration = this.connection.prepare("SELECT version FROM schema_migrations WHERE version = 2").get();
      if (!secondMigration) this.connection.prepare("INSERT INTO schema_migrations(version, checksum, applied_at) VALUES(2, ?, ?)").run("identity-workloads-v2", Date.now());
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
