import assert from "node:assert/strict";
import test from "node:test";
import { ControlPlaneDatabase } from "../apps/control-plane/src/db/database.ts";
import { EventHub } from "../apps/control-plane/src/events/event-hub.ts";
import { WorkerService } from "../apps/control-plane/src/workers/worker-service.ts";
import { SettingsService } from "../apps/control-plane/src/settings/settings-service.ts";
import { WorkerLocalDatabase } from "../apps/worker/src/local-db.ts";

function fixture(now = 1_800_000_000_000) {
  const db = new ControlPlaneDatabase(":memory:");
  const events = new EventHub();
  const settings = new SettingsService(db);
  const workers = new WorkerService(db, events, () => ({ defaultEnabled: Boolean(settings.get().auto_resume_default_enabled), emergencyStop: Boolean(settings.get().auto_resume_emergency_stop) }));
  const registration = workers.register({ name: "Resume Worker", registrationSecret: "resume-worker-secret-123", platform: "win32", hardware: {} }, now);
  const approved = workers.approveRegistration(registration.registrationId, "test-owner", now + 1);
  return { db, settings, workers, workerId: String(approved.workerId), now };
}

test("fresh schema has additive resumable ledgers and persisted default-on policy without enabling execution routes", () => {
  const { db, settings, workers, workerId } = fixture();
  assert.equal(settings.get().auto_resume_default_enabled, true);
  assert.equal(settings.get().auto_resume_emergency_stop, false);
  assert.equal(settings.get().orchestration_gateway_enabled, false);
  assert.equal(settings.get().opencode_session_adapter_enabled, false);
  assert.equal(settings.get().codex_managed_host_enabled, false);
  assert.equal(settings.get().quota_recovery_engine_enabled, false);
  assert.equal(settings.get().native_agent_tree_observation_enabled, false);
  assert.equal(settings.get().recovery_pool_max_concurrency, 1);
  assert.equal(settings.getEffective().fields.find((field) => field.key === "opencode_session_adapter_enabled")?.editable, false);
  for (const key of ["orchestration_gateway_enabled", "opencode_session_adapter_enabled", "codex_managed_host_enabled", "quota_recovery_engine_enabled"]) {
    assert.throws(() => settings.patch({ [key]: true }), /FEATURE_UNAVAILABLE/);
  }
  assert.equal(db.one("SELECT version FROM schema_migrations WHERE version = 16") !== undefined, true);
  assert.equal(db.one("SELECT version FROM schema_migrations WHERE version = 17") !== undefined, true);
  assert.equal(db.one("SELECT version FROM schema_migrations WHERE version = 18") !== undefined, true);
  assert.equal(db.one("SELECT version FROM schema_migrations WHERE version = 19") !== undefined, true);
  for (const table of ["orchestration_works", "agent_session_bindings", "quota_pools", "quota_observations", "task_execution_conditions", "recovery_intents", "recovery_events", "codex_agent_nodes", "work_review_handoffs"]) {
    assert.equal(db.one("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", table) !== undefined, true, table);
  }
  const policy = (workers.preferences(workerId) as any).autoResume;
  assert.equal(policy.effective, true);
  assert.equal(policy.source, "GLOBAL_DEFAULT");
  assert.equal(policy.runtimeSupport, "UNSUPPORTED");
  assert.equal(policy.automaticResumeEligible, false);
  assert.equal(workers.verifyAuditChain(), true);
  db.close();
});

test("worker override OFF/ON/inherit preserves unrelated preferences and applies global emergency stop", () => {
  const { db, settings, workers, workerId, now } = fixture();
  const base = workers.updatePreferences(workerId, { mode: "IDLE_ONLY", pause: { kind: "TIMED", durationSeconds: 300 } }, 0, now + 10) as any;
  assert.equal(base.mode, "IDLE_ONLY");
  const off = workers.updatePreferences(workerId, { autoResumeOverride: false }, base.version, now + 11) as any;
  assert.equal(off.mode, "IDLE_ONLY");
  assert.deepEqual(off.pause, base.pause);
  assert.deepEqual(off.autoResume, { override: false, globalDefault: true, emergencyStop: false, effective: false, source: "WORKER_OVERRIDE", runtimeSupport: "UNSUPPORTED", automaticResumeEligible: false });
  const on = workers.updatePreferences(workerId, { autoResumeOverride: true }, off.version, now + 12) as any;
  assert.equal(on.autoResume.effective, true);
  const inherited = workers.updatePreferences(workerId, { autoResumeOverride: null }, on.version, now + 13) as any;
  assert.equal(inherited.autoResume.override, null);
  assert.equal(inherited.autoResume.effective, true);
  settings.patch({ auto_resume_default_enabled: false }, now + 14, 1, "test-owner");
  assert.equal((workers.preferences(workerId) as any).autoResume.effective, false);
  workers.updatePreferences(workerId, { autoResumeOverride: true }, inherited.version, now + 15);
  assert.equal((workers.preferences(workerId) as any).autoResume.effective, true);
  settings.patch({ auto_resume_emergency_stop: true }, now + 16, 2, "test-owner");
  const stopped = (workers.preferences(workerId) as any).autoResume;
  assert.equal(stopped.effective, false);
  assert.equal(stopped.source, "EMERGENCY_STOP");
  assert.equal(workers.verifyAuditChain(), true);
  db.close();
});

test("preference values are validated in service and guarded by SQLite migration trigger", () => {
  const { db, workers, workerId } = fixture();
  assert.throws(() => workers.updatePreferences(workerId, { autoResumeOverride: "yes" as any }, 0), /INVALID_WORKER_PREFERENCE/);
  workers.updatePreferences(workerId, { autoResumeOverride: null }, 0);
  assert.throws(() => db.run("UPDATE worker_preferences SET auto_resume_override = 9 WHERE worker_id = ?", workerId), /INVALID_AUTO_RESUME_OVERRIDE/);
  db.close();
});

test("reopening both SQLite stores keeps resumable schema and worker-local journals durable", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "pai-resume-migration-"));
  const cpPath = join(directory, "controlplane.db"); const workerPath = join(directory, "worker.db");
  try {
    const first = new ControlPlaneDatabase(cpPath); first.run("INSERT INTO settings(key,value_json,updated_at) VALUES ('test_sentinel','1',1)"); first.close();
    const second = new ControlPlaneDatabase(cpPath);
    assert.equal(second.one<any>("SELECT value_json FROM settings WHERE key = 'test_sentinel'")?.value_json, "1");
    assert.equal(second.one("SELECT version FROM schema_migrations WHERE version = 16") !== undefined, true);
    assert.equal(second.one("SELECT version FROM schema_migrations WHERE version = 17") !== undefined, true);
    assert.equal(second.one("SELECT version FROM schema_migrations WHERE version = 18") !== undefined, true);
    assert.equal(second.one("SELECT version FROM schema_migrations WHERE version = 19") !== undefined, true);
    assert.equal(Number(second.one<any>("SELECT value_json FROM runtime_metadata WHERE key = 'settings_version'")?.value_json), 1);
    second.close();
    const local = new WorkerLocalDatabase(workerPath); local.close();
    const reopened = new WorkerLocalDatabase(workerPath);
    assert.equal(reopened.connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='native_session_journal'").get() !== undefined, true);
    assert.equal(reopened.connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='native_resume_operations'").get() !== undefined, true);
    reopened.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
