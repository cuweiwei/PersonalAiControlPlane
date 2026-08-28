import assert from "node:assert/strict";
import test from "node:test";
import { OrchestratorDatabase } from "../apps/orchestrator/src/db.ts";
import { OutboxStore, enqueueOutbox } from "../apps/orchestrator/src/outbox.ts";

test("outbox claims at least once and supports delivery/reclaim", () => {
  const db = new OrchestratorDatabase(":memory:");
  let now = 1_700_000_000_000;
  const store = new OutboxStore(db, () => now);
  const id = enqueueOutbox(db, "test.event", "test", "aggregate-1", 1, "test:1", { safe: true }, now);

  const claimed = store.claim(10, 100);
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].id, id);
  assert.equal(claimed[0].attemptCount, 1);
  assert.equal(store.claim().length, 0);

  now += 101;
  const reclaimed = store.claim();
  assert.equal(reclaimed.length, 1);
  assert.throws(() => store.markDelivered(id, claimed[0].claimToken), /OUTBOX_NOT_PENDING/);
  store.markDelivered(id, reclaimed[0].claimToken);
  assert.equal(store.claim().length, 0);
  assert.throws(() => store.markDelivered(id, reclaimed[0].claimToken), /OUTBOX_NOT_PENDING/);
  db.close();
});

test("outbox failure schedules retry without deleting evidence", () => {
  const db = new OrchestratorDatabase(":memory:");
  let now = 1_700_000_000_000;
  const store = new OutboxStore(db, () => now);
  const id = enqueueOutbox(db, "test.event", "test", "aggregate-1", 1, "test:1", { safe: true }, now);
  const claimed = store.claim()[0];
  store.markFailed(id, claimed.claimToken, "provider unavailable", 50);
  assert.equal(db.one("SELECT last_error FROM outbox WHERE id = ?", id)?.last_error, "provider unavailable");
  now += 51;
  assert.equal(store.claim().length, 1);
  db.close();
});
