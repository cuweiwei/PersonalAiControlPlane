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

function setup() {
  const db = new ControlPlaneDatabase(":memory:");
  const events = new EventHub();
  const settings = new SettingsService(db);
  settings.patch({ office_enabled: true, hermes_brain_v2_enabled: true });
  const office = new OfficeService(db, events, settings);
  const missions = new MissionService(db, events, settings);
  const plans = new PlanService(db, events, missions);
  const tasks = new TaskService(db, events, { callbackEnabled: false });
  const coordinator = new MissionCoordinator(db, events, tasks, missions, plans, new MissionCommandDispatcher(db, ""));
  return { db, events, office, missions, coordinator };
}

test("Hermes brain v2 creates a source-fenced decision Mission", () => {
  const fixture = setup();
  try {
    const created = fixture.missions.create({
      officeId: "office-1", brainProtocolVersion: 2, sourceIntentKey: "telegram:update:1", conversationRef: "telegram:chat:1",
      title: "摘要", goal: "整理輸入", inputs: [{ kind: "TEXT", text: "hello" }],
      scope: { workspaceIds: [], capabilities: [], externalEffects: [] }, acceptance: [],
    }, "telegram-intent-1", 1_700_000_000_000);
    assert.equal(created.replayed, false);
    const command = fixture.db.one<{ kind: string; brain_protocol_version?: number }>("SELECT kind FROM mission_commands WHERE id = ?", created.response.planCommandId);
    assert.equal(command?.kind, "mission.decide");
    const context = fixture.coordinator.context(String(created.response.planCommandId))!;
    assert.equal(context.brainProtocolVersion, 2);
    assert.equal(context.conversationRef, "telegram:chat:1");
    const replay = fixture.missions.create({
      officeId: "office-1", brainProtocolVersion: 2, sourceIntentKey: "telegram:update:1", conversationRef: "telegram:chat:1",
      title: "摘要", goal: "整理輸入", inputs: [{ kind: "TEXT", text: "hello" }], scope: { workspaceIds: [], capabilities: [], externalEffects: [] }, acceptance: [],
    }, "different-key", 1_700_000_000_100);
    assert.equal(replay.replayed, true);
    assert.equal(replay.response.missionId, created.response.missionId);
    assert.throws(() => fixture.missions.create({
      officeId: "office-1", brainProtocolVersion: 2, sourceIntentKey: "telegram:update:1", conversationRef: "telegram:chat:1",
      title: "不同內容", goal: "整理輸入", inputs: [], scope: { workspaceIds: [], capabilities: [], externalEffects: [] }, acceptance: [],
    }, "different-content", 1_700_000_000_200), /IDEMPOTENCY_CONFLICT/);
  } finally { fixture.coordinator.close(); fixture.db.close(); }
});

test("Hermes brain v2 can complete a Mission without creating a Worker Task", () => {
  const fixture = setup();
  try {
    const created = fixture.missions.create({ officeId: "office-1", brainProtocolVersion: 2, sourceIntentKey: "telegram:update:2", conversationRef: "telegram:chat:1", title: "直接回覆", goal: "完成摘要", inputs: [], scope: { workspaceIds: [], capabilities: [], externalEffects: [] }, acceptance: [] }, "telegram-intent-2", 1_700_000_001_000);
    const commandId = String(created.response.planCommandId);
    const admission = fixture.coordinator.admitCommand(commandId, {} , 1_700_000_001_001);
    const decision = { brain_protocol_version: 2, command_id: commandId, brain_attempt_id: admission.brainAttemptId, authority_epoch: String(fixture.db.one<{ authority_epoch: string }>("SELECT authority_epoch FROM mission_runs WHERE id = ?", created.response.missionRunId)?.authority_epoch), expected_objective_revision: 1, expected_control_revision: 1, expected_context_revision: 1, decision_generation: 1, action: "COMPLETE", rationale_summary: "資料已足夠", payload: { final_manifest: { schema_version: 1, summary: "摘要完成", artifacts: [] }, acceptance_checks: [] } };
    const result = fixture.coordinator.applyCommandResult(commandId, { authority_epoch: decision.authority_epoch, brain_attempt_id: decision.brain_attempt_id, result: decision }, 1_700_000_001_002);
    assert.equal(result.state, "COMPLETED");
    assert.equal(fixture.db.one<{ count: number }>("SELECT COUNT(*) AS count FROM tasks WHERE purpose = 'MISSION'")?.count, 0);
    assert.equal((fixture.missions.get(String(created.response.missionId)) as any).run.brainState, "IDLE");
    assert.throws(() => fixture.coordinator.applyCommandResult(commandId, { authority_epoch: decision.authority_epoch, brain_attempt_id: decision.brain_attempt_id, result: { ...decision, payload: { final_manifest: { schema_version: 1, summary: "不同內容", artifacts: [] }, acceptance_checks: [] } } }, 1_700_000_001_003), /RESULT_CONFLICT/);
  } finally { fixture.coordinator.close(); fixture.db.close(); }
});

