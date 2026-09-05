import { ControlPlaneDatabase } from "../db/database.ts";
import { canonicalJson, uuidv7 } from "../../../../packages/contracts/src/index.ts";
import { safeHash } from "../tasks/task-service.ts";

type Row = Record<string, any>;

function parse(value: unknown, fallback: any = []): any { try { return value === null || value === undefined ? fallback : JSON.parse(String(value)); } catch { return fallback; } }
function publicPreference(row: Row): Record<string, unknown> { return { id: row.id, name: row.name, taskType: row.task_type, version: Number(row.version), targets: parse(row.targets_json), allowFallback: Boolean(row.allow_fallback), deleted: Boolean(row.deleted_at), updatedAt: new Date(Number(row.updated_at)).toISOString() }; }
function validateTargets(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) throw new Error("INVALID_MODEL_PREFERENCE");
  const seen = new Set<string>(); const result: Record<string, unknown>[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("INVALID_MODEL_PREFERENCE");
    const record = item as Record<string, unknown>; const workerId = String(record.worker_id ?? record.workerId ?? ""); const runtime = String(record.runtime ?? ""); const modelId = String(record.model_id ?? record.modelId ?? "");
    if (!workerId || !runtime || !modelId || workerId.length > 200 || runtime.length > 120 || modelId.length > 200) throw new Error("INVALID_MODEL_PREFERENCE");
    const target = { worker_id: workerId, runtime, model_id: modelId }; const key = canonicalJson(target); if (!seen.has(key)) { seen.add(key); result.push(target); }
  }
  if (!result.length) throw new Error("INVALID_MODEL_PREFERENCE");
  return result;
}

export class ModelPreferenceService {
  private readonly db: ControlPlaneDatabase;
  constructor(db: ControlPlaneDatabase) { this.db = db; }
  list(): Record<string, unknown>[] { return this.db.all<Row>("SELECT * FROM model_preferences WHERE deleted_at IS NULL ORDER BY name, id").map(publicPreference); }
  get(id: string): Record<string, unknown> | undefined { const row = this.db.one<Row>("SELECT * FROM model_preferences WHERE id = ?", id); return row ? publicPreference(row) : undefined; }
  create(input: Record<string, unknown>, idempotencyKey: string | undefined, now = Date.now()): Record<string, unknown> {
    if (!idempotencyKey) throw new Error("MISSING_IDEMPOTENCY_KEY");
    const hash = safeHash(input); const prior = this.db.one<Row>("SELECT * FROM operation_receipts WHERE scope = 'model-preferences' AND operation_key = ?", idempotencyKey);
    if (prior) { if (prior.request_hash !== hash) throw new Error("IDEMPOTENCY_CONFLICT"); return parse(prior.response_json, {}); }
    const name = typeof input.name === "string" ? input.name.trim() : ""; const taskType = String(input.task_type ?? input.taskType ?? ""); if (!name || name.length > 200 || taskType !== "llm.inference") throw new Error("INVALID_MODEL_PREFERENCE");
    const targets = validateTargets(input.targets); const allowFallback = input.allow_fallback ?? input.allowFallback; if (typeof allowFallback !== "boolean") throw new Error("INVALID_MODEL_PREFERENCE");
    const id = uuidv7(now); this.db.run("INSERT INTO model_preferences(id, name, task_type, version, targets_json, allow_fallback, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)", id, name, taskType, JSON.stringify(targets), allowFallback ? 1 : 0, now);
    const response = this.get(id)!; this.db.run("INSERT INTO operation_receipts(scope, operation_key, request_hash, status_code, response_json, created_at) VALUES ('model-preferences', ?, ?, 201, ?, ?)", idempotencyKey, hash, JSON.stringify(response), now); return response;
  }
  update(id: string, input: Record<string, unknown>, expectedVersion: number | undefined, now = Date.now()): Record<string, unknown> {
    const row = this.db.one<Row>("SELECT * FROM model_preferences WHERE id = ?", id); if (!row) throw new Error("PREFERENCE_NOT_FOUND"); if (expectedVersion !== undefined && Number(row.version) !== expectedVersion) throw new Error("PREFERENCE_CHANGED");
    const name = input.name === undefined ? row.name : String(input.name).trim(); const taskType = input.task_type === undefined && input.taskType === undefined ? row.task_type : String(input.task_type ?? input.taskType); const targets = input.targets === undefined ? parse(row.targets_json) : validateTargets(input.targets); const allowFallback = input.allow_fallback === undefined && input.allowFallback === undefined ? Boolean(row.allow_fallback) : input.allow_fallback ?? input.allowFallback;
    if (!name || name.length > 200 || taskType !== "llm.inference" || typeof allowFallback !== "boolean") throw new Error("INVALID_MODEL_PREFERENCE");
    this.db.run("UPDATE model_preferences SET name = ?, task_type = ?, version = version + 1, targets_json = ?, allow_fallback = ?, updated_at = ? WHERE id = ?", name, taskType, JSON.stringify(targets), allowFallback ? 1 : 0, now, id); return this.get(id)!;
  }
  remove(id: string, expectedVersion: number | undefined, now = Date.now()): Record<string, unknown> { const row = this.db.one<Row>("SELECT * FROM model_preferences WHERE id = ?", id); if (!row) throw new Error("PREFERENCE_NOT_FOUND"); if (expectedVersion !== undefined && Number(row.version) !== expectedVersion) throw new Error("PREFERENCE_CHANGED"); this.db.run("UPDATE model_preferences SET deleted_at = ?, version = version + 1, updated_at = ? WHERE id = ?", now, now, id); return this.get(id)!; }
}
