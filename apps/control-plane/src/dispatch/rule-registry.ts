import { canonicalJson, sha256, uuidv7 } from "../../../../packages/contracts/src/index.ts";
import { ControlPlaneDatabase } from "../db/database.ts";
import type { DispatchRule, RuleState } from "./dispatch-types.ts";

type Row = Record<string, any>;
type ReleaseManifest = {
  schemaVersion: 1;
  ruleSet: Array<{ ruleId: string; revision: number; bodyHash: string }>;
  tierIds: string[];
  providerBundles: string[];
  calibrationProfiles?: string[];
  policyRevision: number;
  rendererCompatibility: string[];
};

const transitions: Record<RuleState, RuleState[]> = {
  CANDIDATE: ["SHADOW", "ARCHIVED"],
  SHADOW: ["ACTIVE", "DISABLED", "ARCHIVED"],
  ACTIVE: ["SHADOW", "DISABLED"],
  DISABLED: ["SHADOW", "ARCHIVED"],
  ARCHIVED: [],
};

function parseRule(value: string): DispatchRule { return JSON.parse(value) as DispatchRule; }
function parseManifest(value: string): ReleaseManifest { return JSON.parse(value) as ReleaseManifest; }

export class DispatchRuleRegistry {
  private readonly db: ControlPlaneDatabase;
  constructor(db: ControlPlaneDatabase) { this.db = db; this.seedFoundation(); }

  private seedFoundation(now = Date.now()): void {
    const existing = this.db.one<{ id: string }>("SELECT id FROM dispatch_rules WHERE id = ?", "service-health-check");
    if (!existing) {
      const rule = this.foundationRule();
      const body = canonicalJson(rule);
      const hash = sha256(body);
      this.db.transaction(() => {
        this.db.run("INSERT INTO dispatch_rules(id, current_revision, created_by, created_at) VALUES (?, ?, ?, ?)", rule.ruleId, rule.revision, "system", now);
        this.db.run("INSERT INTO dispatch_rule_revisions(rule_id, revision, body_json, body_hash, origin, evidence_refs_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", rule.ruleId, rule.revision, body, hash, rule.provenance.origin, JSON.stringify(rule.provenance.evidenceRefs), now);
        this.db.run("INSERT INTO dispatch_rule_states(rule_id, revision, state, state_revision, last_evaluated_at) VALUES (?, ?, 'ACTIVE', 1, NULL)", rule.ruleId, rule.revision);
        this.db.run("INSERT INTO dispatch_rule_events(id, rule_id, revision, from_state, to_state, actor, reason, policy_revision, created_at) VALUES (?, ?, ?, NULL, 'ACTIVE', 'system', 'FOUNDATION_RULE', 1, ?)", uuidv7(now), rule.ruleId, rule.revision, now);
      });
    }
    if (!this.activeRelease()) this.createFoundationRelease(now);
  }

  private foundationRule(): DispatchRule {
    return {
      schemaVersion: 1,
      ruleId: "service-health-check",
      revision: 1,
      intent: "service.health_check",
      match: {
        exact: ["{service} status", "{service} health"],
        aliases: ["check {service} health", "{service} 還活著嗎"],
        semantic: { examples: ["{service} 還活著嗎？", "幫我 check {service} status"], negativeExamples: ["{service} 為什麼一直 restart", "不要查 {service} status"] },
      },
      slots: { service: { type: "service_ref", required: true, extractor: "known_service_v1", allowedValues: ["contexthub", "hermes", "information-radar"] } },
      action: { kind: "single_operation", operation: "service.health_check", operationSchemaVersion: 1, logicalWorker: "control-plane-health", parameters: { service_ref: "$slot.service" } },
      risk: { declaredEffect: "READ_ONLY", requiredAssurance: "HIGH" },
      response: { templateId: "service-health-v1", resultSchemaVersion: 1 },
      provenance: { origin: "curated", evidenceRefs: [] },
    };
  }

