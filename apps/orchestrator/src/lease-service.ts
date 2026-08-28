import { uuidv7 } from "../../../packages/crypto/src/index.ts";
import { OrchestratorDatabase } from "./db.ts";

export type Lease = { id: string; resourceType: string; resourceId: string; taskId: string; attemptId: string | null; fencingToken: number; issuedAt: number; expiresAt: number };

export class LeaseService {
  private readonly db: OrchestratorDatabase;
  private readonly clock: () => number;
  constructor(db: OrchestratorDatabase, clock: () => number = Date.now) { this.db = db; this.clock = clock; }

  acquire(resourceType: string, resourceId: string, taskId: string, attemptId: string | null, ttlMs = 15_000): Lease {
    const now = this.clock();
    if (!resourceType || !resourceId || !taskId || !Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 5 * 60_000) throw new Error("lease request is invalid");
    return this.db.transaction(() => {
      this.db.run("UPDATE leases SET released_at = ? WHERE resource_type = ? AND resource_id = ? AND released_at IS NULL AND expires_at <= ?", now, resourceType, resourceId, now);
      const existing = this.db.one("SELECT id FROM leases WHERE resource_type = ? AND resource_id = ? AND released_at IS NULL", resourceType, resourceId);
      if (existing) throw new Error("resource lease is held");
      const task = this.db.one<{ fencing_counter: number }>("SELECT fencing_counter FROM tasks WHERE id = ?", taskId);
      if (!task) throw new Error("task not found");
      const token = Number(task.fencing_counter) + 1;
      this.db.run("UPDATE tasks SET fencing_counter = ?, updated_at = ? WHERE id = ?", token, now, taskId);
      const lease: Lease = { id: uuidv7(now), resourceType, resourceId, taskId, attemptId, fencingToken: token, issuedAt: now, expiresAt: now + ttlMs };
      this.db.run("INSERT INTO leases(id, resource_type, resource_id, task_id, attempt_id, fencing_token, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", lease.id, resourceType, resourceId, taskId, attemptId, token, now, lease.expiresAt);
      return lease;
    });
  }

  renew(leaseId: string, fencingToken: number, ttlMs = 15_000): Lease {
    const now = this.clock();
    const current = this.db.one<Record<string, unknown>>("SELECT * FROM leases WHERE id = ? AND released_at IS NULL", leaseId);
    if (!current || Number(current.fencing_token) !== fencingToken || Number(current.expires_at) <= now) throw new Error("lease renewal rejected");
    if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 5 * 60_000) throw new Error("lease TTL is invalid");
    this.db.run("UPDATE leases SET expires_at = ? WHERE id = ? AND fencing_token = ? AND released_at IS NULL", now + ttlMs, leaseId, fencingToken);
    return this.get(leaseId)!;
  }

  validate(leaseId: string, fencingToken: number, now = this.clock()): boolean {
    const row = this.db.one<{ fencing_token: number; expires_at: number; released_at: number | null }>("SELECT fencing_token, expires_at, released_at FROM leases WHERE id = ?", leaseId);
    return Boolean(row && row.released_at === null && row.fencing_token === fencingToken && row.expires_at > now);
  }

  release(leaseId: string, fencingToken: number): boolean {
    const result = this.db.connection.prepare("UPDATE leases SET released_at = ? WHERE id = ? AND fencing_token = ? AND released_at IS NULL").run(this.clock(), leaseId, fencingToken);
    return Number(result.changes) === 1;
  }

  reap(now = this.clock()): number {
    const result = this.db.connection.prepare("UPDATE leases SET released_at = ? WHERE released_at IS NULL AND expires_at <= ?").run(now, now);
    return Number(result.changes);
  }

  get(id: string): Lease | undefined {
    const row = this.db.one<Record<string, unknown>>("SELECT * FROM leases WHERE id = ?", id);
    return row ? { id: String(row.id), resourceType: String(row.resource_type), resourceId: String(row.resource_id), taskId: String(row.task_id), attemptId: row.attempt_id === null ? null : String(row.attempt_id), fencingToken: Number(row.fencing_token), issuedAt: Number(row.issued_at), expiresAt: Number(row.expires_at) } : undefined;
  }
}
