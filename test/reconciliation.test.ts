import assert from "node:assert/strict";
import test from "node:test";
import { OrchestratorDatabase } from "../apps/orchestrator/src/db.ts";
import { ReconciliationService } from "../apps/orchestrator/src/reconciliation.ts";

test("reconciliation records preserve uncertain side effects until observed", () => {
  const db = new OrchestratorDatabase(":memory:");
  const now = 1_700_000_000_000;
  const service = new ReconciliationService(db, () => now);
  db.run("INSERT INTO goals(id, owner_id, source_json, intent, scope_json, constraints_json, memory_requirement, status, state_version, policy_version, created_at, updated_at) VALUES ('g', 'o', '{}', 'x', '[]', '{}', 'none', 'ACTIVE', 0, 1, ?, ?)", now, now);
  db.run("INSERT INTO plans(goal_id, revision, plan_json, digest, created_at) VALUES ('g', 1, '{}', 'sha256:p', ?)", now);
  db.run("INSERT INTO tasks(id, goal_id, plan_revision, type, title, state, required, side_effect_class, created_at, updated_at) VALUES ('t', 'g', 1, 'x', 'x', 'WAITING_RECONCILIATION', 1, 'IDEMPOTENT_MUTATION', ?, ?)", now, now);
  const record = service.start({ taskId: "t", attemptId: null, provider: "fake", operationKind: "update", idempotencyKey: "op-1", externalOperationId: null, expectedResource: { version: 2 }, startedAt: now, lastObservedState: "UNKNOWN", reconciliationStrategy: "poll", request: { version: 2 } });
  assert.equal(record.status, "OPEN");
  assert.equal(service.observe(record.id, "version=2", "CONFIRMED").status, "CONFIRMED");
  assert.equal(service.observe(record.id, "version=3", "UNKNOWN").status, "CONFIRMED");
  db.close();
});
