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

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "pai-agent-work-"));
  const db = new ControlPlaneDatabase(":memory:"); const events = new EventHub(); const settings = new SettingsService(db); const artifacts = new ArtifactStorage(directory); const missions = new MissionService(db, events, settings);
  settings.patch({ office_enabled: true, agent_work_skills_enabled: true, agent_work_routines_enabled: true, agent_work_goals_enabled: true, agent_work_attention_enabled: true });
  const service = new AgentWorkService({ db, events, settings, artifacts, missions });
  const close = async () => { db.close(); await rm(directory, { recursive: true, force: true }); };
  return { db, events, settings, service, artifacts, missions, close };
}

test("agent work skills persist immutable versions, pins and static validation evidence", async () => {
  const { db, service, artifacts, close } = await fixture();
  try {
    const stored = artifacts.write("skill-source", "skill.json", "application/json", Buffer.from('{"schema_version":1,"steps":[{"kind":"read"}]}'));
    db.run("INSERT INTO artifacts(id, filename, media_type, size_bytes, sha256, storage_path, created_at, storage_state) VALUES (?, ?, ?, ?, ?, ?, ?, 'AVAILABLE')", stored.id, stored.filename, stored.mediaType, stored.sizeBytes, stored.sha256, stored.storagePath, Date.now());
    const request = { office_id: "office-1", name: "固定摘要", bundle_artifact_id: stored.id, content_hash: stored.sha256, spec: { schema_version: 1, steps: [{ kind: "read" }] } };
    const created = service.createSkillDraft(request, "owner", "skill-create"); const replay = service.createSkillDraft(request, "owner", "skill-create");
    assert.equal(replay.skill_id, created.skill_id); assert.equal((service.getSkill(created.skill_id as string) as any)?.versions[0].lifecycle, "CANDIDATE");
    const validated = service.validateSkill(created.skill_id as string, 1, { mode: "VALIDATE_ONLY" }, "owner", "skill-validate");
    assert.equal(validated.validation_state, "PASSED"); assert.equal(db.one("SELECT COUNT(*) AS count FROM agent_artifact_refs WHERE owner_kind = 'SKILL_VERSION'")?.count, 1);
    assert.throws(() => service.activateSkill(created.skill_id as string, { version: 1, expected_revision: 1, expected_state_revision: 3 }, "owner", "skill-activate"), /VALIDATION_INCOMPLETE/);
  } finally { await close(); }
});

test("goals reserve a shared budget and attention remains separate from read state", async () => {
  const { db, service, close } = await fixture();
  try {
    const goal = service.createGoal({ office_id: "office-1", title: "可靠性", objective: { description: "完成改善" }, limits: { dimensions: { turns: 10 } }, milestones: [{ title: "基線", criteria: { id: "baseline" } }] }, "owner", "goal-create");
    const reserved = service.reserveBudget(goal.goal_id as string, { period_key: "lifetime", dimension: "turns", amount: 7 }, "owner", "budget-1");
    assert.equal(reserved.state, "RESERVED");
    assert.throws(() => service.reserveBudget(goal.goal_id as string, { period_key: "lifetime", dimension: "turns", amount: 4 }, "owner", "budget-2"), /BUDGET_EXHAUSTED/);
    const first = service.upsertAttention({ subject_kind: "GOAL", subject_id: goal.goal_id, reason_code: "MILESTONE_WAITING", fingerprint: "same", evidence: { milestone: "baseline" } });
    const same = service.upsertAttention({ subject_kind: "GOAL", subject_id: goal.goal_id, reason_code: "MILESTONE_WAITING", fingerprint: "same", evidence: { milestone: "baseline" } });
    assert.equal(same.id, first.id); assert.equal(service.listAttention().length, 1);
    const read = service.attentionCommand(first.id as string, { kind: "READ", expected_revision: 1 }, "owner", "attention-read");
    assert.equal(read.kind, "READ"); assert.equal(service.listAttention()[0].state, "OPEN"); assert.equal(Number(db.one("SELECT read_through_revision FROM attention_items WHERE id = ?", first.id)?.read_through_revision), 1);
  } finally { await close(); }
});