  private createFoundationRelease(now: number): void {
    const rule = this.get("service-health-check", 1)!;
    const manifest: ReleaseManifest = { schemaVersion: 1, ruleSet: [{ ruleId: rule.ruleId, revision: rule.revision, bodyHash: sha256(canonicalJson(rule)) }], tierIds: ["exact-v1", "semantic-v1"], providerBundles: [], policyRevision: 1, rendererCompatibility: ["service-health-v1:1"] };
    const body = canonicalJson(manifest);
    this.db.transaction(() => {
      this.db.run("INSERT INTO dispatch_releases(id, manifest_json, manifest_hash, created_by, created_at) VALUES (?, ?, ?, ?, ?)", "rel-foundation-v1", body, sha256(body), "system", now);
      this.db.run("INSERT INTO dispatch_active_release(singleton_id, release_id, revision) VALUES (1, ?, 1)", "rel-foundation-v1");
    });
  }

  get(ruleId: string, revision?: number): DispatchRule | undefined {
    const row = this.db.one<Row>("SELECT body_json FROM dispatch_rule_revisions WHERE rule_id = ? AND revision = COALESCE(?, (SELECT current_revision FROM dispatch_rules WHERE id = ?))", ruleId, revision ?? null, ruleId);
    return row ? parseRule(String(row.body_json)) : undefined;
  }

  state(ruleId: string, revision: number): { state: RuleState; stateRevision: number } | undefined {
    const row = this.db.one<Row>("SELECT state, state_revision FROM dispatch_rule_states WHERE rule_id = ? AND revision = ?", ruleId, revision);
    return row ? { state: String(row.state) as RuleState, stateRevision: Number(row.state_revision) } : undefined;
  }

  list(): Array<DispatchRule & { state: RuleState; stateRevision: number; bodyHash: string }> {
    return this.db.all<Row>("SELECT rr.body_json, rr.body_hash, rs.state, rs.state_revision FROM dispatch_rules r JOIN dispatch_rule_revisions rr ON rr.rule_id = r.id AND rr.revision = r.current_revision JOIN dispatch_rule_states rs ON rs.rule_id = rr.rule_id AND rs.revision = rr.revision ORDER BY r.id").map((row) => ({ ...parseRule(String(row.body_json)), state: String(row.state) as RuleState, stateRevision: Number(row.state_revision), bodyHash: String(row.body_hash) }));
  }

  rulesForRelease(releaseId: string): DispatchRule[] {
    const release = this.db.one<Row>("SELECT manifest_json FROM dispatch_releases WHERE id = ?", releaseId);
    if (!release) return [];
    const manifest = parseManifest(String(release.manifest_json));
    return manifest.ruleSet.map((entry) => {
      const rule = this.get(entry.ruleId, entry.revision);
      const state = this.state(entry.ruleId, entry.revision);
      if (!rule || !state || state.state !== "ACTIVE" || sha256(canonicalJson(rule)) !== entry.bodyHash) return undefined;
      return rule;
    }).filter((rule): rule is DispatchRule => Boolean(rule));
  }

  activeRelease(): { id: string; revision: number; manifest: ReleaseManifest } | undefined {
    const row = this.db.one<Row>("SELECT a.release_id, a.revision, r.manifest_json FROM dispatch_active_release a JOIN dispatch_releases r ON r.id = a.release_id WHERE a.singleton_id = 1");
    return row ? { id: String(row.release_id), revision: Number(row.revision), manifest: parseManifest(String(row.manifest_json)) } : undefined;
  }

