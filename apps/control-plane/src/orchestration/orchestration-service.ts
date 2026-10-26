import { ControlPlaneDatabase } from "../db/database.ts";
import { TaskService } from "../tasks/task-service.ts";
import { canonicalJson, parseOrchestrationWorkContract, parseTaskContractV2Input, sha256, uuidv7, type OrchestrationWorkContract, type TaskContractV2Input } from "../../../../packages/contracts/src/index.ts";

type Row = Record<string, any>;

function parseJson(value: unknown, fallback: unknown = {}): any {
  try { return value === null || value === undefined ? fallback : JSON.parse(String(value)); } catch { return fallback; }
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`ORCHESTRATION_TASK_INVALID:${field} must be an object`);
  return value as Record<string, unknown>;
}

function principalValue(value: string): string {
  const principal = value.trim();
  if (!principal || principal.length > 120) throw new Error("ORCHESTRATION_ACTOR_REQUIRED");
  return principal;
}

function idempotencyValue(value: string): string {
  if (!value || value.length > 200) throw new Error("MISSING_IDEMPOTENCY_KEY");
  return value;
}

export class OrchestrationService {
  private readonly db: ControlPlaneDatabase;
  private readonly tasks: TaskService;

  constructor(db: ControlPlaneDatabase, tasks: TaskService) {
    this.db = db;
    this.tasks = tasks;
  }

  createWork(input: unknown, principalInput: string, idempotencyKeyInput: string, now = Date.now()): Record<string, unknown> {
    const principal = principalValue(principalInput);
    const idempotencyKey = idempotencyValue(idempotencyKeyInput);
    let contract: OrchestrationWorkContract;
    try { contract = parseOrchestrationWorkContract(input); }
    catch (error) {
      if (error instanceof Error && error.message === "ORCHESTRATION_CONTRACT_VERSION_UNSUPPORTED") throw error;
      throw new Error(`ORCHESTRATION_CONTRACT_INVALID:${error instanceof Error ? error.message : "invalid contract"}`);
    }
    const requestHash = sha256(canonicalJson({ principal, contract }));
    const scope = `orchestration:${principal}:work-create`;

    return this.db.transaction(() => {
      const prior = this.db.one<Row>("SELECT request_hash, response_json FROM operation_receipts WHERE scope = ? AND operation_key = ?", scope, idempotencyKey);
      if (prior) {
        if (prior.request_hash !== requestHash) throw new Error("IDEMPOTENCY_CONFLICT");
        return { ...parseJson(prior.response_json, {}), deduplicated: true };
      }

      const workId = uuidv7(now);
      this.db.run("INSERT INTO orchestration_works(id, owner_kind, owner_principal, origin_ref, objective, repository_ref, project_ref, design_authority, implementation_owner, revision, status, review_state, contract_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'OPEN', 'PENDING', ?, ?, ?)", workId, contract.origin.kind, principal, contract.origin.origin_ref, contract.objective, contract.repository_ref ?? null, contract.project_ref ?? null, contract.design_authority, contract.implementation_owner, canonicalJson(contract), now, now);
      const response = { work_id: workId, revision: 1, status: "OPEN", review_state: "PENDING", deduplicated: false };
      this.db.run("INSERT INTO operation_receipts(scope, operation_key, request_hash, status_code, response_json, created_at) VALUES (?, ?, ?, 201, ?, ?)", scope, idempotencyKey, requestHash, JSON.stringify(response), now);
      this.appendWorkEvent(workId, 1, "WORK_CREATED", principal, { status: "OPEN" }, now);
      return response;
    });
  }

