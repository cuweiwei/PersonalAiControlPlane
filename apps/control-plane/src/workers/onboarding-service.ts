import { ControlPlaneDatabase } from "../db/database.ts";
import { uuidv7 } from "../../../../packages/contracts/src/index.ts";

type Row = Record<string, any>;
function parse(value: unknown, fallback: any = []): any { try { return value === null || value === undefined ? fallback : JSON.parse(String(value)); } catch { return fallback; } }
function publicOnboarding(row: Row, db: ControlPlaneDatabase): Record<string, unknown> {
  const selectedCapabilities = parse(row.selected_capabilities_json); const selectedWorkspaces = parse(row.selected_workspaces_json);
  const registration = row.registration_id ? db.one<Row>("SELECT status, worker_id, expires_at, finalized_at FROM worker_registration_requests WHERE id = ?", row.registration_id) : undefined;
  const worker = row.worker_id ? db.one<Row>("SELECT * FROM workers WHERE id = ? AND removed_at IS NULL", row.worker_id) : registration?.worker_id ? db.one<Row>("SELECT * FROM workers WHERE id = ? AND removed_at IS NULL", registration.worker_id) : undefined;
  const capabilities = worker ? db.all<Row>("SELECT capability, runtime, status, grant_status AS grantStatus FROM worker_capabilities WHERE worker_id = ?", worker.id) : [];
  const workspaces = worker ? db.all<Row>("SELECT workspace_id AS workspaceId, state FROM worker_workspaces WHERE worker_id = ?", worker.id) : [];
  const requiredCapabilities = selectedCapabilities.length ? selectedCapabilities : [];
  const capabilitiesReady = requiredCapabilities.every((name: unknown) => capabilities.some((item) => item.capability === name && ["READY", "HEALTHY"].includes(String(item.status)) && !["REVOKED", "REQUIRES_REVIEW"].includes(String(item.grantStatus ?? "DISCOVERED"))));
  const workspacesReady = selectedWorkspaces.length === 0 || selectedWorkspaces.every((id: unknown) => workspaces.some((item) => item.workspaceId === id && item.state === "READY"));
  const fact = { registration: Boolean(registration?.finalized_at || worker), capabilities: capabilitiesReady, workspaces: workspacesReady, workerId: worker?.id ?? registration?.worker_id ?? row.worker_id ?? null };
  const inferredStep = !fact.registration ? (registration ? "APPROVE" : "INSTALL") : !fact.capabilities ? "CAPABILITIES" : !fact.workspaces ? "WORKSPACES" : "COMPLETE";
  return { id: row.id, platform: row.platform, selectedCapabilities, selectedWorkspaces, registrationId: row.registration_id, workerId: fact.workerId, lastStep: row.last_step, inferredStep, facts: fact, registration: registration ? { status: registration.status, phase: registration.status === "APPROVED" ? (registration.finalized_at ? "REGISTERED" : "OWNER_APPROVED") : registration.status, expiresAt: registration.expires_at ? new Date(Number(registration.expires_at)).toISOString() : null } : null, diagnosticTaskIds: parse(row.diagnostic_task_ids_json), createdAt: new Date(Number(row.created_at)).toISOString(), updatedAt: new Date(Number(row.updated_at)).toISOString(), abandonedAt: row.abandoned_at ? new Date(Number(row.abandoned_at)).toISOString() : null };
}

export class OnboardingService {
  private readonly db: ControlPlaneDatabase;
  constructor(db: ControlPlaneDatabase) { this.db = db; }
  create(platform: string, selectedCapabilities: unknown[] = [], now = Date.now(), workerId?: string): Record<string, unknown> {
    if (!["darwin", "win32", "linux"].includes(platform)) throw new Error("INVALID_ONBOARDING_PLATFORM");
    const existing = workerId ? this.db.one<Row>("SELECT * FROM worker_onboarding WHERE worker_id = ? AND abandoned_at IS NULL ORDER BY updated_at DESC LIMIT 1", workerId) : undefined;
    if (existing) return publicOnboarding(existing, this.db);
    const ids = selectedCapabilities.filter((value): value is string => typeof value === "string" && value.length <= 120).slice(0, 20); const id = uuidv7(now);
    this.db.run("INSERT INTO worker_onboarding(id, platform, selected_capabilities_json, selected_workspaces_json, last_step, created_at, updated_at) VALUES (?, ?, ?, '[]', 'SELECT_PLATFORM', ?, ?)", id, platform, JSON.stringify([...new Set(ids)]), now, now); return this.get(id)!;
  }
  get(id: string): Record<string, unknown> | undefined { const row = this.db.one<Row>("SELECT * FROM worker_onboarding WHERE id = ?", id); return row ? publicOnboarding(row, this.db) : undefined; }
  update(id: string, input: Record<string, unknown>, now = Date.now()): Record<string, unknown> {
    const row = this.db.one<Row>("SELECT * FROM worker_onboarding WHERE id = ?", id); if (!row) throw new Error("ONBOARDING_NOT_FOUND");
    const capabilities = input.selected_capabilities === undefined ? parse(row.selected_capabilities_json) : input.selected_capabilities; const workspaces = input.selected_workspaces === undefined ? parse(row.selected_workspaces_json) : input.selected_workspaces; const step = input.last_step === undefined ? row.last_step : String(input.last_step);
    if (!Array.isArray(capabilities) || !capabilities.every((value) => typeof value === "string" && value.length <= 120) || !Array.isArray(workspaces) || !workspaces.every((value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value)) || !["SELECT_PLATFORM", "INSTALL", "APPROVE", "CAPABILITIES", "WORKSPACES", "DIAGNOSTIC", "COMPLETE"].includes(step)) throw new Error("INVALID_ONBOARDING_UPDATE");
    this.db.run("UPDATE worker_onboarding SET selected_capabilities_json = ?, selected_workspaces_json = ?, last_step = ?, updated_at = ? WHERE id = ? AND abandoned_at IS NULL", JSON.stringify([...new Set(capabilities)]), JSON.stringify([...new Set(workspaces)]), step, now, id); return this.get(id)!;
  }
  createForWorker(workerId: string, now = Date.now()): Record<string, unknown> { const worker = this.db.one<Row>("SELECT platform FROM workers WHERE id = ? AND removed_at IS NULL", workerId); if (!worker) throw new Error("WORKER_NOT_FOUND"); return this.create(String(worker.platform), [], now, workerId); }
  installer(platform: string, onboardingId: string | null): Record<string, unknown> {
    if (!["darwin", "win32"].includes(platform)) throw new Error("INVALID_ONBOARDING_PLATFORM");
    if (onboardingId && !this.get(onboardingId)) throw new Error("ONBOARDING_NOT_FOUND");
    const platformKey = platform === "darwin" ? "DARWIN" : "WIN32"; const url = process.env[`PAI_WORKER_RELEASE_URL_${platformKey}`] ?? process.env.PAI_WORKER_RELEASE_URL ?? null;
    return { platform, onboardingId, releaseVersion: process.env.PAI_WORKER_RELEASE_VERSION ?? "2.0.0", downloadUrl: url, origin: process.env.PAI_CONTROL_PLANE_ORIGIN ?? null, checks: ["node_version", "worker_executable", "control_plane_origin"], installCommand: platform === "darwin" ? "install.sh" : "pai-worker.cmd", instructions: platform === "darwin" ? ["下載已發布的 Worker bundle", "確認 Control Plane origin", "登入後啟用常駐服務"] : ["下載已發布的 Worker bundle", "確認 Control Plane origin", "登入後啟用 Scheduled Task"] };
  }
}
