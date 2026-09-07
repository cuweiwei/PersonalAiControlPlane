import assert from "node:assert/strict";
import test from "node:test";
import { ControlPlaneDatabase } from "../apps/control-plane/src/db/database.ts";
import { EventHub } from "../apps/control-plane/src/events/event-hub.ts";
import { SettingsService } from "../apps/control-plane/src/settings/settings-service.ts";
import { OfficeService } from "../apps/control-plane/src/office/office-service.ts";
import { MissionService } from "../apps/control-plane/src/missions/mission-service.ts";
import { PlanService } from "../apps/control-plane/src/missions/plan-service.ts";
import { MissionCoordinator } from "../apps/control-plane/src/missions/coordinator.ts";
import { MissionCommandDispatcher } from "../apps/control-plane/src/missions/command-dispatcher.ts";
import { TaskService } from "../apps/control-plane/src/tasks/task-service.ts";
import { WorkerService } from "../apps/control-plane/src/workers/worker-service.ts";
import { ResourceScheduler } from "../apps/control-plane/src/scheduler/scheduler.ts";
import type { WorkerCoordinator } from "../apps/control-plane/src/workers/worker-channel.ts";

function setup() {
  const db = new ControlPlaneDatabase(":memory:");
  const events = new EventHub();
  const settings = new SettingsService(db);
  settings.patch({ office_enabled: true });
  const office = new OfficeService(db, events, settings);
  const missions = new MissionService(db, events, settings);
  const plans = new PlanService(db, events, missions);
  const tasks = new TaskService(db, events, { callbackEnabled: false });
  const workers = new WorkerService(db, events);
  const registration = workers.register({ name: "Mission Worker", registrationSecret: "mission-worker-secret-123", platform: "test", hardware: {} }, 1_700_000_000_000);
  const approved = workers.approveRegistration(registration.registrationId, "owner", 1_700_000_000_001);
  workers.pollRegistration(registration.registrationId, "mission-worker-secret-123", 1_700_000_000_002);
  const workerId = String(approved.workerId);
  workers.markConnected(workerId, 1_700_000_000_003);
  workers.setProtocolFeatures(workerId, ["resolved_execution_v1", "task_run_v1", "mission_execution_v1", "stop_evidence_v1", "workspace_exclusion_v1"]);
  workers.updateCapabilities(workerId, [{ capability: "generic", status: "READY" }], 1_700_000_000_003);
  const offers: Array<{ taskId: string; attemptId: string }> = [];
  const workerTransport = { isConnected: () => true, offer: (_workerId: string, task: Record<string, unknown>, attemptId: string) => { offers.push({ taskId: String(task.id), attemptId }); return true; } } as unknown as WorkerCoordinator;
  const scheduler = new ResourceScheduler(db, tasks, workers, workerTransport, events);
  const commandDispatcher = new MissionCommandDispatcher(db, "");
  const coordinator = new MissionCoordinator(db, events, tasks, missions, plans, commandDispatcher);
  return { db, office, missions, plans, tasks, workers, workerId, scheduler, coordinator, offers };
}

