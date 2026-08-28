import { sha256, uuidv7 } from "../../../packages/crypto/src/index.ts";
import { OrchestratorDatabase } from "./db.ts";

export type IntervalRecurrence = { kind: "interval"; everyMs: number; templateRevision: number };
export type ScheduleRecord = { id: string; name: string; status: "ACTIVE" | "PAUSED" | "DISABLED"; timezone: string; recurrence: IntervalRecurrence; nextRunAt: number | null; misfirePolicy: "SKIP" | "RUN_ONCE"; goalTemplate: Record<string, unknown>; stateVersion: number };

function validTimezone(timezone: string): boolean { try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(); return true; } catch { return false; } }

export class ScheduleService {
  private readonly db: OrchestratorDatabase;
  private readonly clock: () => number;
  constructor(db: OrchestratorDatabase, clock: () => number = Date.now) { this.db = db; this.clock = clock; }
  create(input: { name: string; timezone: string; recurrence: IntervalRecurrence; nextRunAt: number; misfirePolicy: "SKIP" | "RUN_ONCE"; goalTemplate: Record<string, unknown> }): ScheduleRecord {
    if (!input.name || !validTimezone(input.timezone) || input.recurrence.kind !== "interval" || !Number.isInteger(input.recurrence.everyMs) || input.recurrence.everyMs < 1_000 || !Number.isInteger(input.recurrence.templateRevision) || input.nextRunAt < this.clock()) throw new Error("schedule is invalid");
    const id = uuidv7(this.clock());
    this.db.run("INSERT INTO schedules(id, name, status, timezone, recurrence, next_run_at, misfire_policy, goal_template_json, created_at, updated_at) VALUES (?, ?, 'ACTIVE', ?, ?, ?, ?, ?, ?, ?)", id, input.name, input.timezone, JSON.stringify(input.recurrence), input.nextRunAt, input.misfirePolicy, JSON.stringify(input.goalTemplate), this.clock(), this.clock());
    return this.get(id)!;
  }
  pause(id: string): ScheduleRecord { this.db.run("UPDATE schedules SET status = 'PAUSED', state_version = state_version + 1, updated_at = ? WHERE id = ? AND status = 'ACTIVE'", this.clock(), id); return this.get(id)!; }
  manualRun(id: string, createGoal: (template: Record<string, unknown>, dedupeKey: string) => string): string {
    const schedule = this.get(id); if (!schedule || schedule.status === "DISABLED") throw new Error("schedule is unavailable");
    return this.fire(schedule, this.clock(), createGoal);
  }
  evaluateDue(createGoal: (template: Record<string, unknown>, dedupeKey: string) => string, now = this.clock()): string[] {
    const due = this.db.all<Record<string, unknown>>("SELECT id FROM schedules WHERE status = 'ACTIVE' AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at, id", now);
    const created: string[] = [];
    for (const row of due) {
      const schedule = this.get(String(row.id)); if (!schedule || schedule.nextRunAt === null) continue;
      const goalId = this.fire(schedule, schedule.nextRunAt, createGoal); created.push(goalId);
      this.db.run("UPDATE schedules SET next_run_at = ?, state_version = state_version + 1, updated_at = ? WHERE id = ? AND state_version = ?", schedule.nextRunAt + schedule.recurrence.everyMs, now, schedule.id, schedule.stateVersion);
    }
    return created;
  }
  private fire(schedule: ScheduleRecord, intendedAt: number, createGoal: (template: Record<string, unknown>, dedupeKey: string) => string): string {
    const dedupeKey = sha256(`${schedule.id}|${intendedAt}|${schedule.recurrence.templateRevision}`);
    const existing = this.db.one<{ goal_id: string | null }>("SELECT goal_id FROM schedule_firings WHERE dedupe_key = ?", dedupeKey);
    if (existing?.goal_id) return existing.goal_id;
    const goalId = createGoal(schedule.goalTemplate, dedupeKey);
    this.db.run("INSERT INTO schedule_firings(id, schedule_id, intended_run_at, dedupe_key, goal_id, disposition, created_at) VALUES (?, ?, ?, ?, ?, 'GOAL_CREATED', ?)", uuidv7(this.clock()), schedule.id, intendedAt, dedupeKey, goalId, this.clock());
    return goalId;
  }
  get(id: string): ScheduleRecord | undefined { const row = this.db.one<Record<string, unknown>>("SELECT * FROM schedules WHERE id = ?", id); return row ? { id: String(row.id), name: String(row.name), status: row.status as ScheduleRecord["status"], timezone: String(row.timezone), recurrence: JSON.parse(String(row.recurrence)) as IntervalRecurrence, nextRunAt: row.next_run_at === null ? null : Number(row.next_run_at), misfirePolicy: row.misfire_policy as ScheduleRecord["misfirePolicy"], goalTemplate: JSON.parse(String(row.goal_template_json)), stateVersion: Number(row.state_version) } : undefined; }
}
