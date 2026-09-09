import type { ControlPlaneDatabase } from "../db/database.ts";
import type { OfficeActivity, OfficeSceneData, OfficeSceneMember, OfficeSceneMission } from "../../../../packages/contracts/src/office-scene.ts";

type Row = Record<string, any>;
const parse = (value: unknown): Row => { try { return JSON.parse(String(value ?? "{}")); } catch { return {}; } };
const activity = (state: OfficeActivity["state"], reason: string): OfficeActivity => ({ state, reason, activeCount: 0 });
const priority: Record<OfficeActivity["state"], number> = { UNKNOWN: 9, ERROR: 8, WORKING: 7, PLANNING: 7, REVIEWING: 7, DELIVERING: 6, WAITING: 5, OFFLINE: 4, IDLE: 0 };

/** Only current runs / active plans / current attempts contribute to the scene. */
export function projectOfficeScene(db: ControlPlaneDatabase, officeId: string, members: Row[], enabled: boolean, hermesConfigured: boolean, now = Date.now()): OfficeSceneData {
  const recovery = db.one<Row>("SELECT value_json FROM runtime_metadata WHERE key = 'office_recovery_mode'")?.value_json === "true";
  const runs = db.all<Row>(`SELECT m.id, m.title, m.updated_at, r.id AS run_id, r.phase, r.control, r.wait_summary_json,
    EXISTS(SELECT 1 FROM mission_commands c WHERE c.mission_run_id = r.id AND c.kind = 'mission.finalize' AND c.processing_state = 'APPLIED' AND c.result_json IS NOT NULL) AS has_result,
    EXISTS(SELECT 1 FROM mission_commands c WHERE c.mission_run_id = r.id AND (c.transport_state = 'ATTENTION' OR c.processing_state IN ('FAILED', 'STALE'))) AS command_error,
    EXISTS(SELECT 1 FROM mission_deliveries d WHERE d.mission_run_id = r.id AND d.state IN ('FAILED', 'UNCERTAIN', 'ATTENTION')) AS delivery_error
    FROM missions m JOIN mission_runs r ON r.id = m.current_mission_run_id WHERE m.office_id = ? AND m.archived_at IS NULL ORDER BY m.updated_at DESC, m.id`, officeId);
  const missions: OfficeSceneMission[] = runs.map((r) => {
    const waitReason = parse(r.wait_summary_json).reason ?? null;
    const needsOwner = waitReason === "WAITING_OWNER" || r.command_error || r.delivery_error || r.phase === "FAILED" || ["PAUSED", "PAUSE_REQUESTED"].includes(r.control);
    const bucket = needsOwner ? "attention" : r.phase === "COMPLETED" ? "completed" : r.phase === "CANCELLED" ? "closed" : r.phase === "PLANNING" ? "todo" : "active";
    return { id: r.id, title: r.title, phase: r.phase, control: r.control, waitReason, bucket, hasResult: Boolean(r.has_result), updatedAt: new Date(r.updated_at).toISOString() };
  });
  const board = { todo: 0, active: 0, attention: 0, completed: 0, closed: 0, results: 0 };
  for (const m of missions) { board[m.bucket]++; if (m.hasResult) board.results++; }
  const workers = db.all<Row>(`SELECT id, name, status, enabled, drain, max_concurrency, last_heartbeat_at, last_connected_at,
    (SELECT COUNT(*) FROM task_attempts a WHERE a.worker_id = workers.id AND a.occupancy IN ('RESERVED', 'RELEASING', 'UNKNOWN')) AS occupied FROM workers WHERE removed_at IS NULL`);
  const capabilities = db.all<Row>("SELECT worker_id, capability, runtime, status FROM worker_capabilities WHERE superseded_at IS NULL AND grant_status NOT IN ('REVOKED', 'REQUIRES_REVIEW')");
  const models = db.all<Row>("SELECT worker_id, runtime, model_id, status, present FROM worker_models");
  const preferences = db.all<Row>("SELECT worker_id, mode, pause_id, pause_until, pause_indefinite FROM worker_preferences");
  const workerFresh = (w: Row) => w.status === "ONLINE" && Boolean(w.enabled) && now - Number(w.last_heartbeat_at ?? w.last_connected_at ?? 0) < Number(process.env.PAI_WORKER_OFFLINE_SECONDS ?? 90) * 1000;
  const defaultActivity = (binding: Row): OfficeActivity => {
    if (!enabled) return activity("WAITING", "辦公室尚未啟用");
    if (recovery) return activity("UNKNOWN", "復原對帳中，暫停新派工");
    if (binding.kind === "HERMES_PROFILE") return activity(hermesConfigured ? "WAITING" : "OFFLINE", hermesConfigured ? "等待 Hermes 接案；連線設定不代表正在執行" : "尚未設定 Hermes 連線");
    if (binding.kind !== "WORKER_SELECTOR") return activity("WAITING", "尚未綁定執行資源");
    const workerId = binding.worker_id ?? binding.workerId;
    const modelId = binding.model_id ?? binding.modelId;
    const runtime = binding.runtime === "auto" ? undefined : binding.runtime;
    const candidates = workers.filter((w) => !workerId || w.id === workerId);
    const online = candidates.filter(workerFresh);
    const available = online.find((w) => !w.drain && w.occupied < w.max_concurrency && !preferences.some((p) => p.worker_id === w.id && (p.mode !== "NORMAL" || p.pause_id && (p.pause_indefinite || p.pause_until > now))) &&
      capabilities.some((cap) => cap.worker_id === w.id && ["READY", "HEALTHY"].includes(cap.status) && (!runtime || cap.runtime === runtime)) &&
      (binding.capabilities ?? []).every((c: string) => capabilities.some((cap) => cap.worker_id === w.id && cap.capability === c && ["READY", "HEALTHY"].includes(cap.status) && (!runtime || cap.runtime === runtime))) &&
      (!modelId || models.some((m) => m.worker_id === w.id && m.model_id === modelId && m.present && m.status === "READY" && (!runtime || m.runtime === runtime))));
    const result = available ? activity("IDLE", "執行資源在線，等待派工；實際接案仍依排程器判定") : activity(online.length ? "WAITING" : candidates.length ? "OFFLINE" : "WAITING", online.length ? "等待符合模型、能力與接案條件的資源" : candidates.length ? "Worker 離線或心跳已過期" : "尚無符合綁定的 Worker");
    const worker = available ?? candidates.find((w) => w.id === workerId);
    return { ...result, workerId: worker?.id, workerName: worker?.name, runtime: binding.runtime, model: modelId };
  };
  const byMember = new Map<string, OfficeActivity[]>();
  const byWorker = new Map<string, OfficeActivity[]>();
  const steps = db.all<Row>(`SELECT s.*, m.id AS mission_id, m.title AS mission_title, r.control, e.state AS execution_state, e.task_id,
    t.status AS task_status, a.status AS attempt_status, a.worker_id, a.resolved_execution_json,
    c.processing_state, c.transport_state, c.last_error, ca.state AS brain_state, ca.deadline_at AS brain_deadline
    FROM missions m JOIN mission_runs r ON r.id = m.current_mission_run_id
    JOIN mission_plans p ON p.mission_run_id = r.id AND p.revision = r.active_plan_revision
    JOIN mission_steps s ON s.plan_id = p.id LEFT JOIN mission_step_executions e ON e.id = s.current_execution_id
    LEFT JOIN tasks t ON t.id = e.task_id AND t.current_run_id = e.task_run_id
    LEFT JOIN task_attempts a ON a.id = t.current_attempt_id
    LEFT JOIN mission_commands c ON c.id = e.command_id
    LEFT JOIN mission_command_attempts ca ON ca.id = c.current_brain_attempt_id
    WHERE m.office_id = ? AND m.archived_at IS NULL AND r.phase NOT IN ('COMPLETED', 'CANCELLED') AND s.state NOT IN ('SUCCEEDED', 'CANCELLED', 'SKIPPED')`, officeId);
  for (const s of steps) {
    const snapshot = parse(s.member_snapshot_json); const contract = parse(s.contract_json);
    let current = activity("WAITING", s.wait_reason ?? "等待派工或前置步驟");
    if (s.execution_state === "UNKNOWN" || s.attempt_status === "LOST" || s.brain_state === "UNKNOWN" || s.processing_state === "RUNNING" && (!s.brain_state || s.brain_deadline && s.brain_deadline < now)) current = activity("UNKNOWN", "執行狀態待對帳");
    else if (s.state === "FAILED" || s.task_status === "FAILED" || s.processing_state === "FAILED" || s.transport_state === "ATTENTION") current = activity("ERROR", s.last_error ?? "執行失敗，請查看任務");
    else if (s.attempt_status === "RUNNING" && s.task_status === "RUNNING") current = workerFresh(workers.find((w) => w.id === s.worker_id) ?? {}) ? activity("WORKING", "Worker 已回報開始執行") : activity("UNKNOWN", "執行中的 Worker 已失聯，等待對帳");
    else if (s.processing_state === "RUNNING") current = activity(contract.action === "REVIEW" ? "REVIEWING" : "WORKING", "Hermes 已回報執行進度");
    else if (s.task_status === "SUCCEEDED") current = activity("WAITING", "成果已產生，等待流程套用");
    if (s.control !== "ACTIVE" && current.state === "WAITING") current.reason = `流程控制：${s.control}`;
    if (recovery) current = activity("UNKNOWN", "復原對帳中，執行狀態待確認");
    const resolved = parse(s.resolved_execution_json); const binding = snapshot.binding ?? {};
    current = { ...current, missionId: s.mission_id, missionTitle: s.mission_title, taskId: s.task_id ?? undefined, stepKey: s.step_key, workerId: s.worker_id ?? binding.worker_id, workerName: workers.find((w) => w.id === s.worker_id)?.name, runtime: resolved.runtime ?? binding.runtime, model: resolved.model?.name ?? resolved.modelId ?? resolved.model_id ?? binding.model_id ?? binding.modelId, activeCount: ["WORKING", "REVIEWING"].includes(current.state) ? 1 : 0 };
    const list = byMember.get(snapshot.memberId) ?? []; list.push(current); byMember.set(snapshot.memberId, list);
    if (typeof s.worker_id === "string") { const workerList = byWorker.get(s.worker_id) ?? []; workerList.push(current); byWorker.set(s.worker_id, workerList); }
  }
  const commandActivities: OfficeActivity[] = [];
  const commands = db.all<Row>(`SELECT c.*, m.id AS mission_id, m.title AS mission_title, d.state AS delivery_state, ca.state AS brain_state, ca.deadline_at AS brain_deadline FROM mission_commands c
    JOIN mission_runs r ON r.id = c.mission_run_id JOIN missions m ON m.current_mission_run_id = r.id
    LEFT JOIN mission_deliveries d ON d.command_id = c.id
    LEFT JOIN mission_command_attempts ca ON ca.id = c.current_brain_attempt_id
    WHERE m.office_id = ? AND m.archived_at IS NULL AND c.kind IN ('plan.requested', 'mission.finalize', 'mission.deliver')
    AND c.processing_state NOT IN ('APPLIED', 'CANCELLED', 'STALE') AND (r.phase NOT IN ('COMPLETED', 'CANCELLED') OR c.kind = 'mission.deliver')
    AND (d.state IS NULL OR d.state <> 'DELIVERED')`, officeId);
  for (const c of commands) {
    let current = activity("WAITING", "等待 Hermes 實際領取並執行");
    if (c.brain_state === "UNKNOWN" || c.processing_state === "RUNNING" && (!c.brain_state || c.brain_deadline && c.brain_deadline < now)) current = activity("UNKNOWN", "Hermes 執行證據已過期，等待對帳");
    else if (c.processing_state === "FAILED" || c.transport_state === "ATTENTION" || ["FAILED", "ATTENTION", "UNCERTAIN"].includes(c.delivery_state)) current = activity("ERROR", c.last_error ?? "交付或協調需要處理");
    else if (c.kind === "mission.deliver" && (c.transport_state === "IN_FLIGHT" || c.processing_state === "RUNNING")) current = activity("DELIVERING", "正在傳送成果，尚未收到交付成功回執");
    else if (c.processing_state === "RUNNING") current = activity(c.kind === "mission.finalize" ? "REVIEWING" : "PLANNING", c.kind === "mission.finalize" ? "Hermes 正在審閱與彙整成果" : "Hermes 已回報規劃進度");
    if (recovery) current = activity("UNKNOWN", "復原對帳中，暫停新派工");
    commandActivities.push({ ...current, missionId: c.mission_id, missionTitle: c.mission_title, activeCount: ["PLANNING", "REVIEWING", "DELIVERING"].includes(current.state) ? 1 : 0 });
  }
  const choose = (list: OfficeActivity[], fallback: OfficeActivity) => list.length ? { ...list.sort((a, b) => priority[b.state] - priority[a.state])[0], activeCount: list.reduce((n, a) => n + a.activeCount, 0) } : fallback;
  const orchestrator = choose(commandActivities, defaultActivity({ kind: "HERMES_PROFILE" }));
  const sceneMembers = members.map((member) => {
    const work = byMember.get(member.id) ?? [];
    // A profile is a role, not an independent copy of the manager's command.
    const isManager = member.binding?.kind === "HERMES_PROFILE" && /^(manager|orchestrator|hermes)$/i.test(member.seatKey);
    return { ...member, kind: "ROLE", activity: choose(isManager ? [...work, ...commandActivities] : work, defaultActivity(member.binding ?? {})) } as OfficeSceneMember;
  });
  const boundWorkerIds = new Set(members.map((member) => member.binding?.worker_id ?? member.binding?.workerId).filter((id): id is string => typeof id === "string"));
  for (const worker of workers) {
    if (boundWorkerIds.has(worker.id)) continue;
    const binding = { kind: "WORKER_SELECTOR", worker_id: worker.id };
    sceneMembers.push({
      id: `worker:${worker.id}`,
      displayName: worker.name,
      seatKey: `worker-${worker.id}`,
      kind: "WORKER",
      role: { name: "Worker" },
      binding,
      maxConcurrency: Math.max(1, Number(worker.max_concurrency ?? 1)),
      activity: choose(byWorker.get(worker.id) ?? [], defaultActivity(binding)),
    });
  }
  const recentEvents = db.all<Row>(`SELECT e.event_id, e.type, e.mission_id, e.created_at, m.title FROM mission_events e JOIN missions m ON m.id = e.mission_id WHERE e.office_id = ? AND m.archived_at IS NULL ORDER BY e.seq DESC LIMIT 12`, officeId)
    .map((e) => ({ id: e.event_id, type: e.type, missionId: e.mission_id, title: e.title, at: new Date(e.created_at).toISOString() }));
  return { observedAt: new Date(now).toISOString(), members: sceneMembers, workerSummary: { total: workers.length, online: workers.filter(workerFresh).length }, orchestrator, board, missions, recentEvents };
}