  getWork(workId: string, principalInput: string): Record<string, unknown> {
    const row = this.ownedWork(workId, principalValue(principalInput));
    const taskRows = this.db.all<Row>(`SELECT t.id, t.status, t.revision, t.title, c.condition, c.reason_code, wt.role, wt.created_at
      FROM orchestration_work_tasks wt JOIN tasks t ON t.id = wt.task_id
      LEFT JOIN task_execution_conditions c ON c.task_id = t.id
      WHERE wt.work_id = ? ORDER BY wt.created_at, t.id`, workId);
    const reviewHandoffs = this.db.all<Row>("SELECT id, task_id, pr_ref, ci_evidence_json, acceptance_json, review_state, created_at, updated_at FROM work_review_handoffs WHERE work_id = ? ORDER BY created_at, id", workId).map((handoff) => ({
      id: handoff.id,
      task_id: handoff.task_id ?? null,
      pr_ref: handoff.pr_ref ?? null,
      ci_evidence: parseJson(handoff.ci_evidence_json, null),
      acceptance: parseJson(handoff.acceptance_json, null),
      review_state: handoff.review_state,
      created_at: handoff.created_at,
      updated_at: handoff.updated_at,
    }));
    return {
      work_id: row.id,
      owner_kind: row.owner_kind,
      owner_principal: row.owner_principal,
      origin_ref: row.origin_ref,
      objective: row.objective,
      revision: Number(row.revision),
      status: row.status,
      review_state: row.review_state,
      contract: parseJson(row.contract_json, null),
      created_at: row.created_at,
      updated_at: row.updated_at,
      completed_at: row.completed_at ?? null,
      tasks: taskRows.map((task) => ({ id: task.id, role: task.role, title: task.title, state: task.status, revision: Number(task.revision), execution_condition: task.condition ?? null, reason_code: task.reason_code ?? null, created_at: task.created_at })),
      review_handoffs: reviewHandoffs,
    };
  }

  delegateTask(workId: string, taskInput: unknown, principalInput: string, expectedRevision: number, idempotencyKeyInput: string, now = Date.now()): Record<string, unknown> {
    const principal = principalValue(principalInput);
    const idempotencyKey = idempotencyValue(idempotencyKeyInput);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error("MISSING_IF_MATCH");
    const body = object(taskInput, "task");
    if (body.idempotency_key !== undefined && body.idempotency_key !== idempotencyKey) throw new Error("IDEMPOTENCY_CONFLICT");
    const requestHash = sha256(canonicalJson({ workId, principal, expectedRevision, task: body }));
    const scope = `orchestration:${principal}:work:${workId}:delegate`;
    let publishedTaskId: string | undefined;

    const response = this.db.transaction(() => {
      const work = this.ownedWork(workId, principal);
      const prior = this.db.one<Row>("SELECT request_hash, response_json FROM operation_receipts WHERE scope = ? AND operation_key = ?", scope, idempotencyKey);
      if (prior) {
        if (prior.request_hash !== requestHash) throw new Error("IDEMPOTENCY_CONFLICT");
        return { ...parseJson(prior.response_json, {}), deduplicated: true };
      }
      if (Number(work.revision) !== expectedRevision) throw new Error("WORK_REVISION_CONFLICT");
      if (work.status === "COMPLETED" || work.status === "CANCELLED") throw new Error("WORK_NOT_ACTIVE");
      if (work.status === "PAUSED") throw new Error("WORK_PAUSED");

      const contract = parseOrchestrationWorkContract(parseJson(work.contract_json, null));
      const parsed = this.parseBoundedTask(body, workId, principal, expectedRevision, idempotencyKey, contract);
      const delegated = this.tasks.delegateInTx(parsed, principal, now);
      const taskId = String(delegated.task_id);
      const nextRevision = expectedRevision + 1;
      this.db.run("UPDATE orchestration_works SET revision = ?, status = 'ACTIVE', updated_at = ? WHERE id = ? AND owner_principal = ? AND revision = ?", nextRevision, now, workId, principal, expectedRevision);
      if (Number(this.db.one<Row>("SELECT changes() AS count")?.count ?? 0) !== 1) throw new Error("WORK_REVISION_CONFLICT");
      this.db.run("INSERT INTO orchestration_work_tasks(work_id, task_id, role, created_at) VALUES (?, ?, 'IMPLEMENTATION', ?)", workId, taskId, now);
      this.db.run("INSERT INTO task_execution_conditions(task_id, condition, reason_code, since, revision) VALUES (?, 'READY', NULL, ?, 1)", taskId, now);

      const result = { work_id: workId, task_id: taskId, revision: nextRevision, state: String(delegated.status), execution_condition: "READY", review_state: String(work.review_state), deduplicated: false };
      this.db.run("INSERT INTO operation_receipts(scope, operation_key, request_hash, status_code, response_json, created_at) VALUES (?, ?, ?, 202, ?, ?)", scope, idempotencyKey, requestHash, JSON.stringify(result), now);
      this.appendWorkEvent(workId, nextRevision, "TASK_DELEGATED", principal, { task_id: taskId, task_state: String(delegated.status) }, now);
      if (!delegated.deduplicated) publishedTaskId = taskId;
      return result;
    });

    if (publishedTaskId) this.tasks.publishDelegated(publishedTaskId);
    return response;
  }

