import { createHash } from "node:crypto";
import { ControlPlaneDatabase } from "../db/database.ts";

export type SettingType = "integer" | "boolean" | "string";
export type SettingSource = "ENV" | "STORED" | "DEFAULT";
export type SettingField = {
  key: string;
  label: string;
  description: string;
  type: SettingType;
  unit: string | null;
  defaultValue: unknown;
  min: number | null;
  max: number | null;
  nullable: boolean;
  envKey: string | null;
  applyScope: string;
  storedValue: unknown;
  effectiveValue: unknown;
  source: SettingSource;
  editable: boolean;
};

type SettingDefinition = Omit<SettingField, "storedValue" | "effectiveValue" | "source" | "editable">;
type EffectiveSettings = {
  version: number;
  values: Record<string, unknown>;
  fields: SettingField[];
  applications: Array<{ target: string; state: string; version: number }>;
};

const definitions: SettingDefinition[] = [
  { key: "heartbeat_interval_seconds", label: "裝置回報間隔", description: "Worker heartbeat 與設定套用回報間隔。", type: "integer", unit: "秒", defaultValue: 30, min: 5, max: 300, nullable: false, envKey: "PAI_HEARTBEAT_INTERVAL_SECONDS", applyScope: "WORKER_ACK" },
  { key: "worker_offline_seconds", label: "裝置離線門檻", description: "超過此時間未回報才判定裝置離線。", type: "integer", unit: "秒", defaultValue: 90, min: 15, max: 3600, nullable: false, envKey: "PAI_WORKER_OFFLINE_SECONDS", applyScope: "SERVER_AND_UI" },
  { key: "registration_enabled", label: "接受新裝置註冊", description: "是否接受新的 Worker 註冊請求。", type: "boolean", unit: null, defaultValue: true, min: null, max: null, nullable: false, envKey: "PAI_REGISTRATION_ENABLED", applyScope: "NEXT_REGISTRATION" },
  { key: "default_max_attempts", label: "每輪最多執行次數", description: "新任務未指定時，每輪最多派送幾次。", type: "integer", unit: "次", defaultValue: 2, min: 1, max: 10, nullable: false, envKey: "PAI_DEFAULT_MAX_ATTEMPTS", applyScope: "NEW_TASK" },
  { key: "default_task_timeout_seconds", label: "單次執行時間上限", description: "新任務未指定時的單次執行上限。", type: "integer", unit: "秒", defaultValue: 1800, min: 1, max: 86400, nullable: false, envKey: "PAI_DEFAULT_TASK_TIMEOUT_SECONDS", applyScope: "NEW_TASK" },
  { key: "task_retention_days", label: "任務保留天數", description: "已結束任務進入保留週期前的天數。", type: "integer", unit: "天", defaultValue: 30, min: 1, max: 3650, nullable: false, envKey: "PAI_TASK_RETENTION_DAYS", applyScope: "RETENTION" },
  { key: "artifact_retention_days", label: "成果保留天數", description: "成果檔案進入保留週期前的天數。", type: "integer", unit: "天", defaultValue: 30, min: 1, max: 3650, nullable: false, envKey: "PAI_ARTIFACT_RETENTION_DAYS", applyScope: "RETENTION" },
  { key: "system_health_interval_seconds", label: "系統狀態更新間隔", description: "Control Plane 健康檢查間隔。", type: "integer", unit: "秒", defaultValue: 30, min: 10, max: 3600, nullable: false, envKey: "PAI_SYSTEM_HEALTH_INTERVAL_SECONDS", applyScope: "SERVER_LOOP" },
  { key: "scheduler_interval_ms", label: "派工檢查間隔", description: "工作派送檢查間隔。", type: "integer", unit: "毫秒", defaultValue: 1000, min: 100, max: 60000, nullable: false, envKey: "PAI_SCHEDULER_INTERVAL_MS", applyScope: "SERVER_LOOP" },
  { key: "queue_attention_seconds", label: "等待提醒門檻", description: "工作持續阻擋超過此時間後列為需處理。", type: "integer", unit: "秒", defaultValue: 600, min: 60, max: 86400, nullable: false, envKey: "PAI_QUEUE_ATTENTION_SECONDS", applyScope: "DISPATCH_PROJECTION" },
  { key: "idle_threshold_seconds", label: "閒置接案門檻", description: "Worker 連續無互動後才可接案的時間。", type: "integer", unit: "秒", defaultValue: 600, min: 60, max: 7200, nullable: false, envKey: "PAI_IDLE_THRESHOLD_SECONDS", applyScope: "WORKER" },
  { key: "hermes_entry_url", label: "Hermes 入口", description: "使用者可開啟的 Hermes 入口。", type: "string", unit: null, defaultValue: null, min: null, max: null, nullable: true, envKey: "PAI_HERMES_ENTRY_URL", applyScope: "SYSTEMS" },
  { key: "contexthub_entry_url", label: "ContextHub 入口", description: "使用者可開啟的 ContextHub 入口。", type: "string", unit: null, defaultValue: null, min: null, max: null, nullable: true, envKey: "PAI_CONTEXTHUB_ENTRY_URL", applyScope: "SYSTEMS" },
  { key: "office_enabled", label: "啟用虛擬辦公室", description: "允許建立新的 Virtual Office Mission；關閉時仍保留歷史資料查詢。", type: "boolean", unit: null, defaultValue: false, min: null, max: null, nullable: false, envKey: "PAI_OFFICE_ENABLED", applyScope: "OFFICE_INTAKE" },
  { key: "office_max_active_missions", label: "同時進行的 Mission 上限", description: "新 Mission admission 的上限；活動中的等待工作也計入。", type: "integer", unit: "筆", defaultValue: 5, min: 1, max: 20, nullable: false, envKey: "PAI_OFFICE_MAX_ACTIVE_MISSIONS", applyScope: "OFFICE_INTAKE" },
  { key: "office_default_run_concurrency", label: "Mission 同時執行上限", description: "新 Mission 每輪允許的 Worker/Hermes 活動 execution 上限。", type: "integer", unit: "個", defaultValue: 3, min: 1, max: 10, nullable: false, envKey: "PAI_OFFICE_DEFAULT_RUN_CONCURRENCY", applyScope: "OFFICE_INTAKE" },
  { key: "office_default_max_elapsed_seconds", label: "Mission 最長存活時間", description: "新 Mission 從收件開始計算的硬上限。", type: "integer", unit: "秒", defaultValue: 604800, min: 3600, max: 2592000, nullable: false, envKey: "PAI_OFFICE_DEFAULT_MAX_ELAPSED_SECONDS", applyScope: "OFFICE_INTAKE" },
  { key: "office_default_max_hermes_turns", label: "Hermes turn 上限", description: "新 Mission 可 admission 的 Hermes brain turn 總數。", type: "integer", unit: "次", defaultValue: 30, min: 1, max: 200, nullable: false, envKey: "PAI_OFFICE_DEFAULT_MAX_HERMES_TURNS", applyScope: "OFFICE_INTAKE" },
  { key: "office_default_max_worker_attempts", label: "Worker attempt 上限", description: "新 Mission 可使用的 Worker attempt 總數。", type: "integer", unit: "次", defaultValue: 100, min: 1, max: 1000, nullable: false, envKey: "PAI_OFFICE_DEFAULT_MAX_WORKER_ATTEMPTS", applyScope: "OFFICE_INTAKE" },
  { key: "office_default_max_replans", label: "Plan 改版上限", description: "新 Mission 可請求的 Plan 改版次數。", type: "integer", unit: "次", defaultValue: 3, min: 0, max: 10, nullable: false, envKey: "PAI_OFFICE_DEFAULT_MAX_REPLANS", applyScope: "OFFICE_INTAKE" },
  { key: "office_default_queue_timeout_seconds", label: "Step 排隊上限", description: "新 Step 等待資源的最長時間。", type: "integer", unit: "秒", defaultValue: 86400, min: 60, max: 604800, nullable: false, envKey: "PAI_OFFICE_DEFAULT_QUEUE_TIMEOUT_SECONDS", applyScope: "OFFICE_INTAKE" },
  { key: "office_default_decision_timeout_seconds", label: "Owner 待辦上限", description: "新待辦等待 owner 回覆的最長時間。", type: "integer", unit: "秒", defaultValue: 604800, min: 60, max: 2592000, nullable: false, envKey: "PAI_OFFICE_DEFAULT_DECISION_TIMEOUT_SECONDS", applyScope: "OFFICE_INTAKE" },
  { key: "office_artifact_limit_bytes", label: "Office 單檔上限", description: "Office upload 的單檔硬上限。", type: "integer", unit: "bytes", defaultValue: 104857600, min: 1, max: 1073741824, nullable: false, envKey: "PAI_OFFICE_ARTIFACT_LIMIT_BYTES", applyScope: "OFFICE_ARTIFACT" },
  { key: "office_mission_artifact_limit_bytes", label: "Mission 成果總量上限", description: "單一 Mission 的成果總量上限。", type: "integer", unit: "bytes", defaultValue: 1073741824, min: 1, max: 4294967296, nullable: false, envKey: "PAI_OFFICE_MISSION_ARTIFACT_LIMIT_BYTES", applyScope: "OFFICE_ARTIFACT" },
  { key: "office_completed_retention_days", label: "Mission 完成保留", description: "完成 Mission 的最低保留天數。", type: "integer", unit: "天", defaultValue: 90, min: 90, max: 3650, nullable: false, envKey: "PAI_OFFICE_COMPLETED_RETENTION_DAYS", applyScope: "RETENTION" },
  { key: "office_log_retention_days", label: "Mission log 保留", description: "Mission 事件與 log 的最低保留天數。", type: "integer", unit: "天", defaultValue: 30, min: 1, max: 3650, nullable: false, envKey: "PAI_OFFICE_LOG_RETENTION_DAYS", applyScope: "RETENTION" },
  { key: "hermes_brain_v2_enabled", label: "Hermes 大腦第二版", description: "允許新 Mission 使用 Hermes 自主決策協定。", type: "boolean", unit: null, defaultValue: false, min: null, max: null, nullable: false, envKey: "PAI_HERMES_BRAIN_V2_ENABLED", applyScope: "OFFICE_INTAKE" },
  { key: "hermes_brain_max_tool_calls", label: "Hermes 工具呼叫上限", description: "單一 Mission 的 Hermes 工具邏輯呼叫上限。", type: "integer", unit: "次", defaultValue: 100, min: 1, max: 1000, nullable: false, envKey: "PAI_HERMES_BRAIN_MAX_TOOL_CALLS", applyScope: "OFFICE_INTAKE" },
  { key: "hermes_brain_capability_ttl_seconds", label: "能力快照有效時間", description: "Hermes 使用的 Worker／工具能力快照有效時間。", type: "integer", unit: "秒", defaultValue: 30, min: 5, max: 3600, nullable: false, envKey: "PAI_HERMES_BRAIN_CAPABILITY_TTL_SECONDS", applyScope: "OFFICE_INTAKE" },
];

