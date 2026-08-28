import { canonicalJson, sha256, uuidv7, type JsonValue } from "../../../packages/crypto/src/index.ts";
import { OrchestratorDatabase } from "./db.ts";

export type ProactiveTrigger = { triggerId: string; source: string; domain: string; dedupeKey: string; observedAt: string; evidenceRefs: string[]; recommendedMode: "NOTIFY" | "INVESTIGATE" };
export type TriggerObservation = { source: string; domain: string; observedAt: string; evidenceRefs: string[]; recommendedMode: ProactiveTrigger["recommendedMode"]; payload?: Record<string, JsonValue> };

export class ProactiveService {
  private readonly db: OrchestratorDatabase;
  private readonly clock: () => number;
  constructor(db: OrchestratorDatabase, clock: () => number = Date.now) { this.db = db; this.clock = clock; }

  observe(input: TriggerObservation, submitGoal: (input: { intent: string; source: { kind: "proactive"; correlationId: string }; scope: string[] }) => string | undefined): ProactiveTrigger {
    if (!input.source || !input.domain || !input.observedAt || !["NOTIFY", "INVESTIGATE"].includes(input.recommendedMode)) throw new Error("proactive trigger is invalid");
    const dedupeKey = sha256(canonicalJson({ source: input.source, domain: input.domain, evidenceRefs: input.evidenceRefs, payload: input.payload ?? {} } as unknown as JsonValue));
    const existing = this.db.one<{ id: string; source: string; domain: string; dedupe_key: string; evidence_json: string; disposition: string; goal_id: string | null; observed_at: number }>("SELECT * FROM proactive_triggers WHERE dedupe_key = ?", dedupeKey);
    if (existing) return { triggerId: existing.id, source: existing.source, domain: existing.domain, dedupeKey: existing.dedupe_key, observedAt: new Date(existing.observed_at).toISOString(), evidenceRefs: JSON.parse(existing.evidence_json), recommendedMode: existing.disposition === "GOAL_CREATED" ? "INVESTIGATE" : "NOTIFY" };
    const now = this.clock();
    const id = uuidv7(now);
    const goalId = input.recommendedMode === "INVESTIGATE" ? submitGoal({ intent: `Investigate proactive trigger ${input.domain}`, source: { kind: "proactive", correlationId: id }, scope: [`domain:${input.domain}`] }) : undefined;
    const disposition = goalId ? "GOAL_CREATED" : "NOTIFY";
    this.db.run("INSERT INTO proactive_triggers(id, source, domain, dedupe_key, evidence_json, disposition, goal_id, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", id, input.source, input.domain, dedupeKey, JSON.stringify(input.evidenceRefs), disposition, goalId ?? null, now);
    return { triggerId: id, source: input.source, domain: input.domain, dedupeKey, observedAt: new Date(now).toISOString(), evidenceRefs: [...input.evidenceRefs], recommendedMode: input.recommendedMode };
  }
}

export type CapabilityProposal = { id: string; status: "PROPOSED" | "DEVELOPMENT_APPROVED" | "IMPLEMENTED" | "RELEASED" | "DEPLOYED" | "GRANTED"; targetRepository: string; blockedGoalId: string | null; blockedTaskId: string | null };

export class CapabilityProposalService {
  private readonly db: OrchestratorDatabase;
  private readonly clock: () => number;
  constructor(db: OrchestratorDatabase, clock: () => number = Date.now) { this.db = db; this.clock = clock; }
  propose(input: { blockedGoalId?: string | null; blockedTaskId?: string | null; targetRepository: string; contract: Record<string, unknown>; permissions: Record<string, unknown>; estimate: Record<string, unknown>; risk: Record<string, unknown>; tests: Record<string, unknown>; release: Record<string, unknown> }): CapabilityProposal {
    if (!input.targetRepository || !input.contract || !input.permissions || !input.estimate || !input.risk || !input.tests || !input.release) throw new Error("capability proposal is incomplete");
    const id = uuidv7(this.clock());
    this.db.run("INSERT INTO capability_proposals(id, blocked_goal_id, blocked_task_id, target_repository, contract_json, permission_json, estimate_json, risk_json, test_json, release_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PROPOSED', ?, ?)", id, input.blockedGoalId ?? null, input.blockedTaskId ?? null, input.targetRepository, JSON.stringify(input.contract), JSON.stringify(input.permissions), JSON.stringify(input.estimate), JSON.stringify(input.risk), JSON.stringify(input.tests), JSON.stringify(input.release), this.clock(), this.clock());
    return this.get(id)!;
  }
  approveDevelopment(id: string, approver: string): CapabilityProposal {
    if (!approver) throw new Error("explicit development approval is required");
    this.db.run("UPDATE capability_proposals SET status = 'DEVELOPMENT_APPROVED', updated_at = ? WHERE id = ? AND status = 'PROPOSED'", this.clock(), id);
    return this.get(id)!;
  }
  advance(id: string, next: Exclude<CapabilityProposal["status"], "PROPOSED" | "DEVELOPMENT_APPROVED">): CapabilityProposal {
    const current = this.get(id);
    if (!current || current.status === "PROPOSED") throw new Error("proposal requires explicit development approval");
    const allowed: Record<string, string[]> = { DEVELOPMENT_APPROVED: ["IMPLEMENTED"], IMPLEMENTED: ["RELEASED"], RELEASED: ["DEPLOYED"], DEPLOYED: ["GRANTED"], GRANTED: [] };
    if (!allowed[current.status].includes(next)) throw new Error("capability gate order is invalid");
    this.db.run("UPDATE capability_proposals SET status = ?, updated_at = ? WHERE id = ?", next, this.clock(), id);
    return this.get(id)!;
  }
  get(id: string): CapabilityProposal | undefined {
    const row = this.db.one<Record<string, unknown>>("SELECT id, status, target_repository, blocked_goal_id, blocked_task_id FROM capability_proposals WHERE id = ?", id);
    return row ? { id: String(row.id), status: row.status as CapabilityProposal["status"], targetRepository: String(row.target_repository), blockedGoalId: row.blocked_goal_id === null ? null : String(row.blocked_goal_id), blockedTaskId: row.blocked_task_id === null ? null : String(row.blocked_task_id) } : undefined;
  }
}