test("Hermes brain v2 keeps channel delivery as a separate receipt", () => {
  const fixture = setup();
  try {
    const created = fixture.missions.create({ officeId: "office-1", brainProtocolVersion: 2, sourceIntentKey: "telegram:update:delivery", conversationRef: "telegram:chat:delivery", title: "交付摘要", goal: "完成並回到原對話", inputs: [], scope: { workspaceIds: [], capabilities: [], externalEffects: [] }, acceptance: [], delivery: { mode: "HERMES_CHANNEL", targetRef: { conversation_ref: "telegram:chat:delivery" } } }, "telegram-intent-delivery", 1_700_000_001_500);
    const commandId = String(created.response.planCommandId);
    const admission = fixture.coordinator.admitCommand(commandId, {}, 1_700_000_001_501);
    const authorityEpoch = String(fixture.db.one<{ authority_epoch: string }>("SELECT authority_epoch FROM mission_runs WHERE id = ?", created.response.missionRunId)?.authority_epoch);
    const decision = { brain_protocol_version: 2, command_id: commandId, brain_attempt_id: admission.brainAttemptId, authority_epoch: authorityEpoch, expected_objective_revision: 1, expected_control_revision: 1, expected_context_revision: 1, decision_generation: 1, action: "COMPLETE", rationale_summary: "資料已足夠", payload: { final_manifest: { schema_version: 1, summary: "已完成", artifacts: [] }, acceptance_checks: [] } };
    fixture.coordinator.applyCommandResult(commandId, { authority_epoch: authorityEpoch, result: decision }, 1_700_000_001_502);
    const delivery = fixture.db.one<{ id: string; command_id: string; state: string }>("SELECT id, command_id, state FROM mission_deliveries WHERE mission_run_id = ?", created.response.missionRunId);
    assert.equal(delivery?.state, "PENDING");
    const receipt = fixture.coordinator.deliveryReceipt({ delivery_id: delivery?.id, delivery_key: fixture.db.one<{ delivery_key: string }>("SELECT delivery_key FROM mission_deliveries WHERE id = ?", delivery?.id)?.delivery_key, receipt_revision: 1, state: "FAILED", last_error: "CHANNEL_DELIVERY_NOT_CONFIGURED" }, 1_700_000_001_503);
    assert.equal(receipt.state, "FAILED");
    assert.equal(fixture.db.one<{ processing_state: string }>("SELECT processing_state FROM mission_commands WHERE id = ?", delivery?.command_id)?.processing_state, "APPLIED");
  } finally { fixture.coordinator.close(); fixture.db.close(); }
});

test("Hermes brain v2 fences a new decision after owner input changes context", () => {
  const fixture = setup();
  try {
    const created = fixture.missions.create({ officeId: "office-1", brainProtocolVersion: 2, sourceIntentKey: "telegram:update:3", conversationRef: "telegram:chat:1", title: "等待輸入", goal: "等待必要資料", inputs: [], scope: { workspaceIds: [], capabilities: [], externalEffects: [] }, acceptance: [] }, "telegram-intent-3", 1_700_000_002_000);
    const firstCommandId = String(created.response.planCommandId);
    const admission = fixture.coordinator.admitCommand(firstCommandId, {}, 1_700_000_002_001);
    const authorityEpoch = String(fixture.db.one<{ authority_epoch: string }>("SELECT authority_epoch FROM mission_runs WHERE id = ?", created.response.missionRunId)?.authority_epoch);
    fixture.coordinator.applyCommandResult(firstCommandId, { authority_epoch: authorityEpoch, result: {
      brain_protocol_version: 2, command_id: firstCommandId, brain_attempt_id: admission.brainAttemptId, authority_epoch: authorityEpoch,
      expected_objective_revision: 1, expected_control_revision: 1, expected_context_revision: 1, decision_generation: 1,
      action: "WAIT", rationale_summary: "等待 owner 補充", payload: { reason: "WAITING_OWNER" },
    } }, 1_700_000_002_002);
    const appended = fixture.missions.appendInput(String(created.response.missionId), { kind: "TEXT", text: "補充內容" }, "telegram-input-3", 1, 1_700_000_002_003);
    assert.equal(appended.objectiveRevision, 2);
    fixture.coordinator.tick(1_700_000_002_004);
    const commands = fixture.db.all<{ id: string; kind: string; decision_generation: number }>("SELECT c.id, c.kind, r.decision_generation FROM mission_commands c JOIN mission_runs r ON r.id = c.mission_run_id WHERE c.mission_run_id = ? ORDER BY c.rowid", created.response.missionRunId);
    assert.equal(commands.filter((item) => item.kind === "mission.decide").length, 2);
    assert.equal(commands.at(-1)?.decision_generation, 2);
    assert.equal((fixture.missions.get(String(created.response.missionId)) as any).run.contextRevision, 2);
  } finally { fixture.coordinator.close(); fixture.db.close(); }
});

