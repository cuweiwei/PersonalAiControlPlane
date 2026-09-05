import { ControlPlaneDatabase } from "../db/database.ts";
import { TaskService } from "../tasks/task-service.ts";
import { uuidv7 } from "../../../../packages/contracts/src/index.ts";
import { safeHash } from "../tasks/task-service.ts";

type Row = Record<string, any>;
type Target = { workerId: string; runtime: string; modelId: string };

const templates = [
  { id: "short-summary-v1", version: 1, name: "短摘要", taskType: "llm.inference", systemPrompt: "請以繁體中文簡潔摘要輸入內容。", userTemplate: "請摘要以下內容：\n\n{{input}}", parameters: { temperature: 0.2, max_output_tokens: 512 }, timeoutSeconds: 120, maxAttempts: 1 },
  { id: "code-explanation-v1", version: 1, name: "程式說明", taskType: "llm.inference", systemPrompt: "請以繁體中文說明程式碼的用途與主要流程，不修改檔案。", userTemplate: "請說明以下程式碼：\n\n{{input}}", parameters: { temperature: 0.2, max_output_tokens: 512 }, timeoutSeconds: 120, maxAttempts: 1 },
] as const;

function parse(value: unknown, fallback: any = null): any { try { return value === null || value === undefined ? fallback : JSON.parse(String(value)); } catch { return fallback; } }
function targetKey(target: Target): string { return `${target.workerId}\u0000${target.runtime}\u0000${target.modelId}`; }
function normalizeTargets(value: unknown): Target[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) throw new Error("TARGET_UNKNOWN");
  const seen = new Set<string>(); const result: Target[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("TARGET_UNKNOWN");
    const record = item as Record<string, unknown>;
    const target = { workerId: String(record.worker_id ?? record.workerId ?? ""), runtime: String(record.runtime ?? ""), modelId: String(record.model_id ?? record.modelId ?? "") };
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(target.workerId) || !/^[A-Za-z0-9._:-]{1,120}$/.test(target.runtime) || !target.modelId || target.modelId.length > 200) throw new Error("TARGET_UNKNOWN");
    if (!seen.has(targetKey(target))) { seen.add(targetKey(target)); result.push(target); }
  }
  if (result.length === 0) throw new Error("TARGET_UNKNOWN");
  return result;
}

export class ModelTestService {
  private readonly db: ControlPlaneDatabase;
  private readonly tasks: TaskService;
  constructor(db: ControlPlaneDatabase, tasks: TaskService) { this.db = db; this.tasks = tasks; }

  listTemplates(): Record<string, unknown>[] { return templates.map((template) => ({ ...template })); }