  createCandidate(rule: DispatchRule, actor: string, evidenceRefs: string[] = [], now = Date.now()): { ruleId: string; revision: number; bodyHash: string; state: RuleState } {
    this.validateRule(rule);
    const body = canonicalJson(rule);
    const bodyHash = sha256(body);
    this.db.transaction(() => {
      const current = this.db.one<Row>("SELECT current_revision FROM dispatch_rules WHERE id = ?", rule.ruleId);
      if (current && Number(current.current_revision) >= rule.revision) throw new Error("DISPATCH_RULE_REVISION_CONFLICT");
      this.db.run("INSERT INTO dispatch_rules(id, current_revision, created_by, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET current_revision = excluded.current_revision", rule.ruleId, rule.revision, actor, now);
      this.db.run("INSERT INTO dispatch_rule_revisions(rule_id, revision, body_json, body_hash, origin, evidence_refs_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", rule.ruleId, rule.revision, body, bodyHash, rule.provenance.origin, JSON.stringify(evidenceRefs.length ? evidenceRefs : rule.provenance.evidenceRefs), now);
      this.db.run("INSERT INTO dispatch_rule_states(rule_id, revision, state, state_revision) VALUES (?, ?, 'CANDIDATE', 1)", rule.ruleId, rule.revision);
      this.db.run("INSERT INTO dispatch_rule_events(id, rule_id, revision, from_state, to_state, actor, reason, policy_revision, created_at) VALUES (?, ?, ?, NULL, 'CANDIDATE', ?, 'CANDIDATE_CREATED', 1, ?)", uuidv7(now), rule.ruleId, rule.revision, actor, now);
    });
    return { ruleId: rule.ruleId, revision: rule.revision, bodyHash, state: "CANDIDATE" };
  }

  transition(ruleId: string, revision: number, to: RuleState, expectedStateRevision: number, actor: string, reason: string, evidenceRef?: string, now = Date.now()): { ruleId: string; revision: number; state: RuleState; stateRevision: number } {
    const current = this.state(ruleId, revision);
    if (!current) throw new Error("DISPATCH_RULE_NOT_FOUND");
    if (current.stateRevision !== expectedStateRevision) throw new Error("DISPATCH_RULE_STATE_CHANGED");
    if (!transitions[current.state].includes(to)) throw new Error("DISPATCH_RULE_INVALID_TRANSITION");
    // Learned predictions are not verified labels. Until an independently
    // evaluated promotion report is supported, neither a reason nor an
    // arbitrary evidence string may activate a learned rule.
    if (to === "ACTIVE" && this.get(ruleId, revision)?.provenance.origin === "learned") throw new Error("DISPATCH_PROMOTION_EVALUATION_UNAVAILABLE");
    this.db.transaction(() => {
      const changed = this.db.one<Row>("SELECT state_revision FROM dispatch_rule_states WHERE rule_id = ? AND revision = ? AND state_revision = ?", ruleId, revision, expectedStateRevision);
      if (!changed) throw new Error("DISPATCH_RULE_STATE_CHANGED");
      this.db.run("UPDATE dispatch_rule_states SET state = ?, state_revision = state_revision + 1, last_evaluated_at = ? WHERE rule_id = ? AND revision = ?", to, now, ruleId, revision);
      this.db.run("INSERT INTO dispatch_rule_events(id, rule_id, revision, from_state, to_state, actor, reason, evidence_ref, policy_revision, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)", uuidv7(now), ruleId, revision, current.state, to, actor, reason, evidenceRef ?? null, now);
      if (to === "DISABLED") this.db.run("INSERT OR REPLACE INTO dispatch_emergency_denials(rule_id, revision, reason, actor, created_at) VALUES (?, ?, ?, ?, ?)", ruleId, revision, reason, actor, now);
      if (to === "SHADOW" || to === "ACTIVE") this.db.run("DELETE FROM dispatch_emergency_denials WHERE rule_id = ? AND revision = ?", ruleId, revision);
      if (to === "ACTIVE" || current.state === "ACTIVE") this.switchActiveReleaseForRule(ruleId, revision, to === "ACTIVE", actor, now);
    });
    return { ruleId, revision, state: to, stateRevision: expectedStateRevision + 1 };
  }

