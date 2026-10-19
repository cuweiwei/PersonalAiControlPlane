import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { resolvePathWithinRoots, type CapabilityDescriptor } from "../../../../packages/worker/src/index.ts";
import type { ExecutionEvent, WorkerExecutor, WorkerTaskOffer } from "../runtime.ts";

type ProcessResult = { code: number; stdout: string; stderr: string };
type CommandObservation = { command: string; exitCode: number | null; status: string | null };

const OUTPUT_LIMIT = 2_000_000;
const ARTIFACT_LIMIT = 20_000_000;

function digest(bytes: Uint8Array): string { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }

function parseCommandObservations(stdout: string): CommandObservation[] {
  const result: CommandObservation[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, any>;
      const item = event.item && typeof event.item === "object" ? event.item as Record<string, any> : event;
      if (typeof item.command !== "string") continue;
      result.push({ command: item.command, exitCode: typeof item.exit_code === "number" ? item.exit_code : typeof item.exitCode === "number" ? item.exitCode : null, status: typeof item.status === "string" ? item.status : null });
    } catch {
      // Keep raw OpenCode output in the artifact when a diagnostic line is not JSON.
    }
  }
  return result;
}

function commandMatches(actual: string, expected: string): boolean {
  const a = actual.trim(); const e = expected.trim();
  return a === e || a.includes(e) || a.includes(`'${e}'`) || a.includes(`\"${e}\"`);
}

