import { canonicalJson, sha256, uuidv7 } from "../../../../packages/contracts/src/index.ts";
import type { DispatchAction, DispatchDecision, DispatchRequestEnvelope } from "../../../../packages/contracts/src/dispatch.ts";
import { ControlPlaneDatabase } from "../db/database.ts";
import type { DispatchExecutionAdapter, DispatchRule, NormalizedMatch, SemanticRouterProvider } from "./dispatch-types.ts";
import { classifyDispatchLanguage, deterministicAbstainReason, isEligibleStandaloneText, matchDeterministic, normalizeDispatchText } from "./deterministic-router.ts";
import { DispatchPolicy } from "./dispatch-policy.ts";
import { DispatchRuleRegistry, type ReleaseManifest } from "./rule-registry.ts";
import { DispatchLearningService } from "./learning/learning-service.ts";

type Row = Record<string, any>;
type EnabledSetting = boolean | (() => boolean);
type NumericSetting = number | (() => number);

export type DispatchServiceOptions = {
  enabled?: EnabledSetting;
  semanticEnabled?: EnabledSetting;
  provider?: SemanticRouterProvider;
  adapters: readonly DispatchExecutionAdapter[];
  routingBudgetMs?: NumericSetting;
  proposalTtlMs?: number;
  now?: () => number;
};

export type DispatchCommitInput = { operationKey: string; actionHash: string; sessionRevision: number; ownershipRef: string };

function enabled(value: EnabledSetting | undefined, fallback: boolean): boolean { return typeof value === "function" ? value() : value ?? fallback; }
function numeric(value: NumericSetting | undefined, fallback: number, minimum: number, maximum: number): number {
  const resolved = typeof value === "function" ? value() : value ?? fallback;
  return Number.isFinite(resolved) ? Math.max(minimum, Math.min(maximum, Math.trunc(resolved))) : fallback;
}
function parse(value: unknown, fallback: unknown = null): any { try { return value === null || value === undefined ? fallback : JSON.parse(String(value)); } catch { return fallback; } }
function decisionId(now: number): string { return `d_${uuidv7(now)}`; }
function operationKey(subjectRef: string, ingressKey: string): string { return `op_${sha256(canonicalJson({ subjectRef, ingressKey })).slice(7, 39)}`; }
function bodyHash(request: DispatchRequestEnvelope): string { const { requestId: _traceId, ...body } = request; return sha256(canonicalJson(body)); }
function providerTimeout(): Error { const error = new Error("PROVIDER_TIMEOUT"); error.name = "TimeoutError"; return error; }
function apiAction(action: DispatchAction): Record<string, unknown> {
  return {
    ...(action.kind === undefined ? {} : { kind: action.kind }),
    operation: action.operation,
    operation_schema_version: action.operationSchemaVersion,
    logical_worker: action.logicalWorker,
    parameters: action.parameters,
  };
}
function apiExecutionResult(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const result = value as Record<string, unknown>;
  if (!("schemaVersion" in result) && !("schema_version" in result)) return value;
  return {
    schema_version: result.schema_version ?? result.schemaVersion,
    status: result.status,
    observed_at: result.observed_at ?? result.observedAt,
    source_ref: result.source_ref ?? result.sourceRef,
    service_ref: result.service_ref ?? result.serviceRef,
    message: result.message ?? null,
  };
}
function apiDecision(decision: DispatchDecision): Record<string, unknown> {
  return {
    schema_version: decision.schemaVersion,
    decision_id: decision.decisionId,
    disposition: decision.disposition,
    reason: decision.reason,
    tier_id: decision.tierId,
    rule_id: decision.ruleId,
    rule_revision: decision.ruleRevision,
    intent: decision.intent,
    action: decision.action ? apiAction(decision.action) : null,
    assurance: decision.assurance,
    calibrated_probability: decision.calibratedProbability,
    release_id: decision.releaseId,
    operation_key: decision.operationKey,
    action_hash: decision.actionHash,
    proposal_id: decision.proposalId,
    expires_at: decision.expiresAt,
    stage_latencies: decision.stageLatencies,
  };
}

