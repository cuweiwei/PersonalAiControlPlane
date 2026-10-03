import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ControlPlaneDatabase } from "../apps/control-plane/src/db/database.ts";
import { EventHub } from "../apps/control-plane/src/events/event-hub.ts";
import { ArtifactStorage } from "../apps/control-plane/src/artifacts/artifact-storage.ts";
import { SettingsService } from "../apps/control-plane/src/settings/settings-service.ts";
import { AgentWorkService } from "../apps/control-plane/src/agent-work/agent-work-service.ts";
import { MissionService } from "../apps/control-plane/src/missions/mission-service.ts";
import { TaskService } from "../apps/control-plane/src/tasks/task-service.ts";
import { WorkerService } from "../apps/control-plane/src/workers/worker-service.ts";
import { HealthMonitor } from "../apps/control-plane/src/systems/health-monitor.ts";
import { OfficeService } from "../apps/control-plane/src/office/office-service.ts";
import { createControlPlaneServer } from "../apps/control-plane/src/server.ts";
import type { WorkerCoordinator } from "../apps/control-plane/src/workers/worker-channel.ts";

const DAY = 24 * 60 * 60 * 1000;
const BASE_NOW = 1_800_000_000_000;

async function fixture(databasePath = ":memory:") {
  const directory = await mkdtemp(join(tmpdir(), "pai-attention-center-"));
  const db = new ControlPlaneDatabase(databasePath === ":memory:" ? databasePath : join(directory, "controlplane.db"));
  const events = new EventHub();
  const settings = new SettingsService(db);
  const artifacts = new ArtifactStorage(directory);
  const missions = new MissionService(db, events, settings);
  settings.patch({ office_enabled: true, agent_work_attention_enabled: true });
  const service = new AgentWorkService({ db, events, settings, artifacts, missions });
  const attention = (subjectId: string, now = BASE_NOW, fingerprint = "fingerprint") => service.upsertAttention({ subject_kind: "TASK", subject_id: subjectId, reason_code: "WAITING_FOR_INPUT", fingerprint, severity: "NORMAL", evidence: { source: "test" } }, now);
  const close = async () => { db.close(); await rm(directory, { recursive: true, force: true }); };
  return { db, events, settings, service, artifacts, missions, attention, close, directory };
}

test("Attention projections apply snooze expiry before limit without changing persisted state", async () => {
  const { db, service, attention, close } = await fixture();
  try {
    const live = attention("live", BASE_NOW);
    service.attentionCommand(String(live.id), { kind: "SNOOZE", expected_revision: 1, payload: { snooze_until: BASE_NOW + 4 * 60 * 60 * 1000 } }, "owner", "live-snooze", BASE_NOW);
    const expired = attention("expired", BASE_NOW + 100);
    service.attentionCommand(String(expired.id), { kind: "SNOOZE", expected_revision: 1, payload: { snooze_until: BASE_NOW + 2 * 60 * 60 * 1000 } }, "owner", "expired-snooze", BASE_NOW + 100);

    const observedAt = BASE_NOW + 3 * 60 * 60 * 1000;
    const snoozed = service.listAttention({ state: "SNOOZED", limit: 1 }, observedAt);
    assert.equal(snoozed.length, 1);
    assert.equal(snoozed[0].id, live.id);
    assert.equal(snoozed[0].effectiveState, "SNOOZED");
    const open = service.listAttention({ state: "OPEN", limit: 1 }, observedAt);
    assert.equal(open.length, 1);
    assert.equal(open[0].id, expired.id);
    assert.equal(open[0].state, "SNOOZED");
    assert.equal(open[0].effectiveState, "OPEN");
    assert.equal(open[0].revision, 2);
    assert.equal(db.one("SELECT state FROM attention_items WHERE id = ?", expired.id)?.state, "SNOOZED");
    assert.throws(() => service.listAttention({ state: "invalid" }), /INVALID_FIELD:state/);
    assert.throws(() => service.listAttention({ severity: "invalid" }), /INVALID_FIELD:severity/);
    for (const limit of [0, 1.5, 101, Number.NaN]) assert.throws(() => service.listAttention({ limit }), /INVALID_FIELD:limit/);
  } finally { await close(); }
});