  private switchActiveReleaseForRule(ruleId: string, revision: number, include: boolean, actor: string, now: number): void {
    const active = this.activeRelease();
    if (!active) throw new Error("DISPATCH_RELEASE_NOT_FOUND");
    const rule = this.get(ruleId, revision);
    if (include && !rule) throw new Error("DISPATCH_RULE_NOT_FOUND");
    const entries = active.manifest.ruleSet.filter((entry) => entry.ruleId !== ruleId || (!include && entry.revision !== revision));
    if (include && rule) entries.push({ ruleId, revision, bodyHash: sha256(canonicalJson(rule)) });
    entries.sort((left, right) => left.ruleId.localeCompare(right.ruleId));
    const manifest: ReleaseManifest = { ...active.manifest, ruleSet: entries };
    const body = canonicalJson(manifest); const hash = sha256(body);
    const existing = this.db.one<Row>("SELECT id FROM dispatch_releases WHERE manifest_hash = ?", hash);
    const id = existing?.id ? String(existing.id) : `rel-${uuidv7(now)}`;
    if (!existing) this.db.run("INSERT INTO dispatch_releases(id, manifest_json, manifest_hash, created_by, created_at) VALUES (?, ?, ?, ?, ?)", id, body, hash, actor, now);
    this.db.run("UPDATE dispatch_active_release SET release_id = ?, revision = revision + 1 WHERE singleton_id = 1 AND revision = ?", id, active.revision);
  }

  isDenied(ruleId: string, revision: number): boolean {
    return Boolean(this.db.one("SELECT 1 FROM dispatch_emergency_denials WHERE rule_id = ? AND (revision = ? OR revision IS NULL) LIMIT 1", ruleId, revision));
  }

  createRelease(manifest: ReleaseManifest, actor: string, id = `rel-${uuidv7()}`, now = Date.now()): { id: string; manifestHash: string } {
    this.validateReleaseManifest(manifest);
    for (const entry of manifest.ruleSet) {
      const rule = this.get(entry.ruleId, entry.revision); const state = this.state(entry.ruleId, entry.revision);
      if (!rule || !state || state.state !== "ACTIVE" || this.isDenied(entry.ruleId, entry.revision) || sha256(canonicalJson(rule)) !== entry.bodyHash) throw new Error("DISPATCH_RELEASE_RULE_NOT_ACTIVE");
    }
    const body = canonicalJson(manifest);
    const hash = sha256(body);
    this.db.run("INSERT INTO dispatch_releases(id, manifest_json, manifest_hash, created_by, created_at) VALUES (?, ?, ?, ?, ?)", id, body, hash, actor, now);
    return { id, manifestHash: hash };
  }

  activateRelease(id: string, expectedRevision: number, actor: string, now = Date.now()): { id: string; revision: number } {
    if (!this.db.one("SELECT id FROM dispatch_releases WHERE id = ?", id)) throw new Error("DISPATCH_RELEASE_NOT_FOUND");
    return this.db.transaction(() => {
      const active = this.activeRelease();
      if (!active || active.revision !== expectedRevision) throw new Error("DISPATCH_RELEASE_CHANGED");
      this.db.run("UPDATE dispatch_active_release SET release_id = ?, revision = revision + 1 WHERE singleton_id = 1 AND revision = ?", id, expectedRevision);
      return { id, revision: expectedRevision + 1 };
    });
  }

