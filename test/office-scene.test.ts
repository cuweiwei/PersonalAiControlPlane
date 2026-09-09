import assert from "node:assert/strict";
import test from "node:test";
import { ControlPlaneDatabase } from "../apps/control-plane/src/db/database.ts";
import { EventHub } from "../apps/control-plane/src/events/event-hub.ts";
import { SettingsService } from "../apps/control-plane/src/settings/settings-service.ts";
import { OfficeService } from "../apps/control-plane/src/office/office-service.ts";
import { projectOfficeScene } from "../apps/control-plane/src/office/scene-projection.ts";
import { MissionService } from "../apps/control-plane/src/missions/mission-service.ts";
import { PlanService } from "../apps/control-plane/src/missions/plan-service.ts";
import { MissionCoordinator } from "../apps/control-plane/src/missions/coordinator.ts";
import { MissionCommandDispatcher } from "../apps/control-plane/src/missions/command-dispatcher.ts";
import { TaskService } from "../apps/control-plane/src/tasks/task-service.ts";
import { WorkerService } from "../apps/control-plane/src/workers/worker-service.ts";

function setup() {
  const now = 1_700_000_000_000, db = new ControlPlaneDatabase(":memory:"), events = new EventHub();
  const settings = new SettingsService(db); settings.patch({ office_enabled: true, office_max_active_missions: 20 });
  const office = new OfficeService(db, events, settings), missions = new MissionService(db, events, settings), plans = new PlanService(db, events, missions), tasks = new TaskService(db, events, { callbackEnabled: false }), workers = new WorkerService(db, events);
  const coordinator = new MissionCoordinator(db, events, tasks, missions, plans, new MissionCommandDispatcher(db, ""));
  const registration = workers.register({ name: "測試 Worker", registrationSecret: "scene-test-secret-123", platform: "test", hardware: {} }, now);
  const approved = workers.approveRegistration(registration.registrationId, "owner", now + 1); workers.pollRegistration(registration.registrationId, "scene-test-secret-123", now + 2);
  const workerId = String(approved.workerId); workers.markConnected(workerId, now + 3); workers.updateCapabilities(workerId, [{ capability: "generic", runtime: "test", status: "READY" }], now + 3);
  const role = office.createRole({ name: "工程師", responsibilities: "執行任務", contract: { capabilities: ["generic"] } }, now);
  const member = office.createMember("office-1", { roleId: String(role.id), roleVersion: 1, displayName: "阿程", seatKey: "engineer", binding: { kind: "WORKER_SELECTOR", worker_id: workerId, runtime: "test", capabilities: ["generic"] }, maxConcurrency: 1 }, now + 1);
  const scene = (at = now + 100, configured = true) => projectOfficeScene(db, "office-1", [member], true, configured, at);
  const create = (key = "scene") => missions.create({ officeId: "office-1", title: key, goal: "完成可驗證工作", inputs: [], scope: { workspaceIds: [], capabilities: ["generic"], externalEffects: [] } }, key, now + 5);
  const execute = () => {
    const mission = create();
    plans.submitPlan(String(mission.response.planCommandId), { schema_version: 1, expected_objective_revision: 1, base_plan_revision: null, steps: [{ key: "execute", kind: "WORKER_TASK", member_id: String(member.id), required: true, depends_on: [], inputs: [], instruction: "Run task", task: { task_type: "generic", payload_template: "{}" }, acceptance: { mode: "STRUCTURED_RESULT", schema_id: "generic-v1" }, retry_safety: "REPLAY_SAFE", limits: { queue_timeout_seconds: 60, timeout_seconds: 60, max_attempts: 1 } }], finalization: { member_id: String(member.id), artifact_refs: [] } }, now + 6);
    coordinator.tick(now + 7);
    const task = tasks.list({ purpose: "MISSION" })[0] as Record<string, any>;
    const assigned = tasks.assign(String(task.id), workerId, now + 8, { workerId, runtime: "test", model: { name: "Exact model" } })!;
    return { mission, taskId: String(task.id), attemptId: assigned.attemptId };
  };
  const close = () => { coordinator.close(); db.close(); };
  return { now, db, workers, workerId, member, scene, create, execute, tasks, coordinator, close };
}