test("Attention READ follows changeRevision and snooze/unsnooze preserve unread state", async () => {
  const { db, service, attention, close } = await fixture();
  try {
    const item = attention("revision");
    db.run("UPDATE attention_items SET revision = 7, change_revision = 3, read_through_revision = 1 WHERE id = ?", item.id);
    const read = service.attentionCommand(String(item.id), { kind: "READ", expected_revision: 7 }, "owner", "read-revision", BASE_NOW);
    assert.equal(read.state, "APPLIED");
    let row = db.one("SELECT state, revision, change_revision, read_through_revision FROM attention_items WHERE id = ?", item.id)!;
    assert.deepEqual({ ...row }, { state: "OPEN", revision: 7, change_revision: 3, read_through_revision: 3 });

    service.attentionCommand(String(item.id), { kind: "SNOOZE", expected_revision: 7, payload: { snooze_until: BASE_NOW + 60_000 } }, "owner", "read-snooze", BASE_NOW);
    row = db.one("SELECT state, revision, change_revision, read_through_revision FROM attention_items WHERE id = ?", item.id)!;
    assert.deepEqual({ ...row }, { state: "SNOOZED", revision: 8, change_revision: 3, read_through_revision: 3 });
    service.attentionCommand(String(item.id), { kind: "UNSNOOZE", expected_revision: 8 }, "owner", "read-unsnooze", BASE_NOW + 60_001);
    row = db.one("SELECT state, revision, change_revision, read_through_revision FROM attention_items WHERE id = ?", item.id)!;
    assert.deepEqual({ ...row }, { state: "OPEN", revision: 9, change_revision: 3, read_through_revision: 3 });
  } finally { await close(); }
});

test("Attention idempotency replay returns the original snooze result after its deadline", async () => {
  const { db, events, service, attention, close } = await fixture();
  try {
    const item = attention("replay");
    const published: unknown[] = [];
    events.subscribe((event) => published.push(event));
    const request = { kind: "SNOOZE", expected_revision: 1, payload: { snooze_until: BASE_NOW + 60_000 } };
    const first = service.attentionCommand(String(item.id), request, "owner", "snooze-replay", BASE_NOW);
    const afterFirst = db.one("SELECT state, revision, snooze_until FROM attention_items WHERE id = ?", item.id);
    const eventCount = db.one("SELECT COUNT(*) AS count FROM agent_events WHERE subject_kind = 'ATTENTION' AND subject_id = ?", item.id)?.count;

    const replay = service.attentionCommand(String(item.id), request, "owner", "snooze-replay", BASE_NOW + 120_000);
    assert.deepEqual(replay, first);
    assert.deepEqual(db.one("SELECT state, revision, snooze_until FROM attention_items WHERE id = ?", item.id), afterFirst);
    assert.equal(db.one("SELECT COUNT(*) AS count FROM agent_events WHERE subject_kind = 'ATTENTION' AND subject_id = ?", item.id)?.count, eventCount);
    assert.equal(published.length, 1);
    assert.throws(() => service.attentionCommand(String(item.id), { ...request, payload: { snooze_until: BASE_NOW + 120_000 } }, "owner", "snooze-replay", BASE_NOW), /IDEMPOTENCY_CONFLICT/);
    assert.throws(() => service.attentionCommand(String(item.id), { ...request, expected_revision: 9 }, "owner", "stale-revision", BASE_NOW), /REVISION_CONFLICT/);
  } finally { await close(); }
});

test("Attention rejects invalid snooze ranges and terminal states", async () => {
  const { db, service, attention, close } = await fixture();
  try {
    const item = attention("invalid-snooze");
    const invalidTimes = [0, BASE_NOW - 1, BASE_NOW + 30 * DAY + 1, Number.NaN, BASE_NOW + 1.5];
    for (const [index, snoozeUntil] of invalidTimes.entries()) {
      assert.throws(() => service.attentionCommand(String(item.id), { kind: "SNOOZE", expected_revision: 1, payload: { snooze_until: snoozeUntil } }, "owner", `invalid-snooze-${index}`, BASE_NOW), /INVALID_FIELD/);
    }
    assert.throws(() => service.attentionCommand(String(item.id), { kind: "SNOOZE", expected_revision: 1, payload: { snooze_until: BASE_NOW + 1000, extra: true } }, "owner", "extra-snooze-field", BASE_NOW), /UNKNOWN_FIELD/);
    db.run("UPDATE attention_items SET state = 'RESOLVED' WHERE id = ?", item.id);
    assert.throws(() => service.attentionCommand(String(item.id), { kind: "SNOOZE", expected_revision: 1, payload: { snooze_until: BASE_NOW + 1000 } }, "owner", "terminal-snooze", BASE_NOW), /INVALID_ATTENTION_STATE/);
    assert.equal(db.one("SELECT state, revision FROM attention_items WHERE id = ?", item.id)?.state, "RESOLVED");
    assert.equal(db.one("SELECT revision FROM attention_items WHERE id = ?", item.id)?.revision, 1);
  } finally { await close(); }
});