  private validateRule(rule: DispatchRule): void {
    const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
    const keys = (value: Record<string, unknown>, allowed: readonly string[], prefix: string) => { for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`INVALID_DISPATCH_RULE_FIELD:${prefix}.${key}`); };
    if (!isRecord(rule) || rule.schemaVersion !== 1 || typeof rule.ruleId !== "string" || !/^[a-z0-9][a-z0-9-]{2,80}$/.test(rule.ruleId) || !Number.isInteger(rule.revision) || rule.revision < 1 || typeof rule.intent !== "string" || rule.intent.length === 0) throw new Error("INVALID_DISPATCH_RULE");
    const allowedKeys = ["schemaVersion", "ruleId", "revision", "intent", "match", "slots", "action", "risk", "response", "provenance"];
    keys(rule, allowedKeys, "rule");
    if (!isRecord(rule.match)) throw new Error("INVALID_DISPATCH_RULE_MATCH");
    keys(rule.match, ["exact", "aliases", "semantic"], "match");
    for (const [name, patterns] of [["exact", rule.match.exact], ["aliases", rule.match.aliases]] as const) if (patterns !== undefined && (!Array.isArray(patterns) || patterns.some((value) => typeof value !== "string" || value.length > 200))) throw new Error(`INVALID_DISPATCH_RULE_MATCH:${name}`);
    for (const pattern of [...(rule.match.exact ?? []), ...(rule.match.aliases ?? [])]) {
      if (pattern.split("{service}").length !== 2 || /[{}]/.test(pattern.replace("{service}", ""))) throw new Error("INVALID_DISPATCH_RULE_PATTERN");
    }
    if (rule.match.semantic !== undefined) {
      if (!isRecord(rule.match.semantic)) throw new Error("INVALID_DISPATCH_RULE_SEMANTIC");
      keys(rule.match.semantic, ["examples", "negativeExamples"], "match.semantic");
      if (!Array.isArray(rule.match.semantic.examples) || !Array.isArray(rule.match.semantic.negativeExamples) || rule.match.semantic.examples.some((value) => typeof value !== "string" || value.length > 200) || rule.match.semantic.negativeExamples.some((value) => typeof value !== "string" || value.length > 200)) throw new Error("INVALID_DISPATCH_RULE_SEMANTIC");
    }
    if (!isRecord(rule.slots)) throw new Error("INVALID_DISPATCH_RULE_SLOT");
    for (const [slotName, slot] of Object.entries(rule.slots)) {
      if (!/^[a-z][a-z0-9_]{0,40}$/.test(slotName) || !isRecord(slot)) throw new Error("INVALID_DISPATCH_RULE_SLOT");
      keys(slot, ["type", "required", "extractor", "allowedValues"], `slots.${slotName}`);
      if (slot.type !== "service_ref" || slot.extractor !== "known_service_v1" || slot.required !== true || !Array.isArray(slot.allowedValues) || slot.allowedValues.length === 0 || slot.allowedValues.some((value) => typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{1,80}$/.test(value))) throw new Error("INVALID_DISPATCH_RULE_SLOT");
    }
    if (!rule.slots.service || Object.keys(rule.slots).length !== 1) throw new Error("INVALID_DISPATCH_RULE_SLOT");
    if (!isRecord(rule.action)) throw new Error("INVALID_DISPATCH_RULE_ACTION");
    keys(rule.action, ["kind", "operation", "operationSchemaVersion", "logicalWorker", "parameters"], "action");
    if (rule.action.kind !== "single_operation" || rule.action.operation !== "service.health_check" || rule.action.operationSchemaVersion !== 1 || rule.action.logicalWorker !== "control-plane-health" || !isRecord(rule.action.parameters) || Object.keys(rule.action.parameters).length !== 1 || rule.action.parameters.service_ref !== "$slot.service") throw new Error("DISPATCH_OPERATION_UNAVAILABLE");
    if (!isRecord(rule.risk)) throw new Error("DISPATCH_RULE_RISK_UNSUPPORTED");
    keys(rule.risk, ["declaredEffect", "requiredAssurance"], "risk");
    if (rule.risk.declaredEffect !== "READ_ONLY" || rule.risk.requiredAssurance !== "HIGH") throw new Error("DISPATCH_RULE_RISK_UNSUPPORTED");
    if (!isRecord(rule.response)) throw new Error("INVALID_DISPATCH_RULE_RESPONSE");
    keys(rule.response, ["templateId", "resultSchemaVersion"], "response");
    if (rule.response.templateId !== "service-health-v1" || rule.response.resultSchemaVersion !== 1) throw new Error("INVALID_DISPATCH_RULE_RESPONSE");
    if (!isRecord(rule.provenance)) throw new Error("INVALID_DISPATCH_RULE_PROVENANCE");
    keys(rule.provenance, ["origin", "evidenceRefs", "creator", "generatorRevision"], "provenance");
    if ((rule.provenance.origin !== "curated" && rule.provenance.origin !== "learned") || !Array.isArray(rule.provenance.evidenceRefs) || rule.provenance.evidenceRefs.some((value) => typeof value !== "string" || value.length > 500)) throw new Error("INVALID_DISPATCH_RULE_PROVENANCE");
  }

  private validateReleaseManifest(manifest: ReleaseManifest): void {
    if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.ruleSet) || !Array.isArray(manifest.tierIds) || !Array.isArray(manifest.providerBundles) || !Number.isInteger(manifest.policyRevision) || manifest.policyRevision < 1 || !Array.isArray(manifest.rendererCompatibility)) throw new Error("INVALID_DISPATCH_RELEASE");
    if (manifest.calibrationProfiles !== undefined && (!Array.isArray(manifest.calibrationProfiles) || manifest.calibrationProfiles.some((value) => typeof value !== "string" || value.length === 0 || value.length > 200) || new Set(manifest.calibrationProfiles).size !== manifest.calibrationProfiles.length)) throw new Error("INVALID_DISPATCH_RELEASE");
    const seenRules = new Set<string>();
    for (const entry of manifest.ruleSet) {
      if (!entry || typeof entry !== "object" || typeof entry.ruleId !== "string" || !/^[a-z0-9][a-z0-9-]{2,80}$/.test(entry.ruleId) || !Number.isInteger(entry.revision) || entry.revision < 1 || typeof entry.bodyHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(entry.bodyHash) || seenRules.has(entry.ruleId)) throw new Error("INVALID_DISPATCH_RELEASE");
      seenRules.add(entry.ruleId);
    }
    if (manifest.tierIds.some((value) => value !== "exact-v1" && value !== "semantic-v1") || manifest.providerBundles.some((value) => typeof value !== "string" || value.length === 0 || value.length > 200) || manifest.rendererCompatibility.some((value) => typeof value !== "string" || value.length === 0 || value.length > 200)) throw new Error("INVALID_DISPATCH_RELEASE");
  }
}

