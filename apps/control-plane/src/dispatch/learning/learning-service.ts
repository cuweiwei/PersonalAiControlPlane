import { ControlPlaneDatabase } from "../../db/database.ts";
import type { DispatchAction } from "../../dispatch/dispatch-types.ts";
import { actionSignature } from "../../dispatch/deterministic-router.ts";
import { canonicalJson, sha256, uuidv7 } from "../../../../../packages/contracts/src/index.ts";

type Row = Record<string, any>;

/** Bounded, statistics-only learning surface. It recommends candidates; it never promotes or executes them. */
export class DispatchLearningService {
  private readonly db: ControlPlaneDatabase;
  constructor(db: ControlPlaneDatabase) { this.db = db; }

  recommendations(now = Date.now()): Array<{ actionSignature: string; count: number; firstObservedAt: number; lastObservedAt: number; distinctDays: number }> {
    const rows = this.db.all<Row>("SELECT action_signature, COUNT(*) AS count, MIN(occurred_at) AS first_observed_at, MAX(occurred_at) AS last_observed_at, COUNT(DISTINCT date(occurred_at / 1000, 'unixepoch')) AS distinct_days FROM dispatch_observations WHERE outcome = 'SUCCEEDED' AND occurred_at >= ? GROUP BY action_signature HAVING COUNT(*) >= 5 ORDER BY count DESC, action_signature", now - 14 * 86_400_000);
    return rows.filter((row) => Number(row.distinct_days) >= 2).map((row) => ({ actionSignature: String(row.action_signature), count: Number(row.count), firstObservedAt: Number(row.first_observed_at), lastObservedAt: Number(row.last_observed_at), distinctDays: Number(row.distinct_days) }));
  }