  controlWork(workId: string, actionInput: string, principalInput: string, expectedRevision: number, idempotencyKeyInput: string, now = Date.now()): Record<string, unknown> {
    const principal = principalValue(principalInput);
    const idempotencyKey = idempotencyValue(idempotencyKeyInput);
    const action = actionInput.toUpperCase();
    if (!["PAUSE", "CANCEL", "MANUAL_RESUME", "RESUME_WHEN_ELIGIBLE"].includes(action)) throw new Error("INVALID_WORK_CONTROL");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error("MISSING_IF_MATCH");
    const requestHash = sha256(canonicalJson({ workId, principal, action, expectedRevision }));
    const scope = `orchestration:${principal}:work:${workId}:control`;
    const cancelledTaskIds: string[] = [];
    const response = this.db.transaction(() => {
      const work = this.ownedWork(workId, principal);
      const prior = this.db.one<Row>("SELECT request_hash, response_json FROM operation_receipts WHERE scope = ? AND operation_key = ?", scope, idempotencyKey);
      if (prior) {
        if (prior.request_hash !== requestHash) throw new Error("IDEMPOTENCY_CONFLICT");
        return { ...parseJson(prior.response_json, {}), deduplicated: true };
      }
      if (Number(work.revision) !== expectedRevision) throw new Error("WORK_REVISION_CONFLICT");
      if (["COMPLETED", "CANCELLED"].includes(String(work.status))) throw new Error("WORK_NOT_ACTIVE");
      if (action === "MANUAL_RESUME") throw new Error("SESSION_CONTROL_UNSUPPORTED");

      let nextStatus = String(work.status);
      if (action === "PAUSE") nextStatus = "PAUSED";
      else if (action === "CANCEL") {
        const linkedTasks = this.db.all<Row>("SELECT task_id FROM orchestration_work_tasks WHERE work_id = ? ORDER BY created_at, task_id", workId);
        for (const linked of linkedTasks) {
          const cancelled = this.tasks.cancelInTx(String(linked.task_id), now, { idempotencyKey: `${workId}:${idempotencyKey}`, principal });
          if (cancelled.changed) cancelledTaskIds.push(String(linked.task_id));
        }
        nextStatus = "CANCELLED";
      } else if (action === "RESUME_WHEN_ELIGIBLE") nextStatus = "ACTIVE";

      const nextRevision = expectedRevision + 1;
      this.db.run("UPDATE orchestration_works SET revision = ?, status = ?, updated_at = ?, completed_at = CASE WHEN ? = 'CANCELLED' THEN COALESCE(completed_at, ?) ELSE completed_at END WHERE id = ? AND owner_principal = ? AND revision = ?", nextRevision, nextStatus, now, nextStatus, now, workId, principal, expectedRevision);
      if (Number(this.db.one<Row>("SELECT changes() AS count")?.count ?? 0) !== 1) throw new Error("WORK_REVISION_CONFLICT");
      const runningCount = Number(this.db.one<Row>("SELECT COUNT(*) AS count FROM orchestration_work_tasks wt JOIN tasks t ON t.id = wt.task_id WHERE wt.work_id = ? AND t.status IN ('ASSIGNED','RUNNING')", workId)?.count ?? 0);
      const result = {
        work_id: workId,
        action,
        revision: nextRevision,
        status: nextStatus,
        cancelled_task_ids: cancelledTaskIds,
        running_tasks_may_continue: action === "PAUSE" && runningCount > 0,
        execution_dispatched: false,
        deduplicated: false,
      };
      this.db.run("INSERT INTO operation_receipts(scope, operation_key, request_hash, status_code, response_json, created_at) VALUES (?, ?, ?, 202, ?, ?)", scope, idempotencyKey, requestHash, JSON.stringify(result), now);
      this.appendWorkEvent(workId, nextRevision, `WORK_${action}`, principal, { status: nextStatus, cancelled_task_ids: cancelledTaskIds, running_tasks_may_continue: result.running_tasks_may_continue }, now);
      return result;
    });
    for (const taskId of cancelledTaskIds) this.tasks.publishCancelled(taskId);
    return response;
  }