export class DispatchService {
  readonly registry: DispatchRuleRegistry;
  private readonly db: ControlPlaneDatabase;
  private readonly policy: DispatchPolicy;
  private readonly provider?: SemanticRouterProvider;
  private readonly enabledSetting: EnabledSetting;
  private readonly semanticEnabledSetting: EnabledSetting;
  private readonly routingBudgetSetting: NumericSetting;
  private readonly proposalTtlMs: number;
  private readonly now: () => number;
  private readonly inFlight = new Map<string, Promise<void>>();
  readonly learning: DispatchLearningService;

  constructor(db: ControlPlaneDatabase, options: DispatchServiceOptions) {
    this.db = db;
    this.registry = new DispatchRuleRegistry(db);
    this.policy = new DispatchPolicy(db, options.adapters);
    this.provider = options.provider;
    this.enabledSetting = options.enabled ?? false;
    this.semanticEnabledSetting = options.semanticEnabled ?? false;
    this.routingBudgetSetting = options.routingBudgetMs ?? 250;
    this.proposalTtlMs = Math.max(1_000, Math.min(options.proposalTtlMs ?? 30_000, 300_000));
    this.now = options.now ?? (() => Date.now());
    this.learning = new DispatchLearningService(db);
  }

  recoverPending(): number {
    const now = this.now();
    this.db.transaction(() => {
      const executing = this.db.all<Row>("SELECT id FROM dispatch_operations WHERE status = 'EXECUTING'");
      for (const row of executing) {
        this.db.run("UPDATE dispatch_operations SET status = 'UNKNOWN', certainty = 'UNKNOWN', result_json = ?, validation_state = 'FAILED', revision = revision + 1, updated_at = ? WHERE id = ? AND status = 'EXECUTING'", JSON.stringify({ error: "RECOVERY_RECONCILIATION_REQUIRED" }), now, String(row.id));
        this.db.run("UPDATE dispatch_outbox SET ack_at = COALESCE(ack_at, ?) WHERE operation_id = ? AND event_kind = 'EXECUTE'", now, String(row.id));
      }
    });
    const rows = this.db.all<Row>("SELECT id FROM dispatch_operations WHERE status = 'ACCEPTED' ORDER BY created_at, id");
    for (const row of rows) {
      const operationId = String(row.id);
      if (this.inFlight.has(operationId)) continue;
      const promise = this.executeOperation(operationId);
      this.inFlight.set(operationId, promise);
      void promise.finally(() => this.inFlight.delete(operationId));
    }
    return rows.length;
  }

