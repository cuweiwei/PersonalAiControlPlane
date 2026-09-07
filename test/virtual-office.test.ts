import assert from "node:assert/strict";
import test from "node:test";
import { ControlPlaneDatabase } from "../apps/control-plane/src/db/database.ts";
import { EventHub } from "../apps/control-plane/src/events/event-hub.ts";
import { SettingsService } from "../apps/control-plane/src/settings/settings-service.ts";
import { OfficeService } from "../apps/control-plane/src/office/office-service.ts";
import { MissionService } from "../apps/control-plane/src/missions/mission-service.ts";
import { PlanService, PlanValidationError } from "../apps/control-plane/src/missions/plan-service.ts";

function plan(inputId: string, members: { manager: string; writer: string; reviewer: string }) {
  return {
    schema_version: 1,
    expected_objective_revision: 1,
    base_plan_revision: null,
    steps: [
      { key: "draft", kind: "WORKER_TASK", member_id: members.writer, required: true, depends_on: [], inputs: [{ name: "brief", source: "MISSION_INPUT", input_id: inputId }], instruction: "Produce a draft.", task: { task_type: "llm.inference", payload_template: "report-draft-v1" }, output_contract: { schema_id: "report-draft-v1", required_artifact_names: ["report.md"] }, acceptance: { mode: "HERMES_REVIEW", reviewer_step_key: "review" }, review_targets: ["draft"], retry_safety: "REPLAY_SAFE", limits: { queue_timeout_seconds: 3600, timeout_seconds: 900, max_attempts: 2 } },
      { key: "review", kind: "HERMES_ACTION", member_id: members.reviewer, required: true, depends_on: [{ step_key: "draft", condition: "OUTPUT_AVAILABLE" }], inputs: [{ name: "draft", source: "STEP_OUTPUT", step_key: "draft", artifact_name: "report.md" }], action: "REVIEW", acceptance: { mode: "STRUCTURED_RESULT", schema_id: "review-result-v1" }, retry_safety: "REPLAY_SAFE", limits: { queue_timeout_seconds: 3600, timeout_seconds: 900, max_attempts: 2 } },
    ],
    finalization: { member_id: members.manager, artifact_refs: [{ step_key: "draft", artifact_name: "report.md" }] },
  };
}