  recordAcceptance(workId: string, input: unknown, principalInput: string, expectedRevision: number, idempotencyKeyInput: string, now = Date.now()): Record<string, unknown> {
    const principal = principalValue(principalInput);
    const idempotencyKey = idempotencyValue(idempotencyKeyInput);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error("MISSING_IF_MATCH");
    const body = object(input, "acceptance");
    if (body.idempotency_key !== undefined && body.idempotency_key !== idempotencyKey) throw new Error("IDEMPOTENCY_CONFLICT");
    const decision = String(body.decision ?? "").toUpperCase();
    if (!["ACCEPTED", "CHANGES_REQUESTED", "REJECTED"].includes(decision)) throw new Error("INVALID_ACCEPTANCE_DECISION");
    const evidenceRefs = this.stringList(body.evidence_refs, "evidence_refs", 100, 1_000);
    if (evidenceRefs.length === 0) throw new Error("ACCEPTANCE_EVIDENCE_REQUIRED");
    const acceptedCriteria = body.accepted_criteria === undefined ? [] : this.stringList(body.accepted_criteria, "accepted_criteria", 100, 120);
    const taskId = body.task_id === undefined || body.task_id === null ? null : String(body.task_id);
    const prRef = body.pr_ref === undefined || body.pr_ref === null ? null : String(body.pr_ref).trim();
    if (prRef && prRef.length > 1_000) throw new Error("INVALID_ACCEPTANCE_PR_REF");
    const normalized = { decision, evidence_refs: evidenceRefs, accepted_criteria: acceptedCriteria, task_id: taskId, pr_ref: prRef };
    const requestHash = sha256(canonicalJson({ workId, principal, expectedRevision, acceptance: normalized }));
    const scope = `orchestration:${principal}:work:${workId}:acceptance`;

    return this.db.transaction(() => {
      const work = this.ownedWork(workId, principal);
      const prior = this.db.one<Row>("SELECT request_hash, response_json FROM operation_receipts WHERE scope = ? AND operation_key = ?", scope, idempotencyKey);
      if (prior) {
        if (prior.request_hash !== requestHash) throw new Error("IDEMPOTENCY_CONFLICT");
        return { ...parseJson(prior.response_json, {}), deduplicated: true };
      }
      if (Number(work.revision) !== expectedRevision) throw new Error("WORK_REVISION_CONFLICT");
      if (["COMPLETED", "CANCELLED"].includes(String(work.status))) throw new Error("WORK_NOT_ACTIVE");
      const contract = parseOrchestrationWorkContract(parseJson(work.contract_json, null));
      if (taskId && !this.db.one<Row>("SELECT 1 AS found FROM orchestration_work_tasks WHERE work_id = ? AND task_id = ?", workId, taskId)) throw new Error("WORK_TASK_NOT_FOUND");
      const contractCriteriaIds = new Set(contract.acceptance_criteria.map((criterion) => criterion.id));
      if (acceptedCriteria.some((criterionId) => !contractCriteriaIds.has(criterionId))) throw new Error("INVALID_ACCEPTED_CRITERIA");
      if (decision === "ACCEPTED") {
        const taskCount = Number(this.db.one<Row>("SELECT COUNT(*) AS count FROM orchestration_work_tasks WHERE work_id = ?", workId)?.count ?? 0);
        if (taskCount === 0) throw new Error("WORK_ACCEPTANCE_TASKS_INCOMPLETE");
        const incomplete = Number(this.db.one<Row>("SELECT COUNT(*) AS count FROM orchestration_work_tasks wt JOIN tasks t ON t.id = wt.task_id WHERE wt.work_id = ? AND t.status <> 'SUCCEEDED'", workId)?.count ?? 0);
        if (incomplete > 0) throw new Error("WORK_ACCEPTANCE_TASKS_INCOMPLETE");
        if (contract.acceptance_criteria.some((criterion) => !acceptedCriteria.includes(criterion.id))) throw new Error("WORK_ACCEPTANCE_CRITERIA_INCOMPLETE");
      }
      const nextRevision = expectedRevision + 1;
      const reviewState = decision;
      const nextStatus = decision === "ACCEPTED" ? "COMPLETED" : "ACTIVE";
      const acceptance = { ...normalized, accepted_at: new Date(now).toISOString(), accepted_by: principal };
      const handoffId = uuidv7(now);
      this.db.run("INSERT INTO work_review_handoffs(id, work_id, task_id, pr_ref, ci_evidence_json, acceptance_json, review_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", handoffId, workId, taskId, prRef, JSON.stringify(evidenceRefs), JSON.stringify(acceptance), reviewState, now, now);
      this.db.run("UPDATE orchestration_works SET revision = ?, status = ?, review_state = ?, updated_at = ?, completed_at = CASE WHEN ? = 'COMPLETED' THEN ? ELSE NULL END WHERE id = ? AND owner_principal = ? AND revision = ?", nextRevision, nextStatus, reviewState, now, nextStatus, now, workId, principal, expectedRevision);
      if (Number(this.db.one<Row>("SELECT changes() AS count")?.count ?? 0) !== 1) throw new Error("WORK_REVISION_CONFLICT");
      const result = { work_id: workId, handoff_id: handoffId, decision, revision: nextRevision, status: nextStatus, review_state: reviewState, deduplicated: false };
      this.db.run("INSERT INTO operation_receipts(scope, operation_key, request_hash, status_code, response_json, created_at) VALUES (?, ?, ?, 200, ?, ?)", scope, idempotencyKey, requestHash, JSON.stringify(result), now);
      this.appendWorkEvent(workId, nextRevision, "WORK_ACCEPTANCE_RECORDED", principal, { handoff_id: handoffId, decision, evidence_refs: evidenceRefs, accepted_criteria: acceptedCriteria }, now);
      return result;
    });
  }