const byKey = new Map(definitions.map((definition) => [definition.key, definition]));

function parseStored(value: unknown): unknown {
  try { return value === null || value === undefined ? undefined : JSON.parse(String(value)); } catch { return undefined; }
}

function parseEnv(definition: SettingDefinition): unknown {
  if (!definition.envKey || process.env[definition.envKey] === undefined) return undefined;
  const value = process.env[definition.envKey];
  if (definition.type === "boolean") return value === "true" ? true : value === "false" ? false : value;
  if (definition.type === "integer") return value === "" ? value : Number(value);
  return value === "" ? null : value;
}

function isValid(definition: SettingDefinition, value: unknown): boolean {
  if (value === null && definition.nullable) return true;
  if (definition.type === "boolean") return typeof value === "boolean";
  if (definition.type === "string") return typeof value === "string" && value.length <= 2_000;
  return typeof value === "number" && Number.isInteger(value) && Number.isFinite(value) && value >= (definition.min ?? Number.MIN_SAFE_INTEGER) && value <= (definition.max ?? Number.MAX_SAFE_INTEGER);
}

export class SettingsService {
  static readonly registry = definitions;
  private readonly db: ControlPlaneDatabase;
  constructor(db: ControlPlaneDatabase) { this.db = db; }

  get(): Record<string, unknown> { return this.getEffective().values; }

