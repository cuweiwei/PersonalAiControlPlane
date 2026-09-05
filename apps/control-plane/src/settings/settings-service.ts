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
