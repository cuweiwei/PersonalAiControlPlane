import { readFileSync } from "node:fs";
import type { JsonValue } from "../../../../packages/contracts/src/index.ts";
import type { WorkerExecutor, WorkerTaskOffer, ExecutionEvent } from "../runtime.ts";

export type OpenAICompatibleOptions = { runtime: string; baseUrl: string; enabled?: boolean; apiKey?: string; apiKeyFile?: string; healthUrl?: string; statusUrl?: string };
export class OpenAICompatibleExecutor implements WorkerExecutor {
  readonly type = "llm.inference";
  private readonly options: OpenAICompatibleOptions;
  constructor(options: OpenAICompatibleOptions) { this.options = options; }
  canExecute(task: WorkerTaskOffer): boolean { return Boolean(this.options.enabled !== false && task.task_type === "llm.inference" && (!task.execution?.runtime || task.execution.runtime === "auto" || task.execution.runtime === this.options.runtime)); }
  async discover(): Promise<{ capabilities: Record<string, JsonValue>[]; models: Record<string, JsonValue>[] }> {
    if (this.options.enabled === false) return { capabilities: [], models: [] };
    try {
      const response = await fetch(this.options.statusUrl ?? `${this.options.baseUrl.replace(/\/$/, "")}/models`, { headers: this.headers(), signal: AbortSignal.timeout(1_500) });
      if (!response.ok) {
        if (response.status === 401 && this.options.healthUrl) return this.discoverHealth();
        return { capabilities: [{ capability: "llm.inference", runtime: this.options.runtime, status: "UNAVAILABLE" }], models: [] };
      }
      const payload = await response.json() as { data?: Array<Record<string, any>>; models?: Array<Record<string, any>> };
      const models = (payload.models ?? payload.data ?? []).map((model) => {
        const contextLength = Number(model.model_context_length ?? model.context_length ?? model.max_model_len ?? 0);
        const loaded = typeof model.loaded === "boolean" ? model.loaded : undefined;
        const loading = typeof model.is_loading === "boolean" ? model.is_loading : undefined;
        const metadata = { ...(loaded === undefined ? {} : { loaded }), ...(loading === undefined ? {} : { loading }), ...(Number(model.actual_size ?? model.resident_estimated_size ?? model.estimated_size ?? 0) > 0 ? { memory_mb: Number(model.actual_size ?? model.resident_estimated_size ?? model.estimated_size) } : {}), ...(typeof model.source_type === "string" ? { source: model.source_type } : {}) };
        return { runtime: this.options.runtime, id: String(model.id), display_name: String(model.id), status: loading ? "loading" : "ready", ...(contextLength > 0 ? { context_length: contextLength } : {}), ...(Object.keys(metadata).length > 0 ? { metadata } : {}) };
      });
      return { capabilities: [{ capability: "llm.inference", runtime: this.options.runtime, status: models.length > 0 ? "READY" : "UNAVAILABLE", max_concurrency: 1 }], models };
    } catch { return { capabilities: [{ capability: "llm.inference", runtime: this.options.runtime, status: "UNAVAILABLE" }], models: [] }; }
  }
  async *execute(task: WorkerTaskOffer, context: { signal?: AbortSignal } = {}): AsyncIterable<ExecutionEvent> { const payload = (task.payload ?? {}) as Record<string, any>; const model = String(task.execution?.model && typeof task.execution.model === "object" ? (task.execution.model as any).name ?? "" : ""); const messages = [{ role: "system", content: String(payload.system_prompt ?? "You are an execution worker.") }, { role: "user", content: String(payload.prompt ?? task.instruction) }]; yield { type: "progress", progress: { phase: "llm.request", runtime: this.options.runtime } }; const timeout = AbortSignal.timeout(Number(task.limits?.timeout_seconds ?? 1800) * 1_000); const signal = context.signal ? AbortSignal.any([timeout, context.signal]) : timeout; const response = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", ...this.headers() }, body: JSON.stringify({ model, messages, temperature: payload.temperature ?? 0.2, max_tokens: payload.max_tokens ?? 4096, response_format: payload.response_format }), signal }); if (!response.ok) throw new Error(`LLM_HTTP_${response.status}`); const result = await response.json() as Record<string, any>; const content = result.choices?.[0]?.message?.content ?? ""; yield { type: "result", result: { text: String(content), model, runtime: this.options.runtime }, metrics: { prompt_tokens: Number(result.usage?.prompt_tokens ?? 0), completion_tokens: Number(result.usage?.completion_tokens ?? 0) } }; }

  private headers(): Record<string, string> { const apiKey = this.options.apiKey || this.readApiKeyFile(); return apiKey ? { authorization: `Bearer ${apiKey}` } : {}; }
  private readApiKeyFile(): string | undefined {
    if (!this.options.apiKeyFile) return undefined;
    try {
      const value = JSON.parse(readFileSync(this.options.apiKeyFile, "utf8")) as { api_key?: unknown; auth?: { api_key?: unknown } };
      const apiKey = value.auth?.api_key ?? value.api_key;
      return typeof apiKey === "string" && apiKey.length > 0 ? apiKey : undefined;
    } catch { return undefined; }
  }
  private async discoverHealth(): Promise<{ capabilities: Record<string, JsonValue>[]; models: Record<string, JsonValue>[] }> {
    try {
      const response = await fetch(this.options.healthUrl!, { signal: AbortSignal.timeout(1_500) });
      if (!response.ok) return { capabilities: [{ capability: "llm.inference", runtime: this.options.runtime, status: "UNAVAILABLE" }], models: [] };
      const payload = await response.json() as { status?: string; default_model?: unknown; engine_pool?: { loaded_count?: unknown; model_count?: unknown } };
      const model = typeof payload.default_model === "string" ? payload.default_model : "";
      if (!model) return { capabilities: [{ capability: "llm.inference", runtime: this.options.runtime, status: "DEGRADED" }], models: [] };
      const loadedCount = Number(payload.engine_pool?.loaded_count ?? 0);
      const modelCount = Number(payload.engine_pool?.model_count ?? 0);
      return {
        capabilities: [{ capability: "llm.inference", runtime: this.options.runtime, status: "UNAVAILABLE", max_concurrency: 1 }],
        models: [{ runtime: this.options.runtime, id: model, display_name: model, status: "unavailable", metadata: { source: "health", reason: "API_KEY_REQUIRED", loaded: loadedCount > 0, loaded_count: loadedCount, model_count: modelCount } }],
      };
    } catch { return { capabilities: [{ capability: "llm.inference", runtime: this.options.runtime, status: "UNAVAILABLE" }], models: [] }; }
  }
}