test("Mission Coordinator materializes a Worker execution and applies finalization exactly once", () => {
  const fixture = setup();
  const now = 1_700_000_000_000;
  try {
    const role = fixture.office.createRole({ name: "執行角色", responsibilities: "執行已定義的工作。", contract: { capabilities: ["generic"] } }, now);
    const worker = fixture.office.createMember("office-1", { roleId: String(role.id), roleVersion: 1, displayName: "Worker", seatKey: "worker", binding: { kind: "WORKER_SELECTOR", worker_id: fixture.workerId, capabilities: ["generic"] }, maxConcurrency: 1 }, now + 1);
    const mission = fixture.missions.create({ officeId: "office-1", title: "Coordinator flow", goal: "完成一個可追蹤的 Worker step。", inputs: [{ kind: "TEXT", text: "input" }], scope: { workspaceIds: [], capabilities: ["generic"], externalEffects: [] } }, "coordinator-flow", now + 2);
    const inputId = String(fixture.db.one<{ id: string }>("SELECT id FROM mission_inputs WHERE mission_id = ?", mission.response.missionId)?.id);
    const planCommandId = String(fixture.db.one<{ id: string }>("SELECT id FROM mission_commands WHERE mission_run_id = ?", mission.response.missionRunId)?.id);
    fixture.plans.submitPlan(planCommandId, {
      schema_version: 1,
      expected_objective_revision: 1,
      base_plan_revision: null,
      steps: [{ key: "execute", kind: "WORKER_TASK", member_id: String(worker.id), required: true, depends_on: [], inputs: [{ name: "input", source: "MISSION_INPUT", input_id: inputId }], instruction: "Execute the bounded task.", task: { task_type: "generic", payload_template: "{}" }, acceptance: { mode: "STRUCTURED_RESULT", schema_id: "generic-result-v1" }, retry_safety: "REPLAY_SAFE", limits: { queue_timeout_seconds: 60, timeout_seconds: 60, max_attempts: 1 } }],
      finalization: { member_id: String(worker.id), artifact_refs: [] },
    }, now + 3);

    assert.equal(fixture.coordinator.tick(now + 4), 1);
    const task = fixture.tasks.list({ purpose: "MISSION" })[0] as Record<string, any>;
    assert.equal(task.ownerKind, "MISSION");
    assert.equal(task.missionExecutionId !== null, true);
    assert.equal(fixture.scheduler.tick(now + 5), 1);
    assert.equal(fixture.offers.length, 1);
    const attemptId = fixture.offers[0].attemptId;
    assert.equal(fixture.tasks.accept(String(task.id), attemptId, fixture.workerId, now + 6), true);
    assert.equal(fixture.tasks.started(String(task.id), attemptId, fixture.workerId, now + 7), true);
    assert.equal(fixture.tasks.result(String(task.id), attemptId, fixture.workerId, { ok: true }, {}, now + 8), "SUCCEEDED");

    fixture.coordinator.tick(now + 9);
    const finalize = fixture.db.one<{ id: string; kind: string }>("SELECT id, kind FROM mission_commands WHERE mission_run_id = ? AND kind = 'mission.finalize'", mission.response.missionRunId);
    assert.equal(finalize?.kind, "mission.finalize");
    const authorityEpoch = String(fixture.db.one<{ authority_epoch: string }>("SELECT authority_epoch FROM mission_runs WHERE id = ?", mission.response.missionRunId)?.authority_epoch);
    const applied = fixture.coordinator.applyCommandResult(String(finalize?.id), { authority_epoch: authorityEpoch, result: { final_manifest: { schema_version: 1, summary: "done" } } }, now + 10);
    assert.equal(applied.state, "COMPLETED");
    assert.equal(fixture.missions.get(String(mission.response.missionId))?.run && (fixture.missions.get(String(mission.response.missionId)) as any).run.phase, "COMPLETED");
    assert.deepEqual(fixture.missions.results(String(mission.response.missionId)).finalManifest, { schema_version: 1, summary: "done" });
    assert.deepEqual(fixture.coordinator.applyCommandResult(String(finalize?.id), { authority_epoch: authorityEpoch, result: { final_manifest: { schema_version: 1, summary: "done" } } }, now + 11), { commandId: finalize?.id, state: "APPLIED", applicationState: "APPLIED", replayed: true });
  } finally {
    fixture.coordinator.close();
    fixture.db.close();
  }
});

test("Hermes command dispatch without a configured adapter enters attention instead of pretending to wake Hermes", async () => {
  const fixture = setup();
  try {
    const role = fixture.office.createRole({ name: "主管", responsibilities: "提交規劃。", contract: {} });
    const manager = fixture.office.createMember("office-1", { roleId: String(role.id), roleVersion: 1, displayName: "Hermes", seatKey: "manager", binding: { kind: "HERMES_PROFILE", profile_id: "manager" }, maxConcurrency: 1 });
    const mission = fixture.missions.create({ officeId: "office-1", title: "Hermes wake", goal: "等待規劃。", inputs: [], scope: { workspaceIds: [], capabilities: [], externalEffects: [] } }, "hermes-wake");
    const commandId = String(mission.response.planCommandId);
    assert.equal((await fixture.coordinator.dispatchOnce()).valueOf() >= 1, true);
    assert.equal(fixture.db.one<{ transport_state: string }>("SELECT transport_state FROM mission_commands WHERE id = ?", commandId)?.transport_state, "ATTENTION");
    assert.equal(fixture.office.member(String(manager.id))?.displayName, "Hermes");
  } finally {
    fixture.coordinator.close();
    fixture.db.close();
  }
});

test("Recovery mode fences new Hermes admissions and pauses command transport", async () => {
  const fixture = setup();
  try {
    const role = fixture.office.createRole({ name: "主管", responsibilities: "提交規劃。", contract: {} });
    fixture.office.createMember("office-1", { roleId: String(role.id), roleVersion: 1, displayName: "Hermes", seatKey: "manager", binding: { kind: "HERMES_PROFILE", profile_id: "manager" }, maxConcurrency: 1 });
    const mission = fixture.missions.create({ officeId: "office-1", title: "Recovery fence", goal: "驗證 recovery fence。", inputs: [], scope: { workspaceIds: [], capabilities: [], externalEffects: [] } }, "recovery-fence");
    const commandId = String(mission.response.planCommandId);
    fixture.coordinator.enterRecovery();
    assert.equal(await fixture.coordinator.dispatchOnce(), 0);
    assert.equal(fixture.db.one<{ transport_state: string }>("SELECT transport_state FROM mission_commands WHERE id = ?", commandId)?.transport_state, "PENDING");
    assert.throws(() => fixture.coordinator.admitCommand(commandId, {}), /RECOVERY_MODE/);
    assert.equal(fixture.coordinator.leaveRecovery().recoveryMode, false);
  } finally {
    fixture.coordinator.close();
    fixture.db.close();
  }
});