  async prepare(request: DispatchRequestEnvelope, principal = request.subjectRef): Promise<Record<string, unknown>> {
    if (principal !== request.subjectRef) throw new Error("DISPATCH_SUBJECT_MISMATCH");
    const now = this.now();
    const hash = bodyHash(request);
    const prior = this.db.one<Row>("SELECT body_hash, decision_json FROM dispatch_requests WHERE subject_ref = ? AND ingress_key = ?", request.subjectRef, request.ingressKey);
    if (prior) {
      if (String(prior.body_hash) !== hash) throw new Error("DISPATCH_REQUEST_CONFLICT");
      return parse(prior.decision_json, {});
    }
    if (!enabled(this.enabledSetting, false)) return this.storeFallback(request, hash, "DISPATCH_DISABLED", now);
    if (!request.context.standalone || request.context.pendingInteraction) return this.storeFallback(request, hash, "SESSION_INELIGIBLE", now);
    const release = this.registry.activeRelease();
    if (!release) return this.storeFallback(request, hash, "CAPABILITY_UNAVAILABLE", now);
    const languageClass = classifyDispatchLanguage(request.text);
    const rules = this.registry.rulesForRelease(release.id);
    const started = now;
    const deterministic = matchDeterministic({ text: request.text, languageClass }, rules);
    if (deterministic?.rule && deterministic.action) {
      const policy = this.policy.evaluate(request, deterministic.rule, deterministic.action, deterministic.assurance);
      if (!policy.allowed) return this.storeFallback(request, hash, policy.reason, now);
      return this.storeProposal(request, hash, release.id, deterministic.rule, deterministic.action, deterministic.assurance, null, "exact-v1", now, { tier0: this.now() - started });
    }
    const deterministicReason = deterministicAbstainReason(request.text, rules);
    if (deterministicReason) return this.storeFallback(request, hash, deterministicReason, now);
    if (!isEligibleStandaloneText(request.text)) return this.storeFallback(request, hash, "COMPLEX_REQUEST", now);
    if (enabled(this.semanticEnabledSetting, false) && this.provider) {
      if (languageClass !== "ZH_DOMINANT") return this.storeFallback(request, hash, "UNSUPPORTED_LANGUAGE", now);
      const descriptor = this.provider.describe();
      if (!release.manifest.providerBundles.includes(descriptor.bundleId)) return this.storeFallback(request, hash, "PROVIDER_UNAVAILABLE", now);
      if (descriptor.privacyLocality !== "LOCAL_ONLY") return this.storeFallback(request, hash, "PRIVACY_POLICY", now);
      if (!descriptor.supportedLanguageClasses.includes(languageClass) || Buffer.byteLength(request.text, "utf8") > descriptor.maxBytes) return this.storeFallback(request, hash, "UNSUPPORTED_LANGUAGE", now);
      const deadlineAt = Date.now() + Math.min(request.routingBudgetMs, numeric(this.routingBudgetSetting, 250, 1, 5_000));
      let readiness: { ready: boolean; reason: string };
      try {
        readiness = await this.withProviderDeadline((signal) => this.provider!.readiness(signal), deadlineAt);
      } catch (error) {
        return this.storeFallback(request, hash, error instanceof Error && error.name === "TimeoutError" ? "PROVIDER_TIMEOUT" : "PROVIDER_UNAVAILABLE", now);
      }
      if (!readiness.ready) return this.storeFallback(request, hash, "PROVIDER_UNAVAILABLE", now);
      let match: NormalizedMatch;
      try {
        match = await this.withProviderDeadline((signal) => this.provider!.match({ requestId: request.requestId, text: request.text, context: { locale: request.locale, languageClass }, candidateIntents: rules.map((rule) => rule.intent), bundleId: descriptor.bundleId, ruleSetHash: sha256(canonicalJson(release.manifest.ruleSet)), deadlineAt }, signal), deadlineAt);
      } catch (error) {
        return this.storeFallback(request, hash, error instanceof Error && error.name === "TimeoutError" ? "PROVIDER_TIMEOUT" : "PROVIDER_UNAVAILABLE", now);
      }
      if (!match || match.schemaVersion !== 1) return this.storeFallback(request, hash, "UNCALIBRATED", now);
      const rule = match.intent ? rules.find((candidate) => candidate.intent === match.intent) : undefined;
      const serviceRef = rule ? this.extractService(request.text, rule) : null;
      const releaseRuleSetHash = sha256(canonicalJson(release.manifest.ruleSet));
      const calibrationProfiles = (release.manifest as typeof release.manifest & { calibrationProfiles?: unknown }).calibrationProfiles;
      const provenance = match?.provenance;
      const provenanceValid = Boolean(provenance && typeof provenance.providerId === "string" && provenance.providerId === descriptor.providerId && provenance.modelRevision === descriptor.modelRevision && provenance.bundleId === descriptor.bundleId && provenance.runtimeRevision === descriptor.runtimeRevision && provenance.ruleSetHash === releaseRuleSetHash && typeof provenance.datasetRevision === "string" && provenance.datasetRevision.length > 0);
      const calibrationBound = Array.isArray(calibrationProfiles) && typeof match.calibrationProfileId === "string" && calibrationProfiles.includes(match.calibrationProfileId);
      const probabilityValid = typeof match.calibratedProbability === "number" && Number.isFinite(match.calibratedProbability) && match.calibratedProbability >= 0 && match.calibratedProbability <= 1;
      if (!rule || match.abstain || match.assurance !== "HIGH" || !match.calibrationProfileId || !probabilityValid || !serviceRef) return this.storeFallback(request, hash, match.reason === "" ? "LOW_CONFIDENCE" : match.reason === "UNASSESSED" ? "UNCALIBRATED" : "LOW_CONFIDENCE", now);
      if (!provenanceValid || !calibrationBound) return this.storeFallback(request, hash, "UNCALIBRATED", now);
      const action = this.actionWithService(rule, serviceRef);
      const policy = this.policy.evaluate(request, rule, action, match.assurance);
      if (!policy.allowed) return this.storeFallback(request, hash, policy.reason, now);
      return this.storeProposal(request, hash, release.id, rule, action, match.assurance, match.calibratedProbability, "semantic-v1", now, { semantic: this.now() - started });
    }
    return this.storeFallback(request, hash, languageClass === "EN_HEAVY" ? "UNSUPPORTED_LANGUAGE" : "NO_MATCH", now);
  }

