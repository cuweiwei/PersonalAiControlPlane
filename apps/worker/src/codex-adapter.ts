import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { resolvePathWithinRoots, type CapabilityDescriptor } from "../../../packages/worker/src/index.ts";
import { canonicalJson, sha256, type JsonValue } from "../../../packages/crypto/src/index.ts";
import type { WorkerCapabilityAdapter, WorkerJobOffer } from "./runtime.ts";

export type CodexAdapterOptions = {
  repositories: Record<string, string>;
  executable?: string;
  codexHome: string;
  maxRuntimeMs?: number;
  maxOutputBytes?: number;
};

function text(value: unknown): string { return typeof value === "string" ? value : ""; }

export class CodexExecAdapter implements WorkerCapabilityAdapter {
  readonly capabilityId = "codex.execute";
  readonly descriptor: CapabilityDescriptor;
  private readonly options: Required<CodexAdapterOptions>;
  constructor(options: CodexAdapterOptions, version = "1.0.0") {
    this.options = { executable: "codex", maxRuntimeMs: 30 * 60_000, maxOutputBytes: 2_000_000, ...options };
    this.descriptor = {
      kind: this.capabilityId,
      version,
      health: "HEALTHY",
      properties: { loginMode: "chatgpt", sandboxModes: ["workspace_write"], maxConcurrency: 1 },
      descriptorHash: "",
    };
    this.descriptor.descriptorHash = sha256(canonicalJson({ kind: this.descriptor.kind, version: this.descriptor.version, health: this.descriptor.health, properties: this.descriptor.properties } as unknown as JsonValue));
  }
  async probe(): Promise<"HEALTHY" | "DEGRADED" | "UNHEALTHY"> {
    try {
      const result = await this.run(["--version"], process.cwd(), 10_000);
      return result.code === 0 && /codex/i.test(result.stdout) ? "HEALTHY" : "UNHEALTHY";
    } catch { return "UNHEALTHY"; }
  }
  async execute(job: WorkerJobOffer): Promise<{ outcome: "COMPLETED" | "FAILED"; result: Record<string, JsonValue>; checkpoint?: Record<string, JsonValue> }> {
    const input = job.input as Record<string, unknown>;
    const prompt = text(input.prompt);
    const repoId = text(input.repoId);
    if (!prompt || !repoId) return { outcome: "FAILED", result: { code: "CODEX_INPUT_REQUIRES_PROMPT_AND_REPO" } };
    const configured = this.options.repositories[repoId];
    if (!configured || !existsSync(configured)) return { outcome: "FAILED", result: { code: "CODEX_REPOSITORY_NOT_REGISTERED", repoId } };
    const cwd = realpathSync(resolve(configured));
    if (!resolvePathWithinRoots(cwd, [cwd])) return { outcome: "FAILED", result: { code: "CODEX_REPOSITORY_PATH_INVALID" } };
    const env = { ...process.env, CODEX_HOME: this.options.codexHome };
    for (const key of Object.keys(env)) if (/^(OPENAI|CODEX).*KEY|API_KEY/i.test(key)) delete env[key];
    const args = ["exec", "--json", "--sandbox", "workspace-write", "-c", 'approval_policy="never"', "--cd", cwd, prompt];
    const result = await this.run(args, cwd, this.options.maxRuntimeMs, env);
    const output = result.stdout.slice(-this.options.maxOutputBytes);
    const events = output.split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line) as Record<string, JsonValue>; } catch { return { type: "text", text: line } as Record<string, JsonValue>; } });
    const finalEvent = [...events].reverse().find((event) => event.type === "item.completed" || event.type === "turn.completed" || event.type === "message");
    return { outcome: result.code === 0 ? "COMPLETED" : "FAILED", result: { repoId, cwd: basename(cwd), exitCode: result.code, events, final: finalEvent ?? null, stderr: result.stderr.slice(-20_000) } };
  }
  private run(args: string[], cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv = process.env): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(this.options.executable, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { if (stdout.length < this.options.maxOutputBytes) stdout += chunk.toString("utf8").slice(0, this.options.maxOutputBytes - stdout.length); });
      child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 20_000) stderr += chunk.toString("utf8").slice(0, 20_000 - stderr.length); });
      const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("CODEX_TIMEOUT")); }, timeoutMs);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code) => { clearTimeout(timer); resolvePromise({ code: code ?? 1, stdout, stderr }); });
    });
  }
}