  getWorkEvents(workId: string, principalInput: string, cursor = 0, limit = 100): Record<string, unknown> {
    this.ownedWork(workId, principalValue(principalInput));
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("INVALID_WORK_EVENT_CURSOR");
    const rows = this.db.all<Row>("SELECT seq, id, revision, event_type, actor, payload_json, created_at FROM orchestration_work_events WHERE work_id = ? AND seq > ? ORDER BY seq LIMIT ?", workId, cursor, limit + 1);
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((row) => ({ cursor: Number(row.seq), id: row.id, revision: Number(row.revision), type: row.event_type, actor: row.actor, payload: parseJson(row.payload_json, {}), created_at: row.created_at }));
    return { work_id: workId, items, next_cursor: items.length ? items[items.length - 1].cursor : cursor, has_more: hasMore, observed_at: new Date().toISOString() };
  }

  workArtifacts(workId: string, taskId: string | undefined, principalInput: string): Record<string, unknown> {
    this.ownedWork(workId, principalValue(principalInput));
    const rows = this.db.all<Row>(`SELECT a.id, a.display_filename, a.filename, a.media_type, a.size_bytes, a.sha256, a.storage_state, a.created_at, ta.task_id
      FROM orchestration_work_tasks wt JOIN task_artifacts ta ON ta.task_id = wt.task_id
      JOIN artifacts a ON a.id = ta.artifact_id
      WHERE wt.work_id = ? AND ta.direction = 'OUTPUT' AND (? IS NULL OR ta.task_id = ?)
      ORDER BY a.created_at, a.id`, workId, taskId ?? null, taskId ?? null);
    return { work_id: workId, items: rows.map((row) => ({ id: row.id, task_id: row.task_id, filename: row.display_filename ?? row.filename, media_type: row.media_type, size_bytes: Number(row.size_bytes), sha256: row.sha256, availability: row.storage_state ?? "AVAILABLE", created_at: row.created_at })) };
  }

  recoveryStatus(workId: string, principalInput: string): Record<string, unknown> {
    this.ownedWork(workId, principalValue(principalInput));
    const rows = this.db.all<Row>(`SELECT r.id, r.task_id, r.state, r.blocker_kind, r.policy_version, r.next_probe_at, r.retry_count, r.last_error_code, r.resume_policy, r.created_at, r.updated_at,
        c.condition, c.reason_code
      FROM orchestration_work_tasks wt JOIN recovery_intents r ON r.task_id = wt.task_id
      LEFT JOIN task_execution_conditions c ON c.task_id = wt.task_id
      WHERE wt.work_id = ? ORDER BY r.created_at, r.id`, workId);
    return { work_id: workId, items: rows.map((row) => ({ intent_id: row.id, task_id: row.task_id, state: row.state, condition: row.condition ?? null, reason_code: row.reason_code ?? row.last_error_code ?? null, blocker_kind: row.blocker_kind, resume_policy: row.resume_policy, policy_version: Number(row.policy_version), next_check_at: row.next_probe_at === null ? null : new Date(Number(row.next_probe_at)).toISOString(), retry_count: Number(row.retry_count), created_at: new Date(Number(row.created_at)).toISOString(), updated_at: new Date(Number(row.updated_at)).toISOString() })) };
  }

