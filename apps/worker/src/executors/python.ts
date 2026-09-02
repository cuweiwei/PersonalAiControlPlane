import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { resolvePathWithinRoots } from "../../../../packages/worker/src/index.ts";
import type { ExecutionEvent, WorkerExecutor, WorkerTaskOffer } from "../runtime.ts";
export class PythonExecutor implements WorkerExecutor {
  readonly type = "python";
  private readonly workspaces: Record<string, string>;
  private readonly enabled: boolean;
  private readonly children = new Map<string, ChildProcess>();
  constructor(workspaces: Record<string, string>, enabled = false) { this.workspaces = workspaces; this.enabled = enabled; }
  canExecute(task: WorkerTaskOffer): boolean { return this.enabled && task.task_type === "python"; }
  async discover() { return this.enabled ? { capabilities: [{ capability: "python", status: "READY", max_concurrency: 1 }], models: [] } : { capabilities: [], models: [] }; }
  async *execute(task: WorkerTaskOffer, context: { signal?: AbortSignal } = {}): AsyncIterable<ExecutionEvent> {
    const payload = task.payload as any; const root = this.workspaces[String(payload.workspace_id ?? "")];
    if (!root || !existsSync(root) || !resolvePathWithinRoots(resolve(root), [resolve(root)])) throw new Error("WORKSPACE_UNAVAILABLE");
    if (context.signal?.aborted) throw new Error("PYTHON_CANCELLED");
    const child = spawn("python3", ["-c", String(payload.script ?? "")], { cwd: resolve(root), stdio: ["ignore", "pipe", "pipe"] });
    this.children.set(task.attempt_id, child);
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8").slice(0, Math.max(0, 2_000_000 - stdout.length)); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8").slice(0, Math.max(0, 20_000 - stderr.length)); });
    const timeoutMs = Math.min(Number(task.limits?.timeout_seconds ?? 1_800) * 1_000, 86_400_000);
    const code = await new Promise<number>((resolveResult, reject) => {
      const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("PYTHON_TIMEOUT")); }, timeoutMs);
      const abort = () => { child.kill("SIGTERM"); reject(new Error("PYTHON_CANCELLED")); };
      context.signal?.addEventListener("abort", abort, { once: true });
      const cleanup = () => { clearTimeout(timer); context.signal?.removeEventListener("abort", abort); this.children.delete(task.attempt_id); };
      child.once("error", (error) => { cleanup(); reject(error); });
      child.once("close", (value) => { cleanup(); resolveResult(value ?? 1); });
    });
    if (code !== 0) throw new Error("PYTHON_FAILED");
    yield { type: "result", result: { exitCode: code, stdout, stderr } };
  }
  async cancel(attemptId: string): Promise<void> { this.children.get(attemptId)?.kill("SIGTERM"); }
}
