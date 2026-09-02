import type { JsonValue } from "../../../../packages/contracts/src/index.ts";
import type { WorkerExecutor, WorkerTaskOffer, ExecutionEvent } from "../runtime.ts";

export type OpenAICompatibleOptions = { runtime: string; baseUrl: string; enabled?: boolean };
export class OpenAICompatibleExecutor implements WorkerExecutor {
  readonly type = "llm.inference";
  private readonly options: OpenAICompatibleOptions;
  constructor(options: OpenAICompatibleOptions) { this.options = options; }
  canExecute(task: WorkerTaskOffer): boolean { return Boolean(this.options.enabled !== false && task.task_type === "llm.inference" && (!task.execution?.runtime || task.execution.runtime === "auto" || task.execution.runtime === this.options.runtime)); }
  async discover(): Promise<{ capabilities: Record<string, JsonValue>[]; models: Record<string, JsonValue>[] }> {
    if (this.options.enabled === false) return { capabilities: [], models: [] };
    try {
      const response = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}/models`, { signal: AbortSignal.timeout(1_500) });
      if (!response.ok) return { capabilities: [{ capability: "llm.inference", runtime: this.options.runtime, status: "DEGRADED" }], models: [] };
      const payload = await response.json() as { data?: Array<Record<string, any>> };
      const models = (payload.data ?? []).map((model) => {
        const contextLength = Number(model.context_length ?? 0);
        return { runtime: this.options.runtime, id: String(model.id), display_name: String(model.id), status: "ready", ...(contextLength > 0 ? { context_length: contextLength } : {}) };
      });
      return { capabilities: [{ capability: "llm.inference", runtime: this.options.runtime, status: "READY", max_concurrency: 1 }], models };
    } catch { return { capabilities: [{ capability: "llm.inference", runtime: this.options.runtime, status: "DEGRADED" }], models: [] }; }
  }
  async *execute(task: WorkerTaskOffer): AsyncIterable<ExecutionEvent> { const payload = (task.payload ?? {}) as Record<string, any>; const model = String(task.execution?.model && typeof task.execution.model === "object" ? (task.execution.model as any).name ?? "" : ""); const messages = [{ role: "system", content: String(payload.system_prompt ?? "You are an execution worker.") }, { role: "user", content: String(payload.prompt ?? task.instruction) }]; yield { type: "progress", progress: { phase: "llm.request", runtime: this.options.runtime } }; const response = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, messages, temperature: payload.temperature ?? 0.2, max_tokens: payload.max_tokens ?? 4096, response_format: payload.response_format }), signal: AbortSignal.timeout(Number(task.limits?.timeout_seconds ?? 1800) * 1_000) }); if (!response.ok) throw new Error(`LLM_HTTP_${response.status}`); const result = await response.json() as Record<string, any>; const content = result.choices?.[0]?.message?.content ?? ""; yield { type: "result", result: { text: String(content), model, runtime: this.options.runtime }, metrics: { prompt_tokens: Number(result.usage?.prompt_tokens ?? 0), completion_tokens: Number(result.usage?.completion_tokens ?? 0) } }; }
}
