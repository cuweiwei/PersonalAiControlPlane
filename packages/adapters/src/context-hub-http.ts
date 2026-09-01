import type { ContextHubAdapter } from "./index.ts";

type FetchLike = typeof fetch;

export type ContextHubHttpAdapterOptions = {
  origin: string;
  apiKey: string;
  timeoutMs?: number;
  fetcher?: FetchLike;
};

type ContextCompileRequest = {
  intent: string;
  queries?: string[];
  targetAgent?: string;
  tokenBudget?: number;
  sources?: string[];
  types?: string[];
  tags?: string[];
  entities?: string[];
  entityFilters?: string[];
  informationClasses?: string[];
  memoryKinds?: string[];
  claimKeys?: string[];
  includePrivate?: boolean;
  stateKeys?: string[];
  runtimeInputs?: Array<{ kind: "system_constraint" | "tool_result"; value: string }>;
};

const CONTEXT_TARGETS = new Set(["generic", "openai", "anthropic", "hermes"]);
const INFORMATION_CLASSES = new Set(["source", "memory", "task_state"]);
const MEMORY_KINDS = new Set(["fact", "preference", "decision", "experience", "procedure", "relationship", "working_state"]);

function origin(value: string): string {
  const parsed = new URL(value);
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error("ContextHub origin must not contain credentials or a path");
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("ContextHub origin must use http or https");
  return parsed.toString().replace(/\/$/, "");
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function compileBody(request: Record<string, unknown>): Record<string, unknown> {
  const input = record(request, "context request");
  if (typeof input.intent !== "string" || input.intent.trim().length === 0 || input.intent.length > 10_000) throw new Error("context request intent is invalid");
  const body: ContextCompileRequest = { intent: input.intent };
  const copyArray = (source: string, target: keyof ContextCompileRequest, max: number, maxEntryLength = 500): void => {
    if (input[source] === undefined) return;
    if (!Array.isArray(input[source]) || input[source].length > max || input[source].some((entry) => typeof entry !== "string" || entry.length === 0 || entry.length > maxEntryLength)) throw new Error(`context request ${source} is invalid`);
    body[target] = [...input[source] as string[]] as never;
  };
  copyArray("queries", "queries", 5, 1_000);
  copyArray("sources", "sources", 50);
  copyArray("types", "types", 50);
  copyArray("tags", "tags", 50);
  copyArray("entities", "entities", 50, 200);
  copyArray("entityFilters", "entityFilters", 50, 200);
  copyArray("informationClasses", "informationClasses", 3);
  if (body.informationClasses?.some((entry) => !INFORMATION_CLASSES.has(entry))) throw new Error("context request informationClasses is invalid");
  copyArray("memoryKinds", "memoryKinds", 7);
  if (body.memoryKinds?.some((entry) => !MEMORY_KINDS.has(entry))) throw new Error("context request memoryKinds is invalid");
  copyArray("claimKeys", "claimKeys", 50);
  copyArray("stateKeys", "stateKeys", 20, 200);
  if (input.targetAgent !== undefined) { if (typeof input.targetAgent !== "string" || !CONTEXT_TARGETS.has(input.targetAgent)) throw new Error("context request targetAgent is invalid"); body.targetAgent = input.targetAgent; }
  if (input.tokenBudget !== undefined) { if (!Number.isInteger(input.tokenBudget) || Number(input.tokenBudget) < 256 || Number(input.tokenBudget) > 32_000) throw new Error("context request tokenBudget is invalid"); body.tokenBudget = Number(input.tokenBudget); }
  if (input.includePrivate !== undefined) { if (typeof input.includePrivate !== "boolean") throw new Error("context request includePrivate is invalid"); body.includePrivate = input.includePrivate; }
  if (input.runtimeInputs !== undefined) {
    if (!Array.isArray(input.runtimeInputs) || input.runtimeInputs.length > 20 || input.runtimeInputs.some((entry) => !entry || typeof entry !== "object" || !["system_constraint", "tool_result"].includes(String((entry as Record<string, unknown>).kind)) || typeof (entry as Record<string, unknown>).value !== "string" || String((entry as Record<string, unknown>).value).length > 10_240)) throw new Error("context request runtimeInputs is invalid");
    body.runtimeInputs = input.runtimeInputs as ContextCompileRequest["runtimeInputs"];
  }
  return {
    intent: body.intent,
    ...(body.queries ? { queries: body.queries } : {}),
    ...(body.targetAgent ? { target_agent: body.targetAgent } : {}),
    ...(body.tokenBudget ? { token_budget: body.tokenBudget } : {}),
    ...(body.sources ? { sources: body.sources } : {}),
    ...(body.types ? { types: body.types } : {}),
    ...(body.tags ? { tags: body.tags } : {}),
    ...(body.entities ? { entities: body.entities } : {}),
    ...(body.entityFilters ? { entity_filters: body.entityFilters } : {}),
    ...(body.informationClasses ? { information_classes: body.informationClasses } : {}),
    ...(body.memoryKinds ? { memory_kinds: body.memoryKinds } : {}),
    ...(body.claimKeys ? { claim_keys: body.claimKeys } : {}),
    ...(body.includePrivate !== undefined ? { include_private: body.includePrivate } : {}),
    ...(body.stateKeys ? { state_keys: body.stateKeys } : {}),
    ...(body.runtimeInputs ? { runtime_inputs: body.runtimeInputs } : {}),
  };
}

export class ContextHubHttpAdapter implements ContextHubAdapter {
  private readonly baseOrigin: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetcher: FetchLike;

  constructor(options: ContextHubHttpAdapterOptions) {
    if (!options.apiKey || options.apiKey.length > 500) throw new Error("ContextHub apiKey is invalid");
    this.baseOrigin = origin(options.origin);
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 500 || this.timeoutMs > 30_000) throw new Error("ContextHub timeoutMs is invalid");
    this.fetcher = options.fetcher ?? fetch;
  }

  private idempotencyKey(value: string, field: string): string {
    if (!value || value.length > 200 || /[\r\n]/.test(value)) throw new Error(`ContextHub ${field} idempotencyKey is invalid`);
    return value;
  }

  private async request(path: string, init: { method?: string; body?: unknown; idempotencyKey?: string } = {}): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.apiKey}`, accept: "application/json" };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (init.idempotencyKey) headers["idempotency-key"] = init.idempotencyKey;
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseOrigin}${path}`, {
        method: init.method ?? "GET",
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      const error = new Error("ContextHub is unavailable") as Error & { code?: string; retryable?: boolean };
      error.code = "CONTEXT_HUB_UNAVAILABLE";
      error.retryable = true;
      (error as Error & { cause?: unknown }).cause = cause;
      throw error;
    }
    const text = await response.text();
    let parsed: unknown = {};
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { error: { code: "INVALID_JSON_RESPONSE" } }; }
    if (!response.ok) {
      const error = new Error(`ContextHub request failed (${response.status})`) as Error & { code?: string; status?: number; retryable?: boolean };
      error.status = response.status;
      error.retryable = response.status >= 500 || response.status === 429;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof (parsed as Record<string, unknown>).error === "object") {
        const detail = (parsed as Record<string, unknown>).error as Record<string, unknown>;
        if (typeof detail.code === "string") error.code = detail.code;
      }
      throw error;
    }
    return record(parsed, "ContextHub response");
  }

  compileContext(request: Record<string, unknown>, idempotencyKey: string): Promise<Record<string, unknown>> {
    return this.request("/v1/context/compile", { method: "POST", body: compileBody(request), idempotencyKey: this.idempotencyKey(idempotencyKey, "compile") });
  }

  proposeCandidate(candidate: Record<string, unknown>, idempotencyKey: string): Promise<Record<string, unknown>> {
    const key = this.idempotencyKey(idempotencyKey, "candidate");
    return this.request("/v1/items", { method: "POST", body: { ...record(candidate, "candidate"), idempotency_key: key }, idempotencyKey: key });
  }

  proposeSuccessor(existingId: string, candidate: Record<string, unknown>, idempotencyKey: string): Promise<Record<string, unknown>> {
    if (!existingId) throw new Error("ContextHub existingId is required");
    const key = this.idempotencyKey(idempotencyKey, "successor");
    return this.request(`/v1/items/${encodeURIComponent(existingId)}/successor`, { method: "POST", body: { ...record(candidate, "successor"), idempotency_key: key }, idempotencyKey: key });
  }

  recordContextOutcome(contextPackageId: string, outcome: Record<string, unknown>, idempotencyKey: string): Promise<void> {
    if (!contextPackageId || contextPackageId.length > 100) throw new Error("ContextHub outcome package id is invalid");
    const key = this.idempotencyKey(idempotencyKey, "outcome");
    const input = record(outcome, "outcome");
    const itemIds = input.itemIds ?? input.item_ids ?? [];
    const outcomeValue = input.outcome;
    const actionChanged = input.actionChanged ?? input.action_changed;
    if (!Array.isArray(itemIds) || itemIds.length > 50 || itemIds.some((item) => typeof item !== "string" || item.length === 0) || !["helpful", "mixed", "harmful", "unknown"].includes(String(outcomeValue)) || typeof actionChanged !== "boolean") {
      throw new Error("ContextHub outcome is invalid");
    }
    return this.request("/v1/context/outcomes", { method: "POST", body: { package_id: contextPackageId, item_ids: itemIds, outcome: outcomeValue, action_changed: actionChanged, idempotency_key: key }, idempotencyKey: key }).then(() => undefined);
  }

  async readChanges(cursor: string | null): Promise<{ cursor: string | null; changes: Record<string, unknown>[] }> {
    const after = cursor && /^\d+$/.test(cursor) ? cursor : "0";
    const response = await this.request(`/v1/changes?after=${after}&limit=100`);
    const events = Array.isArray(response.events) ? response.events.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)) : [];
    const next = typeof response.next_cursor === "number" || typeof response.next_cursor === "string" ? String(response.next_cursor) : cursor;
    return { cursor: next, changes: events };
  }
}