test("Virtual Office persists an idempotent Mission and atomically commits a validated Plan", () => {
  const db = new ControlPlaneDatabase(":memory:");
  const events = new EventHub();
  const settings = new SettingsService(db);
  const office = new OfficeService(db, events, settings);
  const missions = new MissionService(db, events, settings);
  const plans = new PlanService(db, events, missions);
  try {
    assert.deepEqual(db.all<{ version: number }>("SELECT version FROM schema_migrations WHERE version >= 7 ORDER BY version").map((row) => row.version), [7, 8, 9, 10]);
    assert.equal(office.list().length, 1);
    assert.equal((office.get("office-1") as any).members.length, 0);
    assert.throws(() => missions.create({ officeId: "office-1", title: "Disabled", goal: "No", inputs: [], scope: { workspaceIds: [], capabilities: [], externalEffects: [] } }, "disabled-key"), /OFFICE_DISABLED/);
    settings.patch({ office_enabled: true });
    const role = office.createRole({ name: "工程師", responsibilities: "執行明確的工程工作。", contract: { capabilities: ["llm.inference"] } });
    const manager = office.createMember("office-1", { roleId: role.id as string, roleVersion: 1, displayName: "小工", seatKey: "manager", binding: { kind: "HERMES_PROFILE", profile_id: "manager" }, maxConcurrency: 1 });
    const writer = office.createMember("office-1", { roleId: role.id as string, roleVersion: 1, displayName: "小文", seatKey: "writer", binding: { kind: "WORKER_SELECTOR", capabilities: ["llm.inference"] }, maxConcurrency: 1 });
    const reviewer = office.createMember("office-1", { roleId: role.id as string, roleVersion: 1, displayName: "小審", seatKey: "reviewer", binding: { kind: "HERMES_PROFILE", profile_id: "reviewer" }, maxConcurrency: 1 });
    const input = { office_id: "office-1", title: "研究報告", goal: "完成附來源的報告。", inputs: [{ kind: "TEXT", text: "比較兩種方案。" }], scope: { workspace_ids: [], capabilities: ["llm.inference"], external_effects: [] } };
    const first = missions.create({ officeId: "office-1", title: input.title, goal: input.goal, inputs: [{ kind: "TEXT", text: "比較兩種方案。" }], scope: { workspaceIds: [], capabilities: ["llm.inference"], externalEffects: [] } }, "mission-key", 1_700_000_000_000);
    const second = missions.create({ officeId: "office-1", title: input.title, goal: input.goal, inputs: [{ kind: "TEXT", text: "比較兩種方案。" }], scope: { workspaceIds: [], capabilities: ["llm.inference"], externalEffects: [] } }, "mission-key", 1_700_000_000_100);
    assert.equal(second.replayed, true);
    assert.equal(second.response.missionId, first.response.missionId);
    assert.throws(() => missions.create({ officeId: "office-1", title: "不同內容", goal: input.goal, inputs: [], scope: { workspaceIds: [], capabilities: [], externalEffects: [] } }, "mission-key"), /IDEMPOTENCY_CONFLICT/);
    const missionId = String(first.response.missionId); const runId = String(first.response.missionRunId); const inputId = String(db.one<{ id: string }>("SELECT id FROM mission_inputs WHERE mission_id = ?", missionId)!.id); const commandId = String(db.one<{ id: string }>("SELECT id FROM mission_commands WHERE mission_run_id = ?", runId)!.id);
    const committed = plans.submitPlan(commandId, plan(inputId, { manager: String(manager.id), writer: String(writer.id), reviewer: String(reviewer.id) }), 1_700_000_000_010);
    assert.equal(committed.processingState, "APPLIED");
    assert.equal(committed.planRevision, 1);
    const detail = missions.get(missionId)!;
    assert.equal((detail.run as any).phase, "EXECUTING");
    assert.deepEqual((detail.steps as any[]).map((step) => step.state), ["READY", "PENDING"]);
    assert.equal((detail.events as any[]).some((event) => event.type === "plan.committed"), true);
    assert.equal(plans.submitPlan(commandId, plan(inputId, { manager: String(manager.id), writer: String(writer.id), reviewer: String(reviewer.id) }), 1_700_000_000_011).replayed, true);
  } finally { db.close(); }
});

test("Virtual Office rejects cyclic plans with structured validation issues", () => {
  const db = new ControlPlaneDatabase(":memory:"); const events = new EventHub(); const settings = new SettingsService(db); settings.patch({ office_enabled: true }); const office = new OfficeService(db, events, settings); const missions = new MissionService(db, events, settings); const plans = new PlanService(db, events, missions);
  try {
    const role = office.createRole({ name: "測試角色", responsibilities: "測試", contract: {} });
    const member = office.createMember("office-1", { roleId: role.id as string, roleVersion: 1, displayName: "測試", seatKey: "test", binding: {}, maxConcurrency: 1 });
    const created = missions.create({ officeId: "office-1", title: "循環", goal: "拒絕循環", inputs: [], scope: { workspaceIds: [], capabilities: [], externalEffects: [] } }, "cycle-key");
    const commandId = String(db.one<{ id: string }>("SELECT id FROM mission_commands WHERE mission_run_id = ?", created.response.missionRunId)!.id);
    const invalid = plan("missing", { manager: String(member.id), writer: String(member.id), reviewer: String(member.id) }); invalid.steps[0].depends_on = [{ step_key: "review", condition: "ACCEPTED" }]; invalid.steps[1].depends_on = [{ step_key: "draft", condition: "OUTPUT_AVAILABLE" }];
    assert.throws(() => plans.submitPlan(commandId, invalid), (error: unknown) => error instanceof PlanValidationError && error.details.some((issue) => issue.code === "CYCLE"));
    assert.equal(db.one<{ count: number }>("SELECT COUNT(*) AS count FROM mission_plans")!.count, 0);
  } finally { db.close(); }
});