  private async withProviderDeadline<T>(work: (signal: AbortSignal) => Promise<T>, deadlineAt: number): Promise<T> {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw providerTimeout();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([Promise.resolve().then(() => work(controller.signal)), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(providerTimeout()); }, remaining);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  commit(proposalId: string, input: DispatchCommitInput, principal = "owner"): Record<string, unknown> {
    if (!Number.isSafeInteger(input.sessionRevision) || input.sessionRevision < 0 || typeof input.ownershipRef !== "string" || input.ownershipRef.trim().length === 0 || input.ownershipRef.length > 500) throw new Error("INVALID_DISPATCH_COMMIT");
    const now = this.now();
    const existing = this.db.one<Row>("SELECT o.*, p.request_id, p.id AS existing_proposal_id, p.action_hash AS proposal_action_hash, r.subject_ref FROM dispatch_operations o JOIN dispatch_proposals p ON p.id = o.proposal_id JOIN dispatch_requests r ON r.id = p.request_id WHERE o.operation_key = ?", input.operationKey);
    if (existing) {
      if (String(existing.existing_proposal_id) !== proposalId || String(existing.proposal_action_hash) !== input.actionHash) throw new Error("DISPATCH_COMMIT_CONFLICT");
      if (String(existing.subject_ref) !== principal) throw new Error("DISPATCH_SUBJECT_MISMATCH");
      if (existing.ownership_ref !== null && String(existing.ownership_ref) !== input.ownershipRef) throw new Error("DISPATCH_COMMIT_CONFLICT");
      if (existing.session_revision !== null && Number(existing.session_revision) !== input.sessionRevision) throw new Error("DISPATCH_COMMIT_CONFLICT");
      return this.commitReceipt(existing);
    }
    let operationId = "";
    this.db.transaction(() => {
      const row = this.db.one<Row>("SELECT p.*, r.subject_ref, r.source_json, r.decision_json FROM dispatch_proposals p JOIN dispatch_requests r ON r.id = p.request_id WHERE p.id = ?", proposalId);
      if (!row) throw new Error("DISPATCH_PROPOSAL_NOT_FOUND");
      if (String(row.action_hash) !== input.actionHash || String(row.operation_key) !== input.operationKey) throw new Error("DISPATCH_ACTION_CONFLICT");
      const request = parse(row.source_json) as DispatchRequestEnvelope & { principal?: string };
      if (String(row.subject_ref) !== request.subjectRef || principal !== request.subjectRef) throw new Error("DISPATCH_SUBJECT_MISMATCH");
      if (Number(row.expires_at) <= now && row.status === "PREPARED") { this.db.run("UPDATE dispatch_proposals SET status = 'EXPIRED', revision = revision + 1, updated_at = ? WHERE id = ? AND status = 'PREPARED'", now, proposalId); throw new Error("DISPATCH_PROPOSAL_EXPIRED"); }
      if (row.status !== "PREPARED") throw new Error(row.status === "RELEASED" ? "DISPATCH_PROPOSAL_RELEASED" : "DISPATCH_PROPOSAL_NOT_COMMITTABLE");
      const rawDecision = parse(row.decision_json) as Record<string, any>;
      const decision = {
        disposition: rawDecision.disposition,
        ruleId: rawDecision.rule_id ?? rawDecision.ruleId,
        ruleRevision: rawDecision.rule_revision ?? rawDecision.ruleRevision,
        assurance: rawDecision.assurance,
        action: rawDecision.action ? { operation: rawDecision.action.operation, operationSchemaVersion: rawDecision.action.operation_schema_version ?? rawDecision.action.operationSchemaVersion, logicalWorker: rawDecision.action.logical_worker ?? rawDecision.action.logicalWorker, parameters: rawDecision.action.parameters ?? {} } as DispatchAction : null,
      };
      if (decision.disposition !== "PROPOSED" || !decision.ruleId || !decision.ruleRevision || !decision.action) throw new Error("DISPATCH_PROPOSAL_INVALID");
      const rule = this.registry.get(String(decision.ruleId), Number(decision.ruleRevision));
      const state = rule ? this.registry.state(rule.ruleId, rule.revision) : undefined;
      if (!rule || !state || state.state !== "ACTIVE" || this.registry.isDenied(rule.ruleId, rule.revision)) throw new Error("DISPATCH_PROPOSAL_REVOKED");
      if (request.context.sessionRevision !== input.sessionRevision) throw new Error("DISPATCH_SESSION_CHANGED");
      const policy = this.policy.evaluate(request, rule, decision.action, decision.assurance);
      if (!policy.allowed) throw new Error(`DISPATCH_${policy.reason}`);
      operationId = `dispatch-operation-${uuidv7(now)}`;
      this.db.run("UPDATE dispatch_proposals SET status = 'ACCEPTED', revision = revision + 1, updated_at = ? WHERE id = ? AND status = 'PREPARED'", now, proposalId);
      this.db.run("INSERT INTO dispatch_operations(id, proposal_id, operation_key, execution_owner, ownership_ref, session_revision, status, certainty, validation_state, delivery_state, created_at, updated_at) VALUES (?, ?, ?, 'SERVICE_ADAPTER', ?, ?, 'ACCEPTED', 'NOT_STARTED', 'NOT_REQUESTED', 'NOT_REQUESTED', ?, ?)", operationId, proposalId, input.operationKey, input.ownershipRef, input.sessionRevision, now, now);
      this.db.run("INSERT INTO dispatch_outbox(id, operation_id, event_kind, dedup_key, payload_json, available_at) VALUES (?, ?, 'EXECUTE', ?, ?, ?)", uuidv7(now), operationId, `dispatch-execute:${input.operationKey}`, JSON.stringify({ operationId, operationKey: input.operationKey }), now);
    });
    const promise = this.executeOperation(operationId);
    this.inFlight.set(operationId, promise);
    void promise.finally(() => this.inFlight.delete(operationId));
    return { schema_version: 1, operation_id: operationId, proposal_id: proposalId, operation_key: input.operationKey, status: "ACCEPTED", certainty: "NOT_STARTED", task_id: null };
  }

  resolveToHermes(proposalId: string, input: { operationKey: string; actionHash: string }, principal = "owner"): Record<string, unknown> {
    const now = this.now();
    return this.db.transaction(() => {
      const row = this.db.one<Row>("SELECT p.*, r.subject_ref FROM dispatch_proposals p JOIN dispatch_requests r ON r.id = p.request_id WHERE p.id = ?", proposalId);
      if (!row) throw new Error("DISPATCH_PROPOSAL_NOT_FOUND");
      if (String(row.operation_key) !== input.operationKey || String(row.action_hash) !== input.actionHash) throw new Error("DISPATCH_ACTION_CONFLICT");
      if (principal !== String(row.subject_ref)) throw new Error("DISPATCH_SUBJECT_MISMATCH");
      if (row.status === "ACCEPTED") throw new Error("DISPATCH_ALREADY_ACCEPTED");
      if (row.status === "RELEASED") return { schema_version: 1, proposal_id: proposalId, operation_key: input.operationKey, disposition: "NOT_STARTED_RELEASED", status: "RELEASED" };
      if (row.status !== "PREPARED") throw new Error("DISPATCH_PROPOSAL_NOT_RESOLVABLE");
      this.db.run("UPDATE dispatch_proposals SET status = 'RELEASED', revision = revision + 1, updated_at = ? WHERE id = ? AND status = 'PREPARED'", now, proposalId);
      return { schema_version: 1, proposal_id: proposalId, operation_key: input.operationKey, disposition: "NOT_STARTED_RELEASED", status: "RELEASED" };
    });
  }

  getRequest(subjectRef: string, ingressKey: string): Record<string, unknown> | undefined {
    const row = this.db.one<Row>("SELECT r.*, p.id AS proposal_id, p.action_json, p.action_hash, p.operation_key, p.status AS proposal_status, p.expires_at, o.id AS operation_id, o.status AS operation_status, o.certainty, o.result_json, o.validation_state, o.delivery_state FROM dispatch_requests r LEFT JOIN dispatch_proposals p ON p.request_id = r.id LEFT JOIN dispatch_operations o ON o.proposal_id = p.id WHERE r.subject_ref = ? AND r.ingress_key = ?", subjectRef, ingressKey);
    if (!row) return undefined;
    const action = row.action_json ? parse(row.action_json) as DispatchAction : null;
    return { request_id: row.id, subject_ref: row.subject_ref, ingress_key: row.ingress_key, decision: parse(row.decision_json), proposal: row.proposal_id ? { proposal_id: row.proposal_id, action: action ? apiAction(action) : null, action_hash: row.action_hash, operation_key: row.operation_key, status: row.proposal_status, expires_at: row.expires_at ? new Date(Number(row.expires_at)).toISOString() : null } : null, operation: row.operation_id ? { operation_id: row.operation_id, status: row.operation_status, certainty: row.certainty, result: apiExecutionResult(parse(row.result_json)), validation_state: row.validation_state, delivery_state: row.delivery_state } : null };
  }

  observe(input: { sourceEventKey: string; ingressKey?: string; requestId?: string; actualActions: DispatchAction[]; outcome: string; evidenceRef?: string; occurredAt?: number }): Record<string, unknown> {
    if (input.actualActions.length !== 1) throw new Error("DISPATCH_OBSERVATION_NOT_SINGLE_ACTION");
    const action = input.actualActions[0];
    return this.learning.observe(action, input.outcome, input.sourceEventKey, input.requestId, input.evidenceRef, input.occurredAt ?? this.now());
  }

  rules(): unknown[] { return this.registry.list(); }
  createCandidate(rule: DispatchRule, actor: string, evidenceRefs: string[] = []): unknown { return this.registry.createCandidate(rule, actor, evidenceRefs, this.now()); }
  transition(ruleId: string, revision: number, to: any, expectedStateRevision: number, actor: string, reason: string, evidenceRef?: string): unknown { return this.registry.transition(ruleId, revision, to, expectedStateRevision, actor, reason, evidenceRef, this.now()); }
  createRelease(manifest: ReleaseManifest, actor: string): unknown { return this.registry.createRelease(manifest, actor, undefined, this.now()); }
  activateRelease(id: string, expectedRevision: number, actor: string): unknown { return this.registry.activateRelease(id, expectedRevision, actor, this.now()); }

  private async executeOperation(operationId: string): Promise<void> {
    const row = this.db.one<Row>("SELECT o.*, p.action_json FROM dispatch_operations o JOIN dispatch_proposals p ON p.id = o.proposal_id WHERE o.id = ?", operationId);
    if (!row || !["ACCEPTED", "EXECUTING"].includes(String(row.status))) return;
    this.db.run("UPDATE dispatch_operations SET status = 'EXECUTING', certainty = 'KNOWN', revision = revision + 1, updated_at = ? WHERE id = ? AND status IN ('ACCEPTED', 'EXECUTING')", this.now(), operationId);
    const action = parse(row.action_json) as DispatchAction;
    const adapter = this.policy.adapter(action.operation);
    if (!adapter) { this.finishOperation(operationId, "FAILED", "KNOWN", null, "ADAPTER_UNAVAILABLE"); return; }
    try {
      const result = await adapter.execute(action, String(row.operation_key), AbortSignal.timeout(5_000));
      const validated = this.validateExecutionResult(result, action);
      this.finishOperation(operationId, "SUCCEEDED", "KNOWN", validated, null);
    } catch (error) {
      const unknown = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      this.finishOperation(operationId, unknown ? "UNKNOWN" : "FAILED", unknown ? "UNKNOWN" : "KNOWN", null, error instanceof Error ? error.message.slice(0, 160) : "DISPATCH_EXECUTION_FAILED");
    }
  }

  private validateExecutionResult(value: unknown, action: DispatchAction): import("./dispatch-types.ts").ExecutionResult {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("RESULT_SCHEMA_INVALID");
    const result = value as Record<string, unknown>;
    if (result.schemaVersion !== 1 || !["HEALTHY", "DEGRADED", "OFFLINE", "UNKNOWN"].includes(String(result.status)) || typeof result.observedAt !== "string" || !Number.isFinite(Date.parse(result.observedAt)) || typeof result.sourceRef !== "string" || result.sourceRef.length === 0 || result.sourceRef.length > 500 || result.serviceRef !== action.parameters.service_ref || (result.message !== null && typeof result.message !== "string")) throw new Error("RESULT_SCHEMA_INVALID");
    return { schemaVersion: 1, status: result.status as import("./dispatch-types.ts").ExecutionResult["status"], observedAt: result.observedAt, sourceRef: result.sourceRef, serviceRef: String(result.serviceRef), message: result.message as string | null };
  }

  private finishOperation(operationId: string, status: "SUCCEEDED" | "FAILED" | "UNKNOWN", certainty: "KNOWN" | "UNKNOWN", result: unknown, error: string | null): void {
    this.db.transaction(() => {
      this.db.run("UPDATE dispatch_operations SET status = ?, certainty = ?, result_json = ?, validation_state = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND status IN ('ACCEPTED', 'EXECUTING')", status, certainty, result === null ? JSON.stringify(error ? { error } : null) : JSON.stringify(result), status === "SUCCEEDED" ? "VALIDATED" : "FAILED", this.now(), operationId);
      this.db.run("UPDATE dispatch_outbox SET ack_at = ? WHERE operation_id = ? AND event_kind = 'EXECUTE' AND ack_at IS NULL", this.now(), operationId);
    });
  }

  private storeFallback(request: DispatchRequestEnvelope, hash: string, reason: string, now: number): Record<string, unknown> {
    const decision: DispatchDecision = { schemaVersion: 1, decisionId: decisionId(now), disposition: "FALLBACK", reason, tierId: null, ruleId: null, ruleRevision: null, intent: null, action: null, assurance: "UNASSESSED", calibratedProbability: null, releaseId: this.registry.activeRelease()?.id ?? null, operationKey: null, actionHash: null, proposalId: null, expiresAt: null, stageLatencies: { total: this.now() - now } };
    const output = apiDecision(decision);
    try {
      this.db.run("INSERT INTO dispatch_requests(id, subject_ref, ingress_key, body_hash, source_json, decision_json, release_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", decision.decisionId, request.subjectRef, request.ingressKey, hash, JSON.stringify(request), JSON.stringify(output), decision.releaseId, now);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("UNIQUE")) throw error;
      const prior = this.db.one<Row>("SELECT body_hash, decision_json FROM dispatch_requests WHERE subject_ref = ? AND ingress_key = ?", request.subjectRef, request.ingressKey);
      if (!prior || String(prior.body_hash) !== hash) throw new Error("DISPATCH_REQUEST_CONFLICT");
      return parse(prior.decision_json, {});
    }
    return output;
  }