  getEffective(): EffectiveSettings {
    const stored = new Map(this.db.all<{ key: string; value_json: string }>("SELECT key, value_json FROM settings").map((row) => [row.key, parseStored(row.value_json)]));
    const fields = definitions.map((definition) => {
      const envValue = parseEnv(definition);
      const storedValue = stored.get(definition.key);
      const source: SettingSource = envValue !== undefined ? "ENV" : storedValue !== undefined ? "STORED" : "DEFAULT";
      const effectiveValue = source === "ENV" ? envValue : source === "STORED" ? storedValue : definition.defaultValue;
      if (!isValid(definition, effectiveValue)) throw new Error(`INVALID_EFFECTIVE_SETTING:${definition.key}`);
      return { ...definition, storedValue: storedValue ?? null, effectiveValue, source, editable: source !== "ENV" };
    });
    const values = Object.fromEntries(fields.map((field) => [field.key, field.effectiveValue]));
    if (Number(values.worker_offline_seconds) < Number(values.heartbeat_interval_seconds) * 3) throw new Error("INVALID_EFFECTIVE_SETTING:worker_offline_seconds");
    const version = Number(parseStored(this.db.one<{ value_json: string }>("SELECT value_json FROM runtime_metadata WHERE key = 'settings_version'")?.value_json) ?? 0);
    const applications = [{ target: "server", state: "APPLIED", version }];
    return { version, values, fields, applications };
  }