test("Office scene never treats assignment or acceptance as started execution", () => {
  const f = setup(); try {
    assert.equal(f.scene().members[0].activity.state, "IDLE");
    const work = f.execute(); f.coordinator.tick(f.now + 9); // Coordinator can project ASSIGNED as RUNNING; scene must inspect the attempt.
    assert.equal(f.scene().members[0].activity.state, "WAITING");
    f.tasks.accept(work.taskId, work.attemptId, f.workerId, f.now + 10);
    assert.equal(f.scene().members[0].activity.state, "WAITING");
    f.tasks.started(work.taskId, work.attemptId, f.workerId, f.now + 11);
    const active = f.scene().members[0].activity;
    assert.equal(active.state, "WORKING"); assert.equal(active.activeCount, 1); assert.equal(active.taskId, work.taskId); assert.equal(active.model, "Exact model");
    assert.equal(f.scene(f.now + 91_000).members[0].activity.state, "UNKNOWN");
    f.tasks.result(work.taskId, work.attemptId, f.workerId, { ok: true }, {}, f.now + 12);
    assert.equal(f.scene().members[0].activity.state, "WAITING");
    f.coordinator.tick(f.now + 13);
    assert.equal(f.scene().members[0].activity.state, "IDLE");
    assert.equal(f.scene().board.results, 0, "Worker success is not a final Mission result");
  } finally { f.close(); }
});

test("Office availability respects heartbeat, paused intake, drain and capability evidence", () => {
  const f = setup(); try {
    assert.equal(f.scene(f.now + 100_000).members[0].activity.state, "OFFLINE");
    f.db.run("UPDATE workers SET drain = 1 WHERE id = ?", f.workerId); assert.equal(f.scene().members[0].activity.state, "WAITING");
    f.db.run("UPDATE workers SET drain = 0 WHERE id = ?", f.workerId);
    f.workers.updatePreferences(f.workerId, { pause: { kind: "INDEFINITE" } }, undefined, f.now + 20); assert.equal(f.scene().members[0].activity.state, "WAITING");
    f.workers.updatePreferences(f.workerId, { pause: { kind: "NONE" } }, undefined, f.now + 21); assert.equal(f.scene().members[0].activity.state, "IDLE");
    f.db.run("UPDATE worker_capabilities SET grant_status = 'REVOKED' WHERE worker_id = ?", f.workerId); assert.equal(f.scene().members[0].activity.state, "WAITING");
  } finally { f.close(); }
});

test("Office scene shows online Workers that are not assigned to a logical role", () => {
  const f = setup(); try {
    const registration = f.workers.register({ name: "第二台 Worker", registrationSecret: "scene-test-second-worker-123", platform: "test", hardware: {} }, f.now + 20);
    const approved = f.workers.approveRegistration(registration.registrationId, "owner", f.now + 21);
    f.workers.pollRegistration(registration.registrationId, "scene-test-second-worker-123", f.now + 22);
    const secondWorkerId = String(approved.workerId);
    f.workers.markConnected(secondWorkerId, f.now + 23);
    f.workers.updateCapabilities(secondWorkerId, [{ capability: "generic", runtime: "test", status: "READY" }], f.now + 23);
    const scene = f.scene(f.now + 24);
    assert.deepEqual(scene.workerSummary, { total: 2, online: 2 });
    assert.equal(scene.members.filter((member) => member.kind === "ROLE").length, 1);
    assert.deepEqual(scene.members.filter((member) => member.kind === "WORKER").map((member) => ({ id: member.binding.worker_id, name: member.displayName, state: member.activity.state })), [{ id: secondWorkerId, name: "第二台 Worker", state: "IDLE" }]);
  } finally { f.close(); }
});

test("Office scene recognizes legacy Worker bindings without a kind field", () => {
  const f = setup(); try {
    f.db.run("UPDATE office_members SET binding_json = ? WHERE id = ?", JSON.stringify({ worker_id: f.workerId, runtime: "test", capabilities: ["generic"] }), f.member.id);
    const member = f.scene().members.find((item) => item.kind === "ROLE");
    assert.equal(member?.activity.state, "IDLE");
    assert.equal(member?.activity.workerId, f.workerId);
    assert.notEqual(member?.activity.reason, "尚未綁定執行資源");
  } finally { f.close(); }
});

