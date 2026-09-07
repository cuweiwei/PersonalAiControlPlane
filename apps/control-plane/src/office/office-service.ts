import { ControlPlaneDatabase } from "../db/database.ts";
import { EventHub } from "../events/event-hub.ts";
import { SettingsService } from "../settings/settings-service.ts";
import { safeHash } from "../tasks/task-service.ts";
import { uuidv7, type MemberCreateInput, type RoleCreateInput } from "../../../../packages/contracts/src/index.ts";

type Row = Record<string, any>;
function parseJson(value: unknown, fallback: unknown = {}): any { try { return value === null || value === undefined ? fallback : JSON.parse(String(value)); } catch { return fallback; } }
function iso(value: unknown): string | null { return typeof value === "number" ? new Date(value).toISOString() : null; }

export class OfficeService {
  private readonly db: ControlPlaneDatabase;
  private readonly events: EventHub;
  private readonly settings?: SettingsService;
  constructor(db: ControlPlaneDatabase, events: EventHub, settings?: SettingsService) { this.db = db; this.events = events; this.settings = settings; }

  list(): Record<string, unknown>[] { return this.db.all<Row>("SELECT * FROM offices WHERE archived_at IS NULL ORDER BY created_at, id").map((row) => this.publicOffice(row)); }

  get(officeId: string): Record<string, unknown> | undefined {
    const office = this.db.one<Row>("SELECT * FROM offices WHERE id = ? AND archived_at IS NULL", officeId);
    if (!office) return undefined;
    const result = this.publicOffice(office);
    const members = this.db.all<Row>("SELECT m.*, r.name AS role_name, r.responsibilities, r.contract_json FROM office_members m JOIN role_definitions r ON r.role_id = m.role_id AND r.version = m.role_version WHERE m.office_id = ? AND m.archived_at IS NULL ORDER BY m.seat_key, m.id", officeId).map((row) => ({ id: row.id, displayName: row.display_name, avatarKey: row.avatar_key, seatKey: row.seat_key, role: { id: row.role_id, version: Number(row.role_version), name: row.role_name, responsibilities: row.responsibilities, contract: parseJson(row.contract_json) }, binding: parseJson(row.binding_json), maxConcurrency: Number(row.max_concurrency), configRevision: Number(row.config_revision), presentationRevision: Number(row.presentation_revision) }));
    const enabled = this.settings?.get().office_enabled === true || (!this.settings && process.env.PAI_OFFICE_ENABLED === "true");
    const hermesConfigured = Boolean(process.env.PAI_HERMES_OFFICE_URL);
    const activeMissions = Number(this.db.one<Row>("SELECT COUNT(*) AS count FROM mission_runs r JOIN missions m ON m.id = r.mission_id WHERE m.office_id = ? AND r.phase NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')", officeId)?.count ?? 0);
    const waitingMissions = Number(this.db.one<Row>("SELECT COUNT(*) AS count FROM mission_runs r JOIN missions m ON m.id = r.mission_id WHERE m.office_id = ? AND r.phase NOT IN ('COMPLETED', 'FAILED', 'CANCELLED') AND r.wait_summary_json LIKE '%WAIT%'", officeId)?.count ?? 0);
    return { ...result, members, metrics: { activeMissions, waitingMissions, memberCount: members.length }, workflowHealth: { state: !enabled ? "DISABLED" : hermesConfigured ? "READY" : "WAITING_DEPENDENCY", schemaReady: true, officeEnabled: enabled, hermesAdapterConfigured: hermesConfigured } };
  }

  createRole(input: RoleCreateInput, now = Date.now()): Record<string, unknown> {
    const roleId = uuidv7(now);
    this.db.transaction(() => {
      this.db.run("INSERT INTO role_definitions(role_id, version, name, responsibilities, contract_json, contract_hash, created_at) VALUES (?, 1, ?, ?, ?, ?, ?)", roleId, input.name, input.responsibilities, JSON.stringify(input.contract), safeHash(input.contract), now);
    });
    this.events.publish({ type: "office.role.created", roleId, version: 1 });
    return this.role(roleId, 1)!;
  }

  createMember(officeId: string, input: MemberCreateInput, now = Date.now()): Record<string, unknown> {
    const memberId = uuidv7(now);
    this.db.transaction(() => {
      if (!this.db.one("SELECT id FROM offices WHERE id = ? AND archived_at IS NULL", officeId)) throw new Error("OFFICE_NOT_FOUND");
      if (!this.db.one("SELECT role_id FROM role_definitions WHERE role_id = ? AND version = ? AND archived_at IS NULL", input.roleId, input.roleVersion)) throw new Error("ROLE_NOT_FOUND");
      if (this.db.one("SELECT id FROM office_members WHERE office_id = ? AND seat_key = ? AND archived_at IS NULL", officeId, input.seatKey)) throw new Error("SEAT_ALREADY_ASSIGNED");
      this.db.run("INSERT INTO office_members(id, office_id, role_id, role_version, display_name, avatar_key, seat_key, binding_json, max_concurrency, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", memberId, officeId, input.roleId, input.roleVersion, input.displayName, input.avatarKey ?? null, input.seatKey, JSON.stringify(input.binding), input.maxConcurrency, now);
    });
    this.events.publish({ type: "office.member.created", officeId, memberId });
    return this.member(memberId)!;
  }

  member(memberId: string): Record<string, unknown> | undefined {
    const row = this.db.one<Row>("SELECT m.*, r.name AS role_name, r.responsibilities, r.contract_json FROM office_members m JOIN role_definitions r ON r.role_id = m.role_id AND r.version = m.role_version WHERE m.id = ? AND m.archived_at IS NULL", memberId);
    return row ? { id: row.id, officeId: row.office_id, displayName: row.display_name, avatarKey: row.avatar_key, seatKey: row.seat_key, role: { id: row.role_id, version: Number(row.role_version), name: row.role_name, responsibilities: row.responsibilities, contract: parseJson(row.contract_json) }, binding: parseJson(row.binding_json), maxConcurrency: Number(row.max_concurrency), configRevision: Number(row.config_revision), presentationRevision: Number(row.presentation_revision) } : undefined;
  }

  role(roleId: string, version: number): Record<string, unknown> | undefined {
    const row = this.db.one<Row>("SELECT * FROM role_definitions WHERE role_id = ? AND version = ?", roleId, version);
    return row ? { id: row.role_id, version: Number(row.version), name: row.name, responsibilities: row.responsibilities, contract: parseJson(row.contract_json), contractHash: row.contract_hash, createdAt: iso(row.created_at) } : undefined;
  }

  private publicOffice(row: Row): Record<string, unknown> { return { id: row.id, name: row.name, layout: parseJson(row.layout_json), presentationRevision: Number(row.presentation_revision), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }; }
}
