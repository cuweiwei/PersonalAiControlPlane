import assert from "node:assert/strict";
import test from "node:test";
import { OrchestratorDatabase } from "../apps/orchestrator/src/db.ts";
import { LeaseService } from "../apps/orchestrator/src/lease-service.ts";
import { TaskEngine } from "../apps/orchestrator/src/task-engine.ts";

function seedTask(db: OrchestratorDatabase, now: number): void {
  db.run("INSERT INTO goals(id, owner_id, source_json, intent, scope_json, constraints_json, memory_requirement, status, state_version, policy_version, created_at, updated_at) VALUES ('g', 'o', '{}', 'x', '[]', '{}', 'none', 'ACTIVE', 0, 1, ?, ?)", now, now);
  db.run("INSERT INTO plans(goal_id, revision, plan_json, digest, created_at) VALUES ('g', 1, '{}', 'sha256:p', ?)", now);
  db.run("INSERT INTO tasks(id, goal_id, plan_revision, type, title, state, required, side_effect_class, created_at, updated_at) VALUES ('t', 'g', 1, 'x', 'x', 'READY', 1, 'READ_ONLY', ?, ?)", now, now);
}

test("failed transaction leaves no partial task transition or outbox row", () => {
  const db = new OrchestratorDatabase(":memory:");
  const now = 1_700_000_000_000;
  seedTask(db, now);
  assert.throws(() => db.transaction(() => { db.run("UPDATE tasks SET state = 'RUNNING' WHERE id = 't'"); db.run("INSERT INTO outbox(id, topic, aggregate_type, aggregate_id, aggregate_version, dedupe_key, payload_json, available_at) VALUES ('x', 'test', 'task', 't', 1, 'x', '{}', ?)", now); throw new Error("crash-before-commit"); }), /crash-before-commit/);
  assert.equal(db.one<{ state: string }>("SELECT state FROM tasks WHERE id = 't'")?.state, "READY");
  assert.equal(db.one("SELECT id FROM outbox WHERE id = 'x'"), undefined);
  db.close();
});

test("lease fencing rejects stale renew/release and reclaims expiry", () => {
  let now = 1_700_000_000_000;
  const db = new OrchestratorDatabase(":memory:");
  seedTask(db, now);
  const leases = new LeaseService(db, () => now);
  const first = leases.acquire("worker", "w1", "t", null, 10);
  assert.equal(leases.validate(first.id, first.fencingToken), true);
  assert.throws(() => leases.renew(first.id, first.fencingToken - 1, 10), /rejected/);
  now += 11;
  assert.equal(leases.reap(), 1);
  const second = leases.acquire("worker", "w1", "t", null, 10);
  assert.equal(second.fencingToken, first.fencingToken + 1);
  assert.equal(leases.release(first.id, first.fencingToken), false);
  assert.equal(leases.release(second.id, second.fencingToken), true);
  db.close();
});

test("stale expected state cannot append a second transition", () => {
  const db = new OrchestratorDatabase(":memory:");
  const now = 1_700_000_000_000;
  seedTask(db, now);
  const engine = new TaskEngine(db, () => now);
  engine.transitionTask("t", "DISPATCHED", { type: "STATE_TRANSITION", actor: "scheduler" }, "READY");
  assert.throws(() => engine.transitionTask("t", "RUNNING", { type: "STATE_TRANSITION", actor: "scheduler" }, "READY"), /STATE_CONFLICT/);
  assert.equal(db.one<{ count: number }>("SELECT COUNT(*) AS count FROM task_events WHERE task_id = 't'")?.count, 1);
  db.close();
});