test("Hermes transport ACK never animates planning; current admitted progress is required", () => {
  const f = setup(); try {
    const created = f.create(); const commandId = String(created.response.planCommandId);
    assert.equal(f.scene().orchestrator.state, "WAITING");
    f.db.run("UPDATE mission_commands SET transport_state = 'ACCEPTED' WHERE id = ?", commandId);
    assert.equal(f.scene().orchestrator.state, "WAITING");
    const admitted = f.coordinator.admitCommand(commandId, { admission_key: "scene-admit" }, f.now + 10) as Record<string, any>;
    assert.equal(f.scene().orchestrator.state, "WAITING");
    f.db.run("UPDATE mission_commands SET processing_state = 'RUNNING' WHERE id = ?", commandId);
    f.db.run("UPDATE mission_command_attempts SET state = 'RUNNING', deadline_at = ? WHERE id = ?", f.now + 60_000, admitted.brainAttemptId);
    assert.equal(f.scene().orchestrator.state, "PLANNING");
    assert.equal(f.scene(f.now + 61_000).orchestrator.state, "UNKNOWN");
    f.db.run("UPDATE mission_commands SET transport_state = 'ATTENTION', processing_state = 'NOT_STARTED', current_brain_attempt_id = NULL WHERE id = ?", commandId);
    assert.equal(f.scene().orchestrator.state, "ERROR"); assert.equal(f.scene().board.attention, 1);
  } finally { f.close(); }
});

test("Recovery mode overrides busy and available avatars with unknown state", () => {
  const f = setup(); try {
    const work = f.execute(); f.tasks.accept(work.taskId, work.attemptId, f.workerId, f.now + 10); f.tasks.started(work.taskId, work.attemptId, f.workerId, f.now + 11);
    f.coordinator.enterRecovery(f.now + 20);
    assert.equal(f.scene().members[0].activity.state, "UNKNOWN"); assert.equal(f.scene().orchestrator.state, "UNKNOWN");
  } finally { f.close(); }
});

test("Board counts the full current-run population, excluding archived missions", () => {
  const f = setup(); try {
    for (let i = 0; i < 18; i++) f.create(`mission-${i}`);
    assert.equal(f.scene().board.todo, 18); assert.equal(f.scene().missions.length, 18);
    f.db.run("UPDATE missions SET archived_at = ? WHERE title = 'mission-0'", f.now);
    assert.equal(f.scene().board.todo, 17); assert.equal(f.scene().recentEvents.some((e) => e.title === "mission-0"), false);
    f.db.run("UPDATE mission_runs SET phase = 'FAILED' WHERE mission_id = (SELECT id FROM missions WHERE title = 'mission-1')");
    assert.equal(f.scene().board.attention, 1); assert.equal(f.scene().board.todo, 16);
  } finally { f.close(); }
});

test("Completed results and external delivery receipts remain separate evidence", () => {
  const f = setup(); try {
    const work = f.execute(); f.tasks.accept(work.taskId, work.attemptId, f.workerId, f.now + 10); f.tasks.started(work.taskId, work.attemptId, f.workerId, f.now + 11); f.tasks.result(work.taskId, work.attemptId, f.workerId, { ok: true }, {}, f.now + 12); f.coordinator.tick(f.now + 13);
    f.db.run("UPDATE missions SET delivery_target_json = ? WHERE id = ?", JSON.stringify({ mode: "HERMES_CHANNEL", targetRef: { channel: "test" } }), work.mission.response.missionId);
    const final = f.db.one<Record<string, any>>("SELECT c.id, r.authority_epoch FROM mission_commands c JOIN mission_runs r ON r.id = c.mission_run_id WHERE c.kind = 'mission.finalize'")!;
    f.coordinator.applyCommandResult(final.id, { authority_epoch: final.authority_epoch, result: { final_manifest: { summary: "done" } } }, f.now + 14);
    assert.equal(f.scene().board.results, 1); assert.equal(f.scene().board.completed, 1); assert.equal(f.scene().orchestrator.state, "WAITING");
    f.db.run("UPDATE mission_commands SET transport_state = 'IN_FLIGHT' WHERE kind = 'mission.deliver'");
    assert.equal(f.scene().orchestrator.state, "DELIVERING");
    f.db.run("UPDATE mission_commands SET transport_state = 'ACCEPTED' WHERE kind = 'mission.deliver'");
    assert.equal(f.scene().orchestrator.state, "WAITING", "transport ACK is not successful external delivery");
    f.db.run("UPDATE mission_deliveries SET state = 'UNCERTAIN'"); assert.equal(f.scene().board.attention, 1); assert.equal(f.scene().orchestrator.state, "ERROR");
    f.db.run("UPDATE mission_deliveries SET state = 'DELIVERED'"); assert.equal(f.scene().board.completed, 1); assert.equal(f.scene().orchestrator.state, "WAITING");
  } finally { f.close(); }
});
