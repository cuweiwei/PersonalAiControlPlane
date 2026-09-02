import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { validateShellInvocation } from "../../../../packages/worker/src/index.ts";
import type { JsonValue } from "../../../../packages/contracts/src/index.ts";
import type { ExecutionEvent, WorkerExecutor, WorkerTaskOffer } from "../runtime.ts";
export type CommandProfile = {
  command: string[];
  cwd?: string;
  allowedExecutables?: string[];
  roots?: string[];
  allowedEnvironment?: string[];
  maxRuntimeMs?: number;
  maxOutputBytes?: number;
  network?: "none" | "approved";
};
export class CommandExecutor implements WorkerExecutor {
  readonly type = "command";
  private readonly profiles: Record<string, CommandProfile>;
  private readonly enabled: boolean;
  constructor(profiles: Record<string, CommandProfile>, enabled = false) { this.profiles = profiles; this.enabled = enabled; }
  canExecute(task: WorkerTaskOffer): boolean { const profile = this.profiles[String((task.payload as any)?.profile)]; return this.enabled && task.task_type === "command" && Boolean(profile && this.validate(profile).valid); }
  async discover(): Promise<{ capabilities: Record<string, JsonValue>[]; models: Record<string, JsonValue>[] }> {
    const ready = this.enabled && Object.values(this.profiles).some((profile) => this.validate(profile).valid);
    return ready ? { capabilities: [{ capability: "command", status: "READY", max_concurrency: 1 }], models: [] } : { capabilities: [], models: [] };
  }
  async *execute(task: WorkerTaskOffer): AsyncIterable<ExecutionEvent> {
    const profile = this.profiles[String((task.payload as any).profile)];
    if (!profile?.command?.length) throw new Error("COMMAND_PROFILE_INVALID");
    const validation = this.validate(profile); if (!validation.valid) throw new Error(`COMMAND_PROFILE_${validation.reason.toUpperCase().replaceAll("-", "_")}`);
    const cwd = resolve(profile.cwd ?? process.cwd());
    const maxOutputBytes = profile.maxOutputBytes ?? 2_000_000;
    const timeoutMs = Math.min(profile.maxRuntimeMs ?? 300_000, Number(task.limits?.timeout_seconds ?? 1_800) * 1_000);
    const child = spawn(profile.command[0], profile.command.slice(1), { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8").slice(0, Math.max(0, maxOutputBytes - stdout.length)); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8").slice(0, Math.max(0, 20_000 - stderr.length)); });
    const code = await new Promise<number>((resolveResult, reject) => { const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("COMMAND_TIMEOUT")); }, timeoutMs); child.once("error", (error) => { clearTimeout(timer); reject(error); }); child.once("close", (value) => { clearTimeout(timer); resolveResult(value ?? 1); }); });
    if (code !== 0) throw new Error("COMMAND_FAILED");
    yield { type: "result", result: { profile: (task.payload as any).profile, exitCode: code, stdout, stderr } };
  }
  private validate(profile: CommandProfile): { valid: true } | { valid: false; reason: string } {
    if (!Array.isArray(profile.command) || profile.command.length === 0 || profile.command.some((part) => typeof part !== "string" || part.length === 0)) return { valid: false, reason: "invalid-command" };
    const cwd = resolve(profile.cwd ?? process.cwd());
    return validateShellInvocation({ allowedExecutables: profile.allowedExecutables ?? [profile.command[0]], roots: profile.roots ?? [cwd], allowedEnvironment: profile.allowedEnvironment ?? [], maxRuntimeMs: profile.maxRuntimeMs ?? 300_000, maxOutputBytes: profile.maxOutputBytes ?? 2_000_000, network: profile.network ?? "none" }, profile.command[0], profile.command.slice(1), cwd, {});
  }
}