  create(input: Record<string, unknown>, idempotencyKey: string | undefined, now = Date.now()): Record<string, unknown> {
    if (!idempotencyKey) throw new Error("MISSING_IDEMPOTENCY_KEY");
    const requestHash = safeHash(input); const prior = this.db.one<Row>("SELECT * FROM operation_receipts WHERE scope = 'model-tests' AND operation_key = ?", idempotencyKey);
    if (prior) { if (prior.request_hash !== requestHash) throw new Error("IDEMPOTENCY_CONFLICT"); return parse(prior.response_json, {}); }
    const templateId = String(input.template_id ?? ""); const templateVersion = Number(input.template_version ?? 0); const template = templates.find((item) => item.id === templateId && item.version === templateVersion);
    if (!template) throw new Error("TEMPLATE_CHANGED");
    const inputText = typeof input.input_text === "string" ? input.input_text : "";
    if (!inputText || inputText.length > 20_000) throw new Error("INVALID_MODEL_TEST_INPUT");
    const targets = normalizeTargets(input.targets);
    for (const target of targets) {
      const row = this.db.one<Row>("SELECT m.worker_id FROM worker_models m JOIN workers w ON w.id = m.worker_id WHERE m.worker_id = ? AND m.runtime = ? AND m.model_id = ? AND w.removed_at IS NULL", target.workerId, target.runtime, target.modelId);
      if (!row) throw new Error("TARGET_UNKNOWN");
    }
    const parameters = input.parameters === undefined ? { ...template.parameters } : input.parameters;
    if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) throw new Error("TEST_PARAMETER_UNSUPPORTED");
    const parameterRecord = parameters as Record<string, unknown>;
    const temperature = Number(parameterRecord.temperature ?? template.parameters.temperature); const maxOutputTokens = Number(parameterRecord.max_output_tokens ?? parameterRecord.maxOutputTokens ?? template.parameters.max_output_tokens);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2 || !Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 16_384) throw new Error("TEST_PARAMETER_UNSUPPORTED");
    const effectiveParameters = { temperature, max_output_tokens: maxOutputTokens };
    const id = uuidv7(now);
    this.db.transaction(() => {
      this.db.run("INSERT INTO model_test_batches(id, template_id, template_version, input_json, parameters_json, input_hash, state, created_at) VALUES (?, ?, ?, ?, ?, ?, 'QUEUED', ?)", id, template.id, template.version, JSON.stringify({ inputText }), JSON.stringify(effectiveParameters), safeHash(inputText), now);
      targets.forEach((target, position) => this.db.run("INSERT INTO model_test_cases(batch_id, position, target_json, state) VALUES (?, ?, ?, 'PENDING')", id, position, JSON.stringify(target)));
    });
    this.startNext(id, inputText, template, effectiveParameters, now);
    const response = this.get(id, now) ?? { id, state: "QUEUED" };
    this.db.run("INSERT INTO operation_receipts(scope, operation_key, request_hash, status_code, response_json, created_at) VALUES ('model-tests', ?, ?, 202, ?, ?)", idempotencyKey, requestHash, JSON.stringify(response), now);
    return response;
  }

  get(id: string, now = Date.now()): Record<string, unknown> | undefined {
    this.sync(id, now);
    const batch = this.db.one<Row>("SELECT * FROM model_test_batches WHERE id = ?", id); if (!batch) return undefined;
    const cases = this.db.all<Row>("SELECT * FROM model_test_cases WHERE batch_id = ? ORDER BY position", id).map((row) => {
      const target = parse(row.target_json, {}); const task = row.task_id ? this.tasks.detail(String(row.task_id)) : undefined;
      return { position: Number(row.position), target, taskId: row.task_id, state: row.state, skipReason: row.skip_reason, queueDeadlineAt: row.queue_deadline_at ? new Date(Number(row.queue_deadline_at)).toISOString() : null, inputHash: batch.input_hash, parameters: parse(batch.parameters_json, {}), result: task?.result ?? null, failure: task?.failure ?? null, taskStatus: task?.status ?? null };
    });
    const current = cases.find((item) => ["QUEUED", "RUNNING"].includes(String(item.state)));
    return { id: batch.id, templateId: batch.template_id, templateVersion: batch.template_version, state: batch.state, createdAt: new Date(Number(batch.created_at)).toISOString(), finishedAt: batch.finished_at ? new Date(Number(batch.finished_at)).toISOString() : null, input: parse(batch.input_json, {}), parameters: parse(batch.parameters_json, {}), inputHash: batch.input_hash, currentPosition: current?.position ?? null, cases, availableActions: { cancel: ["QUEUED", "RUNNING"].includes(String(batch.state)) } };
  }

  syncAll(now = Date.now()): number { const ids = this.db.all<Row>("SELECT id FROM model_test_batches WHERE state IN ('QUEUED', 'RUNNING')"); for (const row of ids) this.sync(String(row.id), now); return ids.length; }

  cancel(id: string, now = Date.now()): Record<string, unknown> | undefined {
    const batch = this.db.one<Row>("SELECT * FROM model_test_batches WHERE id = ?", id); if (!batch) return undefined;
    this.db.run("UPDATE model_test_cases SET state = 'CANCELLED', skip_reason = 'BATCH_CANCELLED' WHERE batch_id = ? AND state = 'PENDING'", id);
    const active = this.db.one<Row>("SELECT task_id FROM model_test_cases WHERE batch_id = ? AND state IN ('QUEUED', 'RUNNING') AND task_id IS NOT NULL LIMIT 1", id);
    if (active) this.tasks.cancel(String(active.task_id), now);
    this.db.run("UPDATE model_test_batches SET state = 'CANCELLED', finished_at = COALESCE(finished_at, ?) WHERE id = ? AND state IN ('QUEUED', 'RUNNING')", now, id);
    return this.get(id, now);
  }

  private sync(id: string, now: number): void {
    const batch = this.db.one<Row>("SELECT * FROM model_test_batches WHERE id = ?", id); if (!batch || ["COMPLETED", "CANCELLED"].includes(String(batch.state))) return;
    const inputText = String(parse(batch.input_json, {}).inputText ?? ""); const template = templates.find((item) => item.id === batch.template_id && item.version === Number(batch.template_version)); if (!template) return;
    const parameters = parse(batch.parameters_json, {});
    const cases = this.db.all<Row>("SELECT * FROM model_test_cases WHERE batch_id = ? ORDER BY position", id);
    for (const item of cases) {
      if (!item.task_id) continue;
      const task = this.tasks.get(String(item.task_id)); if (!task) continue;
      if (task.status === "QUEUED" && item.queue_deadline_at && Number(item.queue_deadline_at) <= now) { this.tasks.cancel(String(item.task_id), now); this.db.run("UPDATE model_test_cases SET state = 'SKIPPED', skip_reason = 'TARGET_WAIT_TIMEOUT' WHERE batch_id = ? AND position = ? AND state IN ('QUEUED', 'PENDING')", id, item.position); }
      else if (task.status === "SUCCEEDED") this.db.run("UPDATE model_test_cases SET state = 'SUCCEEDED' WHERE batch_id = ? AND position = ? AND state NOT IN ('SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED')", id, item.position);
      else if (task.status === "FAILED") this.db.run("UPDATE model_test_cases SET state = 'FAILED' WHERE batch_id = ? AND position = ? AND state NOT IN ('SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED')", id, item.position);
      else if (task.status === "CANCELLED") this.db.run("UPDATE model_test_cases SET state = 'CANCELLED' WHERE batch_id = ? AND position = ? AND state NOT IN ('SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED')", id, item.position);
      else if (["ASSIGNED", "RUNNING"].includes(String(task.status))) this.db.run("UPDATE model_test_cases SET state = ? WHERE batch_id = ? AND position = ? AND state = 'QUEUED'", task.status, id, item.position);
    }
    const refreshed = this.db.all<Row>("SELECT * FROM model_test_cases WHERE batch_id = ? ORDER BY position", id);
    if (refreshed.every((item) => ["SUCCEEDED", "FAILED", "SKIPPED", "CANCELLED"].includes(String(item.state)))) { this.db.run("UPDATE model_test_batches SET state = 'COMPLETED', finished_at = COALESCE(finished_at, ?) WHERE id = ? AND state <> 'CANCELLED'", now, id); return; }
    if (!refreshed.some((item) => ["QUEUED", "RUNNING"].includes(String(item.state)))) this.startNext(id, inputText, template, parameters, now);
  }

  private startNext(id: string, inputText: string, template: (typeof templates)[number], parameters: Record<string, unknown>, now: number): void {
    const item = this.db.one<Row>("SELECT * FROM model_test_cases WHERE batch_id = ? AND state = 'PENDING' ORDER BY position LIMIT 1", id); if (!item) return;
    const target = parse(item.target_json, {}) as Target;
    const task = this.tasks.create({ source: "control-plane", sourceRef: { kind: "model_test", id }, title: `${template.name} · ${target.modelId}`, taskType: "llm.inference", purpose: "MODEL_TEST", instruction: template.userTemplate.replace("{{input}}", inputText), context: { template_id: template.id, template_version: template.version, input_hash: safeHash(inputText) }, payload: { system_prompt: template.systemPrompt, prompt: template.userTemplate.replace("{{input}}", inputText), temperature: parameters.temperature as any, max_tokens: parameters.max_output_tokens as any }, execution: { capabilities: ["llm.inference"], workerId: target.workerId, runtime: target.runtime, model: { name: target.modelId, mode: "required" }, resources: {} }, limits: { timeoutSeconds: template.timeoutSeconds, maxAttempts: template.maxAttempts }, priority: "normal", inputArtifactIds: [] }, now);
    this.db.run("UPDATE model_test_cases SET task_id = ?, queue_deadline_at = ?, state = 'QUEUED' WHERE batch_id = ? AND position = ? AND state = 'PENDING'", task.id, now + 300_000, id, item.position);
    this.db.run("UPDATE model_test_batches SET state = 'RUNNING' WHERE id = ? AND state = 'QUEUED'", id);
  }
}