test("Attention feature gate blocks READ, SNOOZE, and UNSNOOZE before creating operations", async () => {
  const { db, settings, service, attention, close } = await fixture();
  try {
    const item = attention("disabled");
    settings.patch({ agent_work_attention_enabled: false });
    for (const command of [
      { kind: "READ", expected_revision: 1 },
      { kind: "SNOOZE", expected_revision: 1, payload: { snooze_until: BASE_NOW + 1000 } },
      { kind: "UNSNOOZE", expected_revision: 1 },
    ]) assert.throws(() => service.attentionCommand(String(item.id), command, "owner", `disabled-${command.kind}`, BASE_NOW), /FEATURE_DISABLED/);
    assert.equal(db.one("SELECT COUNT(*) AS count FROM agent_operations WHERE resource_id = ?", item.id)?.count, 0);
  } finally { await close(); }
});

test("Attention episodes use historical MAX and duplicate fingerprints stay idempotent", async () => {
  const { db, service, attention, close } = await fixture();
  try {
    const first = attention("episodes", BASE_NOW, "first");
    db.run("UPDATE attention_items SET state = 'SUPERSEDED' WHERE id = ?", first.id);
    const second = attention("episodes", BASE_NOW + 1, "second");
    assert.equal(second.episode, 2);
    const duplicate = attention("episodes", BASE_NOW + 2, "second");
    assert.equal(duplicate.id, second.id);
    assert.equal(db.one("SELECT COUNT(*) AS count FROM attention_items WHERE subject_id = 'episodes'")?.count, 2);
  } finally { await close(); }
});

test("Attention snooze projection survives reopening the SQLite database", async () => {
  const context = await fixture("file");
  try {
    const item = context.attention("reopen");
    context.service.attentionCommand(String(item.id), { kind: "SNOOZE", expected_revision: 1, payload: { snooze_until: BASE_NOW + 60_000 } }, "owner", "persist-snooze", BASE_NOW);
    context.db.close();
    const reopenedDb = new ControlPlaneDatabase(join(context.directory, "controlplane.db"));
    try {
      const reopenedSettings = new SettingsService(reopenedDb);
      const reopened = new AgentWorkService({ db: reopenedDb, events: new EventHub(), settings: reopenedSettings, artifacts: context.artifacts, missions: new MissionService(reopenedDb, new EventHub(), reopenedSettings) });
      const itemAfterRestart = reopened.listAttention({ state: "OPEN" }, BASE_NOW + 60_000)[0];
      assert.equal(itemAfterRestart.state, "SNOOZED");
      assert.equal(itemAfterRestart.effectiveState, "OPEN");
      assert.equal(itemAfterRestart.revision, 2);
      assert.equal(reopenedDb.one("SELECT state, revision FROM attention_items WHERE id = ?", item.id)?.state, "SNOOZED");
    } finally { reopenedDb.close(); }
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test("Attention HTTP list and detail validate filters and return projection metadata", async () => {
  const { db, events, settings, service, artifacts, missions, attention, close } = await fixture();
  const tasks = new TaskService(db, events, { callbackEnabled: false });
  const workers = new WorkerService(db, events);
  const health = new HealthMonitor(db, events); health.seed();
  const office = new OfficeService(db, events, settings);
  const workerCoordinator = { closeWorker: () => {}, handleUpgrade: () => {}, isConnected: () => true, offer: () => true } as unknown as WorkerCoordinator;
  const server = createControlPlaneServer({ db, tasks, workers, coordinator: workerCoordinator, artifacts, settings, health, events, office, missions, agentWork: service, assetRoot: artifacts.root });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const item = attention("http");
    const list = await fetch(`${origin}/api/v2/attention?state=OPEN&severity=NORMAL&limit=1`).then((response) => response.json()) as any;
    assert.equal(list.items[0].id, item.id);
    assert.equal(list.items[0].effectiveState, "OPEN");
    assert.equal(typeof list.observedAt, "string");
    const detailResponse = await fetch(`${origin}/api/v2/attention/${encodeURIComponent(String(item.id))}`);
    const detail = await detailResponse.json() as any;
    assert.equal(detailResponse.status, 200);
    assert.equal(detail.id, item.id);
    assert.equal(typeof detail.observedAt, "string");
    assert.equal((await fetch(`${origin}/api/v2/attention/missing-id`)).status, 404);
    for (const query of ["state=OTHER", "severity=OTHER", "limit=0", "limit=1.5", "limit=101", "limit=abc"]) {
      assert.equal((await fetch(`${origin}/api/v2/attention?${query}`)).status, 400, query);
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await close();
  }
});
