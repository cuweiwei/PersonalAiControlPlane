import type { DispatchAction, DispatchJson, DispatchLanguageClass, DispatchRequestEnvelope } from "../../../../packages/contracts/src/dispatch.ts";

export type RuleState = "CANDIDATE" | "SHADOW" | "ACTIVE" | "DISABLED" | "ARCHIVED";
export type RuleOrigin = "curated" | "learned";

export type DispatchRule = {
  schemaVersion: 1;
  ruleId: string;
  revision: number;
  intent: string;
  match: {
    exact?: string[];
    aliases?: string[];
    semantic?: { examples: string[]; negativeExamples: string[] };
  };
  slots: Record<string, { type: "service_ref"; required: boolean; extractor: "known_service_v1"; allowedValues: string[] }>;
  action: DispatchAction;
  risk: { declaredEffect: "READ_ONLY"; requiredAssurance: "HIGH" };
  response: { templateId: string; resultSchemaVersion: number };
  provenance: { origin: RuleOrigin; evidenceRefs: string[]; creator?: string; generatorRevision?: string };
};

export type RouteInput = {
  requestId: string;
  text: string;
  context: { locale: string; languageClass: DispatchLanguageClass };
  candidateIntents: readonly string[];
  bundleId: string;
  deadlineAt: number;
  ruleSetHash?: string;
};

export type NormalizedMatch = {
  schemaVersion: 1;
  intent: string | null;
  abstain: boolean;
  reason: string;
  assurance: "UNASSESSED" | "HIGH";
  calibratedProbability: number | null;
  calibrationProfileId: string | null;
  alternatives: Array<{ intent: string; calibratedProbability: number | null }>;
  provenance: { providerId: string; modelRevision: string | null; bundleId: string; runtimeRevision: string; ruleSetHash: string; datasetRevision: string | null };
};

export interface SemanticRouterProvider {
  describe(): ProviderDescriptor;
  readiness(signal?: AbortSignal): Promise<{ ready: boolean; reason: string }>;
  match(input: RouteInput, signal: AbortSignal): Promise<NormalizedMatch>;
  close(): Promise<void>;
}

export type ProviderDescriptor = {
  providerId: string;
  protocolVersion: 1;
  modelRevision: string | null;
  runtimeRevision: string;
  bundleId: string;
  bundleHash: string;
  supportedLanguageClasses: DispatchLanguageClass[];
  maxBytes: number;
  maxTokens: number;
  privacyLocality: "LOCAL_ONLY" | "TRUSTED_PRIVATE" | "EXTERNAL_ALLOWED";
};

export type DispatchEvaluation = {
  tierId: string;
  rule: DispatchRule | null;
  intent: string | null;
  action: DispatchAction | null;
  assurance: "UNASSESSED" | "HIGH";
  calibratedProbability: number | null;
  reason: string;
  provenance: Record<string, unknown>;
};

export type ExecutionResult = {
  schemaVersion: number;
  status: "HEALTHY" | "DEGRADED" | "OFFLINE" | "UNKNOWN";
  observedAt: string;
  sourceRef: string;
  serviceRef: string;
  message: string | null;
};

export interface DispatchExecutionAdapter {
  operationId: string;
  descriptorHash: string;
  supportsOperationDedup: boolean;
  execute(action: DispatchAction, operationKey: string, signal: AbortSignal): Promise<ExecutionResult>;
}

export type DispatchRequestRecord = DispatchRequestEnvelope & { bodyHash: string };
export type { DispatchAction, DispatchJson };
