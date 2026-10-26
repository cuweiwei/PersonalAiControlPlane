import { createHash } from "node:crypto";
import { canonicalJson, uuidv7 } from "../../../../packages/contracts/src/index.ts";
import { ControlPlaneDatabase } from "../db/database.ts";
import { SettingsService } from "../settings/settings-service.ts";
import { WorkerService } from "../workers/worker-service.ts";

type Row = Record<string, any>;
type PolicyDecision = { state: "DISABLED_BY_POLICY" | "WAITING_HOST" | "WAITING_RESET"; reason: string };

function digest(value: unknown): string { return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex"); }

/** Reconciles durable intents when operator policy changes. It never sends or retries a model turn. */
export class RecoveryPolicyReconciler {
  private readonly db: ControlPlaneDatabase;
  private readonly settings: SettingsService;
  private readonly workers: WorkerService;

  constructor(db: ControlPlaneDatabase, settings: SettingsService, workers: WorkerService) {
    this.db = db;
    this.settings = settings;
    this.workers = workers;
  }

  reconcile(now = Date.now(), limit = 200): { examined: number; changed: number; inFlight: number } {
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("INVALID_RECOVERY_RECONCILE_INPUT");
    const effective = this.settings.getEffective();
    const rows = this.db.all<Row>(`SELECT r.id, r.task_id, r.session_binding_id, r.state, r.resume_policy, r.policy_version,
      r.last_error_code, s.worker_id FROM recovery_intents r JOIN agent_session_bindings s ON s.id = r.session_binding_id
      WHERE r.state IN ('WAITING_RESET','DISABLED_BY_POLICY','WAITING_HOST','RESUME_ELIGIBLE','RESUMING')
      ORDER BY r.next_probe_at IS NULL, r.next_probe_at, r.created_at, r.id LIMIT ?`, limit);
    let changed = 0;
    let inFlight = 0;
    for (const row of rows) {
      const worker = this.workers.getWorker(String(row.worker_id), now) as Row | undefined;
      const preferences = worker ? this.workers.preferences(String(row.worker_id)) as Row : null;
      const autoResume = preferences?.autoResume as Row | undefined;
      const decision = this.decision({
        emergencyStop: Boolean(effective.values.auto_resume_emergency_stop),
        globalDefault: Boolean(effective.values.auto_resume_default_enabled),
        workerOverride: autoResume?.override === null || autoResume?.override === undefined ? null : Boolean(autoResume.override),
        workerEffective: Boolean(autoResume?.effective),
        workerExists: Boolean(worker),
        workerEnabled: Boolean(worker?.enabled),
        workerDrain: Boolean(worker?.drain),
        workerOnline: worker?.status === "ONLINE",
        paused: Boolean(preferences?.pause),
        resumePolicy: String(row.resume_policy),
      });
      const policyVersion = effective.version + Number(preferences?.version ?? 0);
      const priorState = String(row.state);
      if (priorState === "RESUMING") {
        if (decision.state !== "WAITING_RESET") {
          const inFlightCode = "POLICY_CHANGED_IN_FLIGHT";
          if (row.last_error_code !== inFlightCode || Number(row.policy_version) !== policyVersion) {
            this.persistChange(row, "RESUMING", inFlightCode, policyVersion, now, "POLICY_CHANGED_IN_FLIGHT");
            changed++;
          }
        }
        inFlight++;
        continue;
      }
      // Until the quota engine and a native session adapter are verified, even a stale
      // RESUME_ELIGIBLE state is demoted. This reconciler never promotes to that state.
      const targetState = decision.state === "WAITING_RESET" && priorState === "RESUME_ELIGIBLE" ? "WAITING_RESET" : decision.state;
      const targetReason = decision.state === "WAITING_RESET" && priorState === "RESUME_ELIGIBLE" ? "RUNTIME_UNSUPPORTED" : decision.reason;
      if (priorState !== targetState || row.last_error_code !== targetReason || Number(row.policy_version) !== policyVersion) {
        this.persistChange(row, targetState, targetReason, policyVersion, now, "POLICY_RECONCILED");
        changed++;
      }
    }
    return { examined: rows.length, changed, inFlight };
  }

  private decision(input: { emergencyStop: boolean; globalDefault: boolean; workerOverride: boolean | null; workerEffective: boolean; workerExists: boolean; workerEnabled: boolean; workerDrain: boolean; workerOnline: boolean; paused: boolean; resumePolicy: string }): PolicyDecision {
    if (input.emergencyStop) return { state: "DISABLED_BY_POLICY", reason: "GLOBAL_STOP" };
    if (!input.workerExists || !input.workerEnabled || input.workerDrain || input.paused || !input.workerOnline) return { state: "WAITING_HOST", reason: "WORKER_UNAVAILABLE" };
    if (input.resumePolicy === "MANUAL_ONLY") return { state: "DISABLED_BY_POLICY", reason: "TASK_MANUAL_ONLY" };
    if (!input.workerEffective) return { state: "DISABLED_BY_POLICY", reason: input.workerOverride === false ? "WORKER_POLICY_OFF" : "GLOBAL_POLICY_OFF" };
    return { state: "WAITING_RESET", reason: "RUNTIME_UNSUPPORTED" };
  }

  private persistChange(row: Row, state: string, reason: string, policyVersion: number, now: number, eventType: string): void {
    this.db.transaction(() => {
      const current = this.db.one<Row>("SELECT state, last_error_code FROM recovery_intents WHERE id = ?", row.id);
      if (!current) return;
      if (String(current.state) === "RESUMING" && eventType !== "POLICY_CHANGED_IN_FLIGHT") return;
      const nextActionAt = state === "WAITING_RESET" ? now : null;
      this.db.run("UPDATE recovery_intents SET state = ?, last_error_code = ?, policy_version = ?, next_probe_at = ?, updated_at = ? WHERE id = ?", state, reason, policyVersion, nextActionAt, now, row.id);
      this.db.run(`INSERT INTO task_execution_conditions(task_id, condition, reason_code, since, revision, next_action_at)
        VALUES (?, ?, ?, ?, 1, ?) ON CONFLICT(task_id) DO UPDATE SET condition = excluded.condition,
        reason_code = excluded.reason_code, since = excluded.since, revision = task_execution_conditions.revision + 1,
        next_action_at = excluded.next_action_at`, row.task_id, state, reason, now, nextActionAt);
      const correlationId = uuidv7(now);
      const payload = { intentId: row.id, taskId: row.task_id, from: current.state, to: state, reason, policyVersion };
      this.db.run("INSERT INTO recovery_events(id, intent_id, event_type, correlation_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)", uuidv7(now), row.id, eventType, correlationId, JSON.stringify(payload), now);
      const actor = "recovery-policy";
      const previousHash = String(this.db.one<Row>("SELECT event_hash FROM audit_events ORDER BY id DESC LIMIT 1")?.event_hash ?? "");
      const eventHash = digest({ actor, action: "recovery.policy.reconciled", workerId: row.worker_id, payload, previousHash, createdAt: now });
      this.db.run("INSERT INTO audit_events(event_uuid, actor, action, worker_id, payload_json, previous_hash, event_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", uuidv7(now), actor, "recovery.policy.reconciled", row.worker_id, JSON.stringify(payload), previousHash, eventHash, now);
    });
  }
}
