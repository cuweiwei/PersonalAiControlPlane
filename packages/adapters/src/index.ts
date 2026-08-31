export type ClassifiedError = {
  code: string;
  class: "TRANSIENT" | "PERMANENT" | "AUTH" | "QUOTA" | "POLICY" | "CONFLICT" | "UNCERTAIN_SIDE_EFFECT";
  retryAfterMs?: number;
  safeMessage: string;
};

export type CredentialHandleRef = { id: string; purpose: string; health: string; expiresAt: number | null };
export type ProviderDescriptor = { providerId: string; providerClass: "deterministic" | "local-llm" | "codex-subscription" | "cloud-llm-metered"; modelId?: string; capabilities: string[]; qualityEvidence?: Record<string, unknown>; quota: "AVAILABLE_ESTIMATE" | "NEAR_LIMIT" | "EXHAUSTED" | "UNKNOWN"; credentialHandle?: CredentialHandleRef };
export type ComputeRequest = { taskId: string; action: string; inputDigest: string; budget: Record<string, number> };
export type ProviderHealth = { status: "HEALTHY" | "DEGRADED" | "EXHAUSTED" | "DISABLED"; observedAt: number; evidence?: Record<string, unknown> };
export type RouteEstimate = { providerId: string; qualityEligible: boolean; estimatedCostMicros: number; latencyMs: number; confidence: "HIGH" | "MEDIUM" | "LOW" };
export type ProviderReservation = { reservationId: string; providerId: string; expiresAt: number };
export type ComputeEvent = { eventId: string; type: "PROGRESS" | "CHECKPOINT" | "RESULT" | "ERROR"; payload: Record<string, unknown> };

export interface ComputeProvider {
  describe(): Promise<ProviderDescriptor>;
  probe(): Promise<ProviderHealth>;
  estimate(request: ComputeRequest): Promise<RouteEstimate>;
  reserve(request: ComputeRequest): Promise<ProviderReservation>;
  execute(reservation: ProviderReservation, inputDigest: string): AsyncIterable<ComputeEvent>;
  checkpoint(executionId: string): Promise<Record<string, unknown>>;
  resume(checkpoint: Record<string, unknown>): AsyncIterable<ComputeEvent>;
  cancel(executionId: string): Promise<{ accepted: boolean; uncertain: boolean }>;
}

export type NormalizedEnvelope = Record<string, unknown>;
export interface ConversationConnector {
  describe(): { id: string; interface: "official-api" | "mcp" | "device-export" | "browser-cua"; supported: boolean };
  authorize(handle: CredentialHandleRef): Promise<{ authorized: boolean; reason?: string }>;
  pull(cursor: string | null, limit: number): AsyncIterable<NormalizedEnvelope>;
  acknowledge(batch: { accepted: number; cursor: string | null }): Promise<string | null>;
  exportDeletionSemantics(): { supportsMessageDeletion: boolean; supportsConversationDeletion: boolean; cutoff: "message" | "cursor" | "none" };
}

export interface ContextHubAdapter {
  compileContext(request: Record<string, unknown>, idempotencyKey: string): Promise<Record<string, unknown>>;
  proposeCandidate(candidate: Record<string, unknown>, idempotencyKey: string): Promise<Record<string, unknown>>;
  proposeSuccessor(existingId: string, candidate: Record<string, unknown>, idempotencyKey: string): Promise<Record<string, unknown>>;
  recordContextOutcome(contextPackageId: string, outcome: Record<string, unknown>, idempotencyKey: string): Promise<void>;
  readChanges(cursor: string | null): Promise<{ cursor: string | null; changes: Record<string, unknown>[] }>;
}

export interface HermesAdapter {
  submitGoal(input: Record<string, unknown>, idempotencyKey: string): Promise<{ goalId: string }>;
  getGoalStatus(goalId: string): Promise<Record<string, unknown>>;
  cancelGoal(goalId: string, idempotencyKey: string): Promise<void>;
  answerOrdinaryApproval(approvalId: string, decision: "APPROVE" | "REJECT", idempotencyKey: string): Promise<void>;
  openPasskeyApproval(approvalId: string): Promise<{ url: string; expiresAt: number }>;
  fetchResultArtifact(goalId: string): Promise<{ artifactHash: string }>;
}

export class DisabledAdapterError extends Error {
  readonly code = "ADAPTER_DISABLED";
  readonly class = "POLICY" as const;
  readonly retryable = false;
  readonly adapter: string;
  constructor(adapter: string, reason: string) { super(`${adapter} adapter is disabled: ${reason}`); this.adapter = adapter; }
}

export class DisabledContextHubAdapter implements ContextHubAdapter {
  private readonly reason: string;
  constructor(reason = "compatibility evidence is missing") { this.reason = reason; }
  private denied(): DisabledAdapterError { return new DisabledAdapterError("ContextHub", this.reason); }
  compileContext(): Promise<Record<string, unknown>> { return Promise.reject(this.denied()); }
  proposeCandidate(): Promise<Record<string, unknown>> { return Promise.reject(this.denied()); }
  proposeSuccessor(): Promise<Record<string, unknown>> { return Promise.reject(this.denied()); }
  recordContextOutcome(): Promise<void> { return Promise.reject(this.denied()); }
  readChanges(): Promise<{ cursor: string | null; changes: Record<string, unknown>[] }> { return Promise.reject(this.denied()); }
}

export function classifyHermesMessage(text: string): { mode: "STATELESS_CHAT" | "DURABLE_GOAL"; reasons: string[] } {
  const normalized = text.trim().toLowerCase();
  const reasons: string[] = [];
  if (/\b(delete|send|deploy|write|modify|purchase|move money|刪除|部署|修改|寄送|購買)\b/.test(normalized)) reasons.push("mutation");
  if (/\b(schedule|every day|remind)\b|排程|每天|提醒/.test(normalized)) reasons.push("schedule");
  if (/\b(step|task|machine|worker|multi|多步|機器|執行)\b/.test(normalized)) reasons.push("durable-execution");
  if (/\b(approve|approval|同意|核准)\b/.test(normalized)) reasons.push("approval");
  return reasons.length > 0 ? { mode: "DURABLE_GOAL", reasons } : { mode: "STATELESS_CHAT", reasons: [] };
}