  observe(action: DispatchAction, outcome: string, sourceEventKey: string, requestId?: string, evidenceRef?: string, occurredAt = Date.now()): Record<string, unknown> {
    if (!sourceEventKey.trim()) throw new Error("DISPATCH_OBSERVATION_SOURCE_INVALID");
    const actionJson = canonicalJson(action);
    const actionHash = sha256(actionJson);
    const signature = actionSignature(action);
    const id = `observation-${uuidv7(occurredAt)}`;
    try {
      this.db.run("INSERT INTO dispatch_observations(id, source_event_key, request_id, actual_action_json, actual_action_hash, action_signature, outcome, evidence_ref, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", id, sourceEventKey, requestId ?? null, actionJson, actionHash, signature, outcome, evidenceRef ?? null, occurredAt);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("UNIQUE")) throw error;
      const existing = this.db.one<Row>("SELECT id, actual_action_hash FROM dispatch_observations WHERE source_event_key = ?", sourceEventKey);
      if (existing && String(existing.actual_action_hash) !== actionHash) throw new Error("DISPATCH_OBSERVATION_CONFLICT");
      return { observation_id: existing?.id, replayed: true, action_signature: signature };
    }
    return { observation_id: id, replayed: false, action_signature: signature };
  }

  /** Store a candidate prediction for shadow comparison. This method has no execution adapter and cannot commit work. */
  recordShadowPrediction(input: { requestId: string; candidateRuleId: string; candidateRevision: number; releaseId: string; predictedAction: DispatchAction; latencyMs?: number; createdAt?: number }): Record<string, unknown> {
    const createdAt = input.createdAt ?? Date.now();
    const predictedActionHash = sha256(canonicalJson(input.predictedAction));
    const existing = this.db.one<Row>("SELECT id, predicted_action_hash FROM dispatch_shadow_results WHERE request_id = ? AND candidate_rule_id = ? AND candidate_revision = ? AND release_id = ?", input.requestId, input.candidateRuleId, input.candidateRevision, input.releaseId);
    if (existing) {
      if (String(existing.predicted_action_hash) !== predictedActionHash) throw new Error("DISPATCH_SHADOW_CONFLICT");
      const current = this.db.one<Row>("SELECT comparison FROM dispatch_shadow_results WHERE id = ?", existing.id);
      return { shadow_id: existing.id, predicted_action_hash: predictedActionHash, replayed: true, comparison: String(current?.comparison ?? "PENDING") };
    }
    const state = this.db.one<Row>("SELECT state FROM dispatch_rule_states WHERE rule_id = ? AND revision = ?", input.candidateRuleId, input.candidateRevision);
    if (!state || String(state.state) !== "SHADOW") throw new Error("DISPATCH_SHADOW_RULE_NOT_ACTIVE");
    const candidate = this.db.one<Row>("SELECT body_json FROM dispatch_rule_revisions WHERE rule_id = ? AND revision = ?", input.candidateRuleId, input.candidateRevision);
    const candidateAction = candidate ? (JSON.parse(String(candidate.body_json)) as { action?: DispatchAction }).action : undefined;
    const candidateParameters = candidateAction?.parameters;
    const predictedParameters = input.predictedAction.parameters;
    const staticParametersMatch = candidateParameters && predictedParameters && Object.keys(candidateParameters).sort().every((key) => {
      const expected = candidateParameters[key];
      return typeof expected !== "string" || expected.startsWith("$slot.") || predictedParameters[key] === expected;
    });
    if (!candidateAction || candidateAction.operation !== input.predictedAction.operation || candidateAction.operationSchemaVersion !== input.predictedAction.operationSchemaVersion || candidateAction.logicalWorker !== input.predictedAction.logicalWorker || !candidateParameters || !predictedParameters || JSON.stringify(Object.keys(candidateParameters).sort()) !== JSON.stringify(Object.keys(predictedParameters).sort()) || !staticParametersMatch) throw new Error("DISPATCH_SHADOW_ACTION_CONFLICT");
    if (!this.db.one("SELECT id FROM dispatch_releases WHERE id = ?", input.releaseId)) throw new Error("DISPATCH_RELEASE_NOT_FOUND");
    const id = `shadow-${uuidv7(createdAt)}`;
    this.db.run("INSERT INTO dispatch_shadow_results(id, request_id, candidate_rule_id, candidate_revision, release_id, predicted_action_hash, comparison, latency_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)", id, input.requestId, input.candidateRuleId, input.candidateRevision, input.releaseId, predictedActionHash, input.latencyMs ?? null, createdAt);
    return { shadow_id: id, predicted_action_hash: predictedActionHash, replayed: false, comparison: "PENDING" };
  }

  /** Join one shadow prediction with an independently recorded structured observation. */
  compareShadowPrediction(input: { shadowId: string; observationId?: string }): Record<string, unknown> {
    const shadow = this.db.one<Row>("SELECT * FROM dispatch_shadow_results WHERE id = ?", input.shadowId);
    if (!shadow) throw new Error("DISPATCH_SHADOW_NOT_FOUND");
    if (shadow.observation_id !== null) {
      if (input.observationId && String(shadow.observation_id) !== input.observationId) throw new Error("DISPATCH_SHADOW_COMPARISON_CONFLICT");
      return { shadow_id: input.shadowId, comparison: String(shadow.comparison), observation_id: shadow.observation_id };
    }
    const observation = input.observationId
      ? this.db.one<Row>("SELECT * FROM dispatch_observations WHERE id = ?", input.observationId)
      : this.db.one<Row>("SELECT * FROM dispatch_observations WHERE request_id = ? ORDER BY occurred_at DESC, id DESC LIMIT 1", String(shadow.request_id));
    if (!observation) {
      this.db.run("UPDATE dispatch_shadow_results SET comparison = 'MISSING', observation_id = NULL WHERE id = ?", input.shadowId);
      return { shadow_id: input.shadowId, comparison: "MISSING", observation_id: null };
    }
    if (String(observation.request_id ?? "") !== String(shadow.request_id)) throw new Error("DISPATCH_SHADOW_OBSERVATION_CONFLICT");
    const comparison = String(observation.outcome) !== "SUCCEEDED" ? "UNVERIFIABLE" : String(observation.actual_action_hash) === String(shadow.predicted_action_hash) ? "MATCH" : "MISMATCH";
    this.db.run("UPDATE dispatch_shadow_results SET comparison = ?, observation_id = ? WHERE id = ?", comparison, observation.id, input.shadowId);
    return { shadow_id: input.shadowId, comparison, observation_id: observation.id };
  }

  recordLabel(input: { observationId: string; label: "CORRECT" | "INCORRECT" | "UNVERIFIABLE"; source: string; reviewer?: string; evidenceRef?: string; createdAt?: number }): Record<string, unknown> {
    const source = input.source.trim();
    if (!source || source.toLowerCase() === "model" || !["CORRECT", "INCORRECT", "UNVERIFIABLE"].includes(input.label)) throw new Error("DISPATCH_LABEL_SOURCE_INVALID");
    if (!this.db.one("SELECT id FROM dispatch_observations WHERE id = ?", input.observationId)) throw new Error("DISPATCH_OBSERVATION_NOT_FOUND");
    if ((input.label === "CORRECT" || input.label === "INCORRECT") && (!input.evidenceRef?.trim() || !input.reviewer?.trim())) throw new Error("DISPATCH_LABEL_EVIDENCE_REQUIRED");
    const id = `label-${uuidv7(input.createdAt ?? Date.now())}`;
    this.db.run("INSERT INTO dispatch_labels(id, observation_id, label, source, reviewer, evidence_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", id, input.observationId, input.label, source, input.reviewer?.trim() ?? null, input.evidenceRef?.trim() ?? null, input.createdAt ?? Date.now());
    return { label_id: id, observation_id: input.observationId, label: input.label, replayed: false };
  }

  /** Evaluate promotion evidence only; it records a report and never changes rule state. */
  evaluatePromotion(input: { ruleId: string; revision: number; releaseId: string; datasetRef: string; datasetHash: string; splitManifest: Record<string, unknown>; reportRef: string; now?: number; minimumShadow?: number; minimumDistinctDays?: number }): Record<string, unknown> {
    const now = input.now ?? Date.now();
    const minimumShadow = input.minimumShadow ?? 30;
    const minimumDistinctDays = input.minimumDistinctDays ?? 7;
    if (!Number.isInteger(minimumShadow) || minimumShadow < 1 || !Number.isInteger(minimumDistinctDays) || minimumDistinctDays < 1) throw new Error("DISPATCH_EVALUATION_THRESHOLD_INVALID");
    if (!this.db.one("SELECT id FROM dispatch_releases WHERE id = ?", input.releaseId)) throw new Error("DISPATCH_RELEASE_NOT_FOUND");
    const state = this.db.one<Row>("SELECT state FROM dispatch_rule_states WHERE rule_id = ? AND revision = ?", input.ruleId, input.revision);
    if (!state || String(state.state) !== "SHADOW") throw new Error("DISPATCH_PROMOTION_RULE_NOT_SHADOW");
    if (!/^sha256:[a-f0-9]{64}$/.test(input.datasetHash) || !input.datasetRef.trim() || !input.reportRef.trim() || !input.splitManifest || typeof input.splitManifest !== "object" || Array.isArray(input.splitManifest)) throw new Error("DISPATCH_EVALUATION_EVIDENCE_INVALID");
    const rows = this.db.all<Row>("SELECT s.*, o.occurred_at FROM dispatch_shadow_results s LEFT JOIN dispatch_observations o ON o.id = s.observation_id WHERE s.candidate_rule_id = ? AND s.candidate_revision = ? AND s.release_id = ?", input.ruleId, input.revision, input.releaseId);
    const matches = rows.filter((row) => row.comparison === "MATCH");
    const mismatches = rows.filter((row) => row.comparison === "MISMATCH");
    const unverifiable = rows.filter((row) => ["UNVERIFIABLE", "MISSING", "PENDING"].includes(String(row.comparison)));
    const distinctDays = new Set(matches.filter((row) => row.occurred_at !== null).map((row) => Math.floor(Number(row.occurred_at) / 86_400_000))).size;
    const labeledCorrect = this.db.all<Row>("SELECT DISTINCT s.observation_id FROM dispatch_shadow_results s JOIN dispatch_labels l ON l.observation_id = s.observation_id WHERE s.candidate_rule_id = ? AND s.candidate_revision = ? AND s.release_id = ? AND s.comparison = 'MATCH' AND l.label = 'CORRECT' AND lower(trim(l.source)) <> 'model'", input.ruleId, input.revision, input.releaseId).length;
    const conflictingLabels = this.db.all<Row>("SELECT l.observation_id FROM dispatch_shadow_results s JOIN dispatch_labels l ON l.observation_id = s.observation_id WHERE s.candidate_rule_id = ? AND s.candidate_revision = ? AND s.release_id = ? AND l.label IN ('CORRECT', 'INCORRECT') AND lower(trim(l.source)) <> 'model' GROUP BY l.observation_id HAVING COUNT(DISTINCT l.label) > 1", input.ruleId, input.revision, input.releaseId).length;
    const eligible = rows.length >= minimumShadow && matches.length >= minimumShadow && distinctDays >= minimumDistinctDays && mismatches.length === 0 && unverifiable.length === 0 && conflictingLabels === 0 && labeledCorrect === matches.length;
    const reason = eligible ? "PROMOTION_EVIDENCE_ACCEPTED" : "PROMOTION_EVIDENCE_INSUFFICIENT";
    const id = `evaluation-${uuidv7(now)}`;
    this.db.run("INSERT INTO dispatch_evaluations(id, kind, dataset_ref, dataset_hash, split_manifest_json, bundle_id, report_ref, state, created_at) VALUES (?, 'PROMOTION', ?, ?, ?, ?, ?, ?, ?)", id, input.datasetRef.trim(), input.datasetHash, canonicalJson(input.splitManifest), input.releaseId, input.reportRef.trim(), eligible ? "ELIGIBLE" : "REJECTED", now);
    return { evaluation_id: id, eligible, state: eligible ? "ELIGIBLE" : "REJECTED", reason, metrics: { shadow_count: rows.length, match_count: matches.length, mismatch_count: mismatches.length, unverifiable_count: unverifiable.length, conflicting_label_count: conflictingLabels, distinct_days: distinctDays, independently_labeled_correct: labeledCorrect, minimum_shadow: minimumShadow, minimum_distinct_days: minimumDistinctDays } };
  }

  assessDegradation(input: { ruleId: string; revision: number; releaseId: string; now?: number; windowSize?: number }): Record<string, unknown> {
    const windowSize = input.windowSize ?? 20;
    if (!Number.isInteger(windowSize) || windowSize < 1 || windowSize > 1000) throw new Error("DISPATCH_DEGRADATION_WINDOW_INVALID");
    const rows = this.db.all<Row>("SELECT s.*, l.label, l.source FROM dispatch_shadow_results s LEFT JOIN dispatch_labels l ON l.observation_id = s.observation_id WHERE s.candidate_rule_id = ? AND s.candidate_revision = ? AND s.release_id = ? ORDER BY s.created_at DESC LIMIT ?", input.ruleId, input.revision, input.releaseId, windowSize);
    const confirmedFalse = rows.some((row) => row.comparison === "MISMATCH" && row.label === "INCORRECT" && row.source !== "model");
    const failures = rows.filter((row) => ["MISMATCH", "UNVERIFIABLE"].includes(String(row.comparison))).length;
    const action = confirmedFalse ? "DISABLE" : failures >= 3 ? "SHADOW" : "KEEP";
    return { rule_id: input.ruleId, revision: input.revision, release_id: input.releaseId, action, confirmed_false_dispatch: confirmedFalse, failure_count: failures, sample_count: rows.length, reason: confirmedFalse ? "CONFIRMED_FALSE_DISPATCH" : failures >= 3 ? "RECENT_FAILURE_RATE" : "WITHIN_BASELINE" };
  }
}