function quoteWindowsArg(value: string): string {
  if (value.length > 0 && !/[\s"&|<>^]/.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/g, "$1$1")}"`;
}

function validation(expected: string | undefined, observations: CommandObservation[]): Record<string, any> {
  if (!expected) return { state: "NOT_RUN", checks: [] };
  const matched = observations.filter((item) => commandMatches(item.command, expected));
  return { state: matched.length === 0 ? "UNKNOWN" : matched.every((item) => item.exitCode === 0) ? "PASSED" : "FAILED", checks: [{ id: "opencode.expected_test_command", kind: "TEST_COMMAND", description: `指定測試命令必須成功：${expected}`, expected: { command: expected, exitCode: 0 }, actual: matched, evidence_refs: ["opencode.output.v1"] }] };
}

export class OpenCodeExecutor implements WorkerExecutor {
  readonly type = "opencode";
  readonly descriptor: CapabilityDescriptor;
  private readonly workspaces: Record<string, string>;
  private readonly executable: string;
  private readonly enabled: boolean;
  private readonly children = new Map<string, ChildProcess>();

  constructor(workspaces: Record<string, string>, executable = "opencode", enabled = false) {
    this.workspaces = workspaces; this.executable = executable; this.enabled = enabled;
    this.descriptor = { capability: "opencode", runtime: "opencode", runtimeVersion: "1", status: "READY", maxConcurrency: 1, properties: { workspaceIds: Object.keys(workspaces) } };
  }

  canExecute(task: WorkerTaskOffer): boolean { return this.enabled && task.task_type === "opencode" && Boolean((task.payload as any)?.workspace_id ?? (task.execution as any)?.workspace_id); }

  async discover() {
    if (!this.enabled) return { capabilities: [], models: [] };
    const version = await this.runProcess(this.executable, ["--version"], process.cwd(), 15_000, `discover-${Date.now()}`, undefined, 20_000).catch(() => undefined);
    const ready = version?.code === 0;
    const descriptor = { ...this.descriptor, status: ready ? "READY" as const : "UNAVAILABLE" as const, ...(ready && version ? { runtime_version: version.stdout.trim().slice(0, 120) } : {}) };
    return { capabilities: [{ capability: "opencode", runtime: "opencode", status: descriptor.status, max_concurrency: 1, descriptor }], models: [] };
  }

  async *execute(task: WorkerTaskOffer, context: { signal?: AbortSignal } = {}): AsyncIterable<ExecutionEvent> {
    const payload = task.payload as any;
    const id = String(payload?.workspace_id ?? (task.execution as any)?.workspace_id ?? "");
    const configured = this.workspaces[id];
    if (!configured || !existsSync(configured)) throw new Error("WORKSPACE_UNAVAILABLE");
    const cwd = resolve(configured);
    if (!resolvePathWithinRoots(cwd, [cwd])) throw new Error("WORKSPACE_PATH_INVALID");
    const instruction = String(payload?.instruction ?? task.instruction).trim();
    if (!instruction) throw new Error("OPENCODE_INSTRUCTION_REQUIRED");
    const timeoutMs = Math.min(Number(task.limits?.timeout_seconds ?? 1_800) * 1_000, 86_400_000);
    const model = typeof payload?.model === "string" ? payload.model : typeof (task.execution as any)?.model?.name === "string" ? (task.execution as any).model.name : undefined;
    const agent = typeof payload?.agent === "string" ? payload.agent.trim() : undefined;
    const args = ["run", "--format", "json", "--dir", cwd, ...(model ? ["--model", model] : []), ...(agent ? ["--agent", agent] : []), instruction];
    yield { type: "progress", progress: { phase: "opencode.start", workspaceId: id, runtime: "opencode" } };
    const output = await this.runProcess(this.executable, args, cwd, timeoutMs, task.attempt_id, context.signal);
    if (output.code !== 0) throw new Error("OPENCODE_FAILED");

    const observations = parseCommandObservations(output.stdout);
    const expected = typeof payload?.expected_test_command === "string" && payload.expected_test_command.trim() ? payload.expected_test_command.trim() : undefined;
    const matched = expected ? observations.filter((item) => commandMatches(item.command, expected)) : [];
    const outputBytes = Buffer.from([`runner_exit_code=${output.code}`, `expected_test_command=${expected ?? ""}`, `observed_command_executions=${JSON.stringify(observations)}`, "", "----- opencode stdout -----", output.stdout, "----- opencode stderr -----", output.stderr].join("\n"), "utf8");
    const diff = await this.captureDiff(cwd, timeoutMs, task.attempt_id, context.signal);
    const diffBytes = Buffer.from(diff.patch, "utf8");
    const specs = [
      { artifactKey: "opencode.output.v1", filename: "opencode-output.log", mediaType: "application/jsonl", bytes: outputBytes },
      { artifactKey: "opencode.diff.v1", filename: "opencode-diff.patch", mediaType: "text/x-diff", bytes: diffBytes },
    ];
    for (const artifact of specs) {
      if (artifact.bytes.byteLength > ARTIFACT_LIMIT) throw new Error("OPENCODE_ARTIFACT_TOO_LARGE");
      yield { type: "artifact", artifact: { artifact_key: artifact.artifactKey, filename: artifact.filename, media_type: artifact.mediaType, sha256: digest(artifact.bytes), data_base64: artifact.bytes.toString("base64") } };
    }
    const artifacts = specs.map((artifact) => ({ artifact_key: artifact.artifactKey, filename: artifact.filename, media_type: artifact.mediaType, size_bytes: artifact.bytes.byteLength, sha256: digest(artifact.bytes) }));
    const result = { workspaceId: id, workspace: basename(cwd), runnerExitCode: output.code, exitCode: output.code, userCommandExitCode: matched.length ? matched.at(-1)?.exitCode ?? null : null, stdout: output.stdout.slice(-OUTPUT_LIMIT), stderr: output.stderr.slice(-20_000), artifacts };
    yield { type: "result", result, result_manifest: { schema_version: 1, kind: "OPENCODE", summary: `OpenCode runner ${output.code}`, text: output.stdout.slice(-OUTPUT_LIMIT), format: "plain", execution: { worker_id: task.execution?.worker_id ?? null, runtime: "opencode", model_id: model ?? null, workspace_id: id, runner_exit_code: output.code, user_command_exit_code: matched.length ? matched.at(-1)?.exitCode ?? null : null }, changes: { state: "OBSERVED", files: diff.files, diff_artifact_key: "opencode.diff.v1", diff_artifact_id: null, attribution: "WORKER_OBSERVED" }, validation: validation(expected, observations), artifacts, metrics: { command_count: observations.length, command_exit_codes: observations.filter((item) => item.exitCode !== null).map((item) => item.exitCode as number) } } };
  }

  async cancel(attemptId: string): Promise<void> { this.children.get(attemptId)?.kill("SIGTERM"); }

  private async captureDiff(cwd: string, timeoutMs: number, attemptId: string, signal?: AbortSignal): Promise<{ patch: string; files: string[] }> {
    const status = await this.runProcess("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], cwd, timeoutMs, attemptId, signal).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    if (status.code !== 0) return { patch: "", files: [] };
    const tracked = await this.runProcess("git", ["diff", "--binary", "--no-ext-diff", "--"], cwd, timeoutMs, attemptId, signal).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    if (tracked.code !== 0) return { patch: "", files: [] };
    const files: string[] = []; const untracked: string[] = [];
    for (const entry of status.stdout.split("\0").filter(Boolean)) {
      const path = entry.slice(3); if (!path) continue; files.push(path);
      if (entry.startsWith("?? ")) { const absolute = resolve(cwd, path); if (!resolvePathWithinRoots(absolute, [cwd])) throw new Error("OPENCODE_DIFF_PATH_INVALID"); const item = await this.runProcess("git", ["diff", "--no-index", "--binary", "--", "/dev/null", absolute], cwd, timeoutMs, attemptId, signal).catch(() => ({ code: 1, stdout: "", stderr: "" })); if (item.code === 0 || item.code === 1) untracked.push(item.stdout); }
    }
    const patch = `${tracked.stdout}${untracked.join("")}`;
    return Buffer.byteLength(patch, "utf8") > ARTIFACT_LIMIT ? (() => { throw new Error("OPENCODE_ARTIFACT_TOO_LARGE"); })() : { patch, files: [...new Set(files)] };
  }

  private runProcess(executable: string, args: string[], cwd: string, timeoutMs: number, attemptId: string, signal?: AbortSignal, outputLimit = OUTPUT_LIMIT): Promise<ProcessResult> {
    return new Promise((resolveResult, reject) => {
      if (signal?.aborted) { reject(new Error("OPENCODE_CANCELLED")); return; }
      const inherited = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "SystemRoot", "ComSpec", "XDG_CONFIG_HOME", "OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "NO_COLOR"];
      const env = Object.fromEntries(inherited.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key] as string]]));
      const windowsShim = process.platform === "win32" && /\.(cmd|bat)$/i.test(executable);
      const child = windowsShim ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", [quoteWindowsArg(executable), ...args.map(quoteWindowsArg)].join(" ")], { cwd, stdio: ["ignore", "pipe", "pipe"], env }) : spawn(executable, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], env });
      this.children.set(attemptId, child);
      let stdout = ""; let stderr = ""; let settled = false;
      const timer = setTimeout(() => { child.kill("SIGTERM"); if (!settled) { settled = true; cleanup(); reject(new Error("OPENCODE_TIMEOUT")); } }, timeoutMs);
      const abort = () => { child.kill("SIGTERM"); if (!settled) { settled = true; cleanup(); reject(new Error("OPENCODE_CANCELLED")); } };
      signal?.addEventListener("abort", abort, { once: true });
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); this.children.delete(attemptId); };
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8").slice(0, Math.max(0, outputLimit - stdout.length)); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8").slice(0, Math.max(0, 20_000 - stderr.length)); });
      child.once("error", (error) => { if (settled) return; settled = true; cleanup(); reject(error); });
      child.once("close", (code) => { if (settled) return; settled = true; cleanup(); resolveResult({ code: code ?? 1, stdout, stderr }); });
    });
  }
}