export type { ReleaseManifest };

function payloadRecord(value: unknown, field: string): Record<string, any> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`INVALID_DISPATCH_RULE_${field.toUpperCase()}`);
  return value as Record<string, any>;
}

function rejectPayloadKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`INVALID_DISPATCH_RULE_FIELD:${field}.${key}`);
}

export function parseDispatchRulePayload(value: unknown): DispatchRule {
  const input = payloadRecord(value, "PAYLOAD");
  const allowed = ["schema_version", "rule_id", "revision", "intent", "match", "slots", "action", "risk", "response", "provenance"];
  rejectPayloadKeys(input, allowed, "rule");
  const match = input.match === undefined ? {} : payloadRecord(input.match, "MATCH");
  rejectPayloadKeys(match, ["exact", "aliases", "semantic"], "match");
  const semanticInput = match.semantic === undefined ? undefined : payloadRecord(match.semantic, "SEMANTIC");
  if (semanticInput) rejectPayloadKeys(semanticInput, ["examples", "negative_examples", "negativeExamples"], "match.semantic");
  const semantic = semanticInput ? { examples: semanticInput.examples ?? [], negativeExamples: semanticInput.negative_examples ?? semanticInput.negativeExamples ?? [] } : undefined;
  const slots: DispatchRule["slots"] = {};
  const slotInput = input.slots === undefined ? {} : payloadRecord(input.slots, "SLOTS");
  for (const [name, raw] of Object.entries(slotInput)) {
    const slot = payloadRecord(raw, `SLOT_${name.toUpperCase()}`);
    rejectPayloadKeys(slot, ["type", "required", "extractor", "allowed_values", "allowedValues"], `slots.${name}`);
    slots[name] = { type: slot.type, required: slot.required === true, extractor: slot.extractor, allowedValues: slot.allowed_values ?? slot.allowedValues ?? [] };
  }
  const action = input.action === undefined ? {} : payloadRecord(input.action, "ACTION");
  rejectPayloadKeys(action, ["kind", "operation", "operation_schema_version", "operationSchemaVersion", "logical_worker", "logicalWorker", "parameters"], "action");
  if (action.parameters !== undefined) payloadRecord(action.parameters, "ACTION_PARAMETERS");
  const risk = input.risk === undefined ? {} : payloadRecord(input.risk, "RISK");
  rejectPayloadKeys(risk, ["declared_effect", "declaredEffect", "required_assurance", "requiredAssurance"], "risk");
  const response = input.response === undefined ? {} : payloadRecord(input.response, "RESPONSE");
  rejectPayloadKeys(response, ["template_id", "templateId", "result_schema_version", "resultSchemaVersion"], "response");
  const provenance = input.provenance === undefined ? {} : payloadRecord(input.provenance, "PROVENANCE");
  rejectPayloadKeys(provenance, ["origin", "evidence_refs", "evidenceRefs", "creator", "generator_revision", "generatorRevision"], "provenance");
  return {
    schemaVersion: input.schema_version,
    ruleId: input.rule_id,
    revision: input.revision,
    intent: input.intent,
    match: { ...(match.exact === undefined ? {} : { exact: match.exact }), ...(match.aliases === undefined ? {} : { aliases: match.aliases }), ...(semantic ? { semantic } : {}) },
    slots,
    action: { ...(action.kind === undefined ? {} : { kind: action.kind }), operation: action.operation, operationSchemaVersion: action.operation_schema_version ?? action.operationSchemaVersion, logicalWorker: action.logical_worker ?? action.logicalWorker, parameters: action.parameters ?? {} },
    risk: { declaredEffect: risk.declared_effect ?? risk.declaredEffect, requiredAssurance: risk.required_assurance ?? risk.requiredAssurance },
    response: { templateId: response.template_id ?? response.templateId, resultSchemaVersion: response.result_schema_version ?? response.resultSchemaVersion },
    provenance: { origin: provenance.origin, evidenceRefs: provenance.evidence_refs ?? provenance.evidenceRefs ?? [], ...(provenance.creator === undefined ? {} : { creator: provenance.creator }), ...((provenance.generator_revision ?? provenance.generatorRevision) === undefined ? {} : { generatorRevision: provenance.generator_revision ?? provenance.generatorRevision }) },
  };
}