  private ownedWork(workId: string, principal: string): Row {
    const work = this.db.one<Row>("SELECT * FROM orchestration_works WHERE id = ?", workId);
    if (!work) throw new Error("WORK_NOT_FOUND");
    if (work.owner_principal !== principal) throw new Error("WORK_OWNER_CONFLICT");
    return work;
  }

  private appendWorkEvent(workId: string, revision: number, eventType: string, actor: string, payload: unknown, now: number): void {
    this.db.run("INSERT INTO orchestration_work_events(id, work_id, revision, event_type, actor, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", uuidv7(now), workId, revision, eventType, actor, canonicalJson(payload), now);
  }

  private stringList(value: unknown, field: string, maxItems: number, maxLength: number): string[] {
    if (!Array.isArray(value) || value.length > maxItems) throw new Error(`INVALID_${field.toUpperCase()}`);
    const values = value.map((item, index) => {
      if (typeof item !== "string" || !item.trim() || item.length > maxLength || item.includes("\0")) throw new Error(`INVALID_${field.toUpperCase()}:${index}`);
      return item.trim();
    });
    if (new Set(values).size !== values.length) throw new Error(`INVALID_${field.toUpperCase()}:DUPLICATE`);
    return values;
  }

  private parseBoundedTask(body: Record<string, unknown>, workId: string, principal: string, expectedRevision: number, idempotencyKey: string, contract: OrchestrationWorkContract): TaskContractV2Input {
    const source = contract.origin.kind.toLowerCase();
    if (body.source !== undefined && String(body.source).toLowerCase() !== source) throw new Error("WORK_OWNER_CONFLICT");
    const workRef = body.work_ref === undefined || body.work_ref === null ? undefined : object(body.work_ref, "work_ref");
    if (workRef && (workRef.id !== workId || workRef.revision !== expectedRevision || (workRef.owner !== undefined && workRef.owner !== principal))) throw new Error("WORK_REFERENCE_CONFLICT");
    const requirements = object(body.requirements, "requirements");
    const preferredWorker = contract.target.preferred_worker_id ?? undefined;
    if (requirements.preferred_worker !== undefined && requirements.preferred_worker !== null && requirements.preferred_worker !== preferredWorker) throw new Error("WORK_TASK_OUT_OF_SCOPE");
    if (requirements.required_worker !== undefined && requirements.required_worker !== null && preferredWorker && requirements.required_worker !== preferredWorker) throw new Error("WORK_TASK_OUT_OF_SCOPE");
    const normalizedRequirements = { ...requirements, ...(preferredWorker ? { preferred_worker: preferredWorker } : {}) };
    let effective: TaskContractV2Input;
    try {
      effective = parseTaskContractV2Input({
        ...body,
        schema_version: 2,
        source,
        idempotency_key: `work:${workId}:${idempotencyKey}`,
        source_intent_ref: body.source_intent_ref ?? `${workId}:${idempotencyKey}`,
        requirements: normalizedRequirements,
        work_ref: { id: workId, revision: expectedRevision, owner: principal },
      });
    } catch (error) {
      throw new Error(`ORCHESTRATION_TASK_INVALID:${error instanceof Error ? error.message : "invalid task contract"}`);
    }

    if (effective.taskType !== contract.target.capability
      || effective.execution.capabilities.length !== 1
      || effective.execution.capabilities[0] !== contract.target.capability
      || effective.execution.runtime !== contract.target.runtime
      || effective.execution.workspaceId !== contract.workspace_id
      || effective.retryPolicy?.effectClass === "EXTERNAL_WRITE") throw new Error("WORK_TASK_OUT_OF_SCOPE");

    effective.payload = {
      ...effective.payload,
      orchestration_work: {
        work_id: workId,
        revision: expectedRevision,
        owner_kind: contract.origin.kind,
        design_authority: contract.design_authority,
        implementation_owner: contract.implementation_owner,
        phase_ref: contract.phase_ref ?? null,
        design_refs: contract.design_refs,
        base_commit_sha: contract.base_commit_sha ?? null,
        workspace_id: contract.workspace_id,
        owned_paths: contract.owned_paths,
        acceptance_criteria: contract.acceptance_criteria,
        required_tests: contract.required_tests,
        risk_tier: contract.risk_tier,
        resume_policy: contract.resume_policy,
      },
    };
    return effective;
  }
}