  patch(values: Record<string, unknown>, now = Date.now(), expectedVersion?: number): Record<string, unknown> {
    const current = this.getEffective();
    if (expectedVersion !== undefined && expectedVersion !== current.version) throw new Error("SETTINGS_CHANGED");
    const entries = Object.entries(values);
    if (entries.length === 0) return current;
    for (const [key, value] of entries) {
      const definition = byKey.get(key);
      if (!definition) throw new Error("UNKNOWN_SETTING");
      if (parseEnv(definition) !== undefined) throw new Error("SETTING_OVERRIDDEN");
      if (!isValid(definition, value)) throw new Error(`INVALID_SETTING_VALUE:${key}`);
    }
    const merged = { ...current.values, ...values };
    if (Number(merged.worker_offline_seconds) < Number(merged.heartbeat_interval_seconds) * 3) throw new Error("INVALID_SETTING_VALUE:worker_offline_seconds");
    this.db.transaction(() => {
      const latest = this.getEffective();
      if (expectedVersion !== undefined && latest.version !== expectedVersion) throw new Error("SETTINGS_CHANGED");
      for (const [key, value] of entries) this.db.run("INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at", key, JSON.stringify(value), now);
      const version = latest.version + 1;
      const hash = createHash("sha256").update(JSON.stringify(merged)).digest("hex");
      this.db.run("INSERT INTO runtime_metadata(key, value_json) VALUES ('settings_version', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json", JSON.stringify(version));
      this.db.run("INSERT INTO runtime_metadata(key, value_json) VALUES ('settings_effective_hash', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json", JSON.stringify(hash));
    });
    return this.getEffective();
  }

  taskDefaults(): { timeoutSeconds: number; maxAttempts: number; settingsVersion: number } {
    const effective = this.getEffective();
    return { timeoutSeconds: Number(effective.values.default_task_timeout_seconds), maxAttempts: Number(effective.values.default_max_attempts), settingsVersion: effective.version };
  }
}

export type { EffectiveSettings };