export function parseDispatchReleasePayload(value: unknown): ReleaseManifest {
  const input = payloadRecord(value, "RELEASE");
  rejectPayloadKeys(input, ["schema_version", "schemaVersion", "rule_set", "ruleSet", "tier_ids", "tierIds", "provider_bundles", "providerBundles", "policy_revision", "policyRevision", "renderer_compatibility", "rendererCompatibility", "calibration_profiles", "calibrationProfiles"], "release");
  const rules = Array.isArray(input.rule_set) ? input.rule_set : input.ruleSet;
  if (!Array.isArray(rules)) throw new Error("INVALID_DISPATCH_RELEASE");
  const ruleSet = rules.map((value) => {
    const entry = payloadRecord(value, "RELEASE_RULE");
    rejectPayloadKeys(entry, ["rule_id", "ruleId", "revision", "body_hash", "bodyHash"], "release.rule");
    return { ruleId: entry.rule_id ?? entry.ruleId, revision: entry.revision, bodyHash: entry.body_hash ?? entry.bodyHash };
  });
  return {
    schemaVersion: input.schema_version ?? input.schemaVersion,
    ruleSet,
    tierIds: input.tier_ids ?? input.tierIds ?? [],
    providerBundles: input.provider_bundles ?? input.providerBundles ?? [],
    ...((input.calibration_profiles ?? input.calibrationProfiles) === undefined ? {} : { calibrationProfiles: input.calibration_profiles ?? input.calibrationProfiles }),
    policyRevision: input.policy_revision ?? input.policyRevision ?? 1,
    rendererCompatibility: input.renderer_compatibility ?? input.rendererCompatibility ?? [],
  };
}