test("routine occurrence is blocked until Hermes returns an effective receipt", async () => {
  const { db, service, artifacts, close } = await fixture();
  try {
    const stored = artifacts.write("ready-skill", "skill.json", "application/json", Buffer.from("{}"));
    db.run("INSERT INTO artifacts(id, filename, media_type, size_bytes, sha256, storage_path, created_at, storage_state) VALUES (?, ?, ?, ?, ?, ?, ?, 'AVAILABLE')", stored.id, stored.filename, stored.mediaType, stored.sizeBytes, stored.sha256, stored.storagePath, Date.now());
    db.run("INSERT INTO work_skills(id, office_id, name, active_version, next_version, created_at, updated_at) VALUES ('skill-1', 'office-1', '現成技能', 1, 2, ?, ?)", Date.now(), Date.now());
    db.run("INSERT INTO work_skill_versions(skill_id, version, artifact_id, content_hash, spec_json, validation_state, compatibility_state, lifecycle, created_at) VALUES ('skill-1', 1, ?, ?, '{}', 'PASSED', 'COMPATIBLE', 'READY', ?)", stored.id, stored.sha256, Date.now());
    const routine = service.createRoutine({ office_id: "office-1", skill_id: "skill-1", skill_version: 1, trigger_intent: { kind: "time", timezone: "Asia/Taipei" } }, "owner", "routine-create");
    assert.equal(routine.sync_state, "PENDING"); assert.equal(routine.admission_blocked, true);
    assert.throws(() => service.receiveOccurrence({ binding_id: routine.binding_id, source_occurrence_key: "occ-1", binding_revision: 1, native_revision: 1, payload: {}, mission: { title: "例行", goal: "檢查", scope: {} } }, "hermes"), /BINDING_REVISION_STALE/);
    const effective = service.applyRoutineReceipt({ binding_id: routine.binding_id, binding_revision: 1, native_revision: 4, routine_id: "hermes-routine-1", remote_state: "ACTIVE", processing_state: "APPLIED" });
    assert.equal(effective.syncState, "EFFECTIVE"); assert.equal(effective.admissionBlocked, false);
    const occurrence = service.receiveOccurrence({ binding_id: routine.binding_id, source_occurrence_key: "occ-2", binding_revision: 1, native_revision: 4, payload: { scheduled: true }, mission: { title: "例行", goal: "檢查", scope: {} } }, "hermes");
    assert.equal(occurrence.state, "ADMITTED"); assert.ok(occurrence.mission_id); assert.equal(service.receiveOccurrence({ binding_id: routine.binding_id, source_occurrence_key: "occ-2", binding_revision: 1, native_revision: 4, payload: { scheduled: true }, mission: { title: "例行", goal: "檢查", scope: {} } }, "hermes").missionId, occurrence.mission_id);
  } finally { await close(); }
});

test("agent work HTTP projections expose capabilities and the read views", async () => {
  const { db, events, settings, service, artifacts, missions, close } = await fixture();
  const tasks = new TaskService(db, events, { callbackEnabled: false }); const workers = new WorkerService(db, events); const health = new HealthMonitor(db, events); health.seed(); const office = new OfficeService(db, events, settings);
  const workerCoordinator = { closeWorker: () => {}, handleUpgrade: () => {}, isConnected: () => true, offer: () => true } as unknown as WorkerCoordinator;
  const server = createControlPlaneServer({ db, tasks, workers, coordinator: workerCoordinator, artifacts, settings, health, events, office, missions, agentWork: service, assetRoot: artifacts.root });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const capabilities = await fetch(`${origin}/api/v2/agent-work/capabilities`).then((response) => response.json()) as any;
    assert.equal(capabilities.protocol, "agent_work_v1"); assert.equal(capabilities.skills.available, true); assert.equal(capabilities.memory.available, false);
    const skills = await fetch(`${origin}/api/v2/skills`).then((response) => response.json()) as any; const goals = await fetch(`${origin}/api/v2/goals`).then((response) => response.json()) as any;
    assert.deepEqual(skills.items, []); assert.deepEqual(goals.items, []);
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); await close(); }
});