  private storeProposal(request: DispatchRequestEnvelope, hash: string, releaseId: string, rule: DispatchRule, action: DispatchAction, assurance: "UNASSESSED" | "HIGH", probability: number | null, tierId: string, now: number, stageLatencies: Record<string, number>): Record<string, unknown> {
    const id = decisionId(now); const proposalId = `p_${uuidv7(now)}`; const opKey = operationKey(request.subjectRef, request.ingressKey); const expiresAt = now + this.proposalTtlMs; const actionHash = sha256(canonicalJson(action));
    const decision: DispatchDecision = { schemaVersion: 1, decisionId: id, disposition: "PROPOSED", reason: tierId === "exact-v1" ? "DETERMINISTIC_MATCH" : "CALIBRATED_MATCH", tierId, ruleId: rule.ruleId, ruleRevision: rule.revision, intent: rule.intent, action, assurance, calibratedProbability: probability, releaseId, operationKey: opKey, actionHash, proposalId, expiresAt: new Date(expiresAt).toISOString(), stageLatencies: { ...stageLatencies, total: this.now() - now } };
    const output = apiDecision(decision);
    try {
      this.db.transaction(() => {
        this.db.run("INSERT INTO dispatch_requests(id, subject_ref, ingress_key, body_hash, source_json, decision_json, release_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", id, request.subjectRef, request.ingressKey, hash, JSON.stringify(request), JSON.stringify(output), releaseId, now);
        this.db.run("INSERT INTO dispatch_proposals(id, request_id, action_json, action_hash, operation_key, status, revision, expires_at, release_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'PREPARED', 1, ?, ?, ?, ?)", proposalId, id, canonicalJson(action), actionHash, opKey, expiresAt, releaseId, now, now);
      });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("UNIQUE")) throw error;
      const prior = this.db.one<Row>("SELECT body_hash, decision_json FROM dispatch_requests WHERE subject_ref = ? AND ingress_key = ?", request.subjectRef, request.ingressKey);
      if (!prior || String(prior.body_hash) !== hash) throw new Error("DISPATCH_REQUEST_CONFLICT");
      return parse(prior.decision_json, {});
    }
    return output;
  }

  private actionWithService(rule: DispatchRule, serviceRef: string): DispatchAction {
    return { ...rule.action, parameters: Object.fromEntries(Object.entries(rule.action.parameters).map(([key, value]) => [key, value === "$slot.service" ? serviceRef : value])) };
  }

  private extractService(text: string, rule: DispatchRule): string | null {
    const normalized = normalizeDispatchText(text);
    const aliases: Array<[string, string]> = [];
    for (const value of Object.values(rule.slots).flatMap((slot) => slot.allowedValues)) {
      aliases.push([normalizeDispatchText(value), value]);
      if (value === "contexthub") aliases.push(["context hub", value]);
      if (value === "information-radar") aliases.push(["information radar", value], ["informationradar", value], ["radar", value]);
    }
    const matches = aliases.filter(([alias]) => normalized.includes(alias));
    return matches.length === 1 ? matches[0][1] : null;
  }

  private commitReceipt(row: Row): Record<string, unknown> { return { schema_version: 1, operation_id: row.id, proposal_id: row.proposal_id, operation_key: row.operation_key, status: row.status, certainty: row.certainty, task_id: row.task_id ?? null }; }
}