test("Hermes brain v2 can replace a failed plan with a fenced replan", () => {
  const fixture = setup();
  try {
    const role = fixture.office.createRole({ name: "規劃角色", responsibilities: "執行測試計畫", contract: {} }, 1_700_000_003_000);
    const member = fixture.office.createMember("office-1", { roleId: String(role.id), roleVersion: 1, displayName: "規劃者", seatKey: "planner", binding: { kind: "HERMES_PROFILE", profile_id: "planner" }, maxConcurrency: 1 }, 1_700_000_003_001);
    const created = fixture.missions.create({ officeId: "office-1", brainProtocolVersion: 2, title: "重規劃", goal: "失敗後換方案", inputs: [], scope: { workspaceIds: [], capabilities: [], externalEffects: [] }, acceptance: [] }, "replan-intent", 1_700_000_003_010);
    const firstCommandId = String(created.response.planCommandId); const firstAdmission = fixture.coordinator.admitCommand(firstCommandId, {}, 1_700_000_003_011);
    const authorityEpoch = String(fixture.db.one<{ authority_epoch: string }>("SELECT authority_epoch FROM mission_runs WHERE id = ?", created.response.missionRunId)?.authority_epoch);
    const proposal = (basePlanRevision: number | null) => ({ schema_version: 1, expected_objective_revision: 1, base_plan_revision: basePlanRevision, steps: [{ key: "wait", kind: "WAIT_UNTIL", member_id: String(member.id), required: true, depends_on: [], inputs: [], due_at: "2030-01-01T00:00:00Z", acceptance: { mode: "STRUCTURED_RESULT", schema_id: "wait-v1" }, retry_safety: "REPLAY_SAFE", limits: { queue_timeout_seconds: 60, timeout_seconds: 60, max_attempts: 1 } }], finalization: { member_id: String(member.id), artifact_refs: [] } });
    const delegate = { brain_protocol_version: 2, command_id: firstCommandId, brain_attempt_id: firstAdmission.brainAttemptId, authority_epoch: authorityEpoch, expected_objective_revision: 1, expected_control_revision: 1, expected_context_revision: 1, decision_generation: 1, action: "DELEGATE", rationale_summary: "先執行方案", payload: { plan_fragment: proposal(null) } };
    fixture.coordinator.applyCommandResult(firstCommandId, { authority_epoch: authorityEpoch, result: delegate }, 1_700_000_003_012);
    const planId = String(fixture.db.one<{ id: string }>("SELECT id FROM mission_plans WHERE mission_run_id = ? AND revision = 1", created.response.missionRunId)?.id);
    fixture.db.run("UPDATE mission_steps SET state = 'FAILED', failure_json = ? WHERE plan_id = ?", JSON.stringify({ code: "TEST_FAILURE" }), planId);
    fixture.coordinator.tick(1_700_000_003_020);
    const secondCommandId = String(fixture.db.one<{ id: string }>("SELECT current_decision_command_id AS id FROM mission_runs WHERE id = ?", created.response.missionRunId)?.id);
    const secondAdmission = fixture.coordinator.admitCommand(secondCommandId, {}, 1_700_000_003_021);
    const replan = { ...delegate, command_id: secondCommandId, brain_attempt_id: secondAdmission.brainAttemptId, expected_context_revision: 1, decision_generation: 2, action: "REPLAN", payload: { plan_fragment: proposal(1) } };
    const result = fixture.coordinator.applyCommandResult(secondCommandId, { authority_epoch: authorityEpoch, result: replan }, 1_700_000_003_022);
    assert.equal(result.action, "REPLAN");
    assert.equal(result.planRevision, 2);
    assert.equal(fixture.db.one<{ status: string }>("SELECT status FROM mission_plans WHERE mission_run_id = ? AND revision = 1", created.response.missionRunId)?.status, "SUPERSEDED");
    assert.equal(fixture.db.one<{ status: string }>("SELECT status FROM mission_plans WHERE mission_run_id = ? AND revision = 2", created.response.missionRunId)?.status, "ACTIVE");
  } finally { fixture.coordinator.close(); fixture.db.close(); }
});
