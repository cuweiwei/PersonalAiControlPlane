import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { resolvePathWithinRoots, type CapabilityDescriptor } from "../../../../packages/worker/src/index.ts";
import type { ExecutionEvent, WorkerExecutor, WorkerTaskOffer } from "../runtime.ts";

type ProcessResult = { code: number; stdout: string; stderr: string };
type CommandObservation = { command: string; exitCode: number | null; status: string | null; output: string | null };
type DiffCapture = { patch: string; files: string[] };

const CODEX_OUTPUT_LIMIT = 2_000_000;
const ARTIFACT_OUTPUT_LIMIT = 20_000_000;

function digest(bytes: Uint8Array): string { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }

function parseCommandObservations(stdout: string): CommandObservation[] {
  const observations: CommandObservation[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, any>;
      const item = event.type === "item.completed" && event.item && typeof event.item === "object" ? event.item as Record<string, any> : null;
      if (item?.type !== "command_execution" || typeof item.command !== "string") continue;
      observations.push({
        command: item.command,
        exitCode: typeof item.exit_code === "number" ? item.exit_code : null,
        status: typeof item.status === "string" ? item.status : null,
        output: typeof item.aggregated_output === "string" ? item.aggregated_output : null,
      });
    } catch {
      // Codex emits JSONL, but a malformed diagnostic line must not break the
      // durable result. The raw line remains in the test-log artifact.
    }
  }
  return observations;
}

function commandMatches(command: string, expected: string): boolean {
  const actual = command.trim();
  const target = expected.trim();
  return actual === target || actual.includes(target) || actual.includes(`'${target}'`) || actual.includes(`\"${target}\"`);
}

function validationFor(expectedCommand: string | undefined, observations: CommandObservation[]): Record<string, any> {
  if (!expectedCommand) return { state: "NOT_RUN", checks: [] };
  const matched = observations.filter((observation) => commandMatches(observation.command, expectedCommand));
  const allPassed = matched.length > 0 && matched.every((observation) => observation.exitCode === 0);
  const state = matched.length === 0 ? "UNKNOWN" : allPassed ? "PASSED" : "FAILED";
  return {
    state,
    checks: [{
      id: "codex.expected_test_command",
      kind: "TEST_COMMAND",
      description: `指定測試命令必須成功：${expectedCommand}`,
      expected: { command: expectedCommand, exitCode: 0 },
      actual: matched.map((observation) => ({ command: observation.command, exitCode: observation.exitCode, status: observation.status })),
      evidence_refs: ["codex.test-log.v1"],
    }],
  };
}

export class CodexExecutor implements WorkerExecutor {
  readonly type = "codex";
  readonly descriptor: CapabilityDescriptor;
  private readonly workspaces: Record<string, string>;
  private readonly executable: string;
  private readonly enabled: boolean;
  private readonly children = new Map<string, ChildProcess>();

  constructor(workspaces: Record<string, string>, executable = "codex", enabled = true) {
    this.workspaces = workspaces;
    this.executable = executable;
    this.enabled = enabled;
    const base = { capability: "codex", runtime: "codex", runtimeVersion: "2", status: "READY" as const, maxConcurrency: 1, properties: { workspaceIds: Object.keys(workspaces) } };
    this.descriptor = { ...base, properties: base.properties };
  }

  canExecute(task: WorkerTaskOffer): boolean { return this.enabled && task.task_type === "codex" && Boolean((task.payload as any)?.workspace_id ?? (task.execution as any)?.workspace_id); }

  async discover() {
    if (!this.enabled) return { capabilities: [], models: [] };
    const healthy = await new Promise<boolean>((resolveResult) => {
      const child = spawn(this.executable, ["--version"], { stdio: "ignore" });
      child.once("error", () => resolveResult(false));
      child.once("close", (code) => resolveResult(code === 0));
    });
    const descriptor = { ...this.descriptor, status: healthy ? "READY" as const : "UNAVAILABLE" as const };
    return { capabilities: [{ capability: "codex", runtime: "codex", status: descriptor.status, max_concurrency: 1, descriptor }], models: [] };
  }

  async *execute(task: WorkerTaskOffer, context: { signal?: AbortSignal } = {}): AsyncIterable<ExecutionEvent> {
    const payload = task.payload as any;
    const id = String(payload.workspace_id ?? (task.execution as any)?.workspace_id ?? "");
    const configured = this.workspaces[id];
    if (!configured || !existsSync(configured)) throw new Error("WORKSPACE_UNAVAILABLE");
    const cwd = resolve(configured);
    if (!resolvePathWithinRoots(cwd, [cwd])) throw new Error("WORKSPACE_PATH_INVALID");
    const instruction = String(payload.instruction ?? task.instruction);
    const timeoutMs = Math.min(Number(task.limits?.timeout_seconds ?? 1_800) * 1_000, 86_400_000);
    yield { type: "progress", progress: { phase: "codex.start", workspaceId: id } };
    const output = await this.run(["exec", "--json", "--sandbox", "workspace-write", "--cd", cwd, instruction], cwd, timeoutMs, task.attempt_id, context.signal);
    if (output.code !== 0) throw new Error("CODEX_FAILED");

    const observations = parseCommandObservations(output.stdout);
    const expectedCommand = typeof payload.expected_test_command === "string" && payload.expected_test_command.trim() ? payload.expected_test_command.trim() : undefined;
    const matched = expectedCommand ? observations.filter((observation) => commandMatches(observation.command, expectedCommand)) : [];
    const commandExitCodes = observations.filter((observation) => observation.exitCode !== null).map((observation) => observation.exitCode as number);
    const userCommandExitCode = matched.length > 0 ? matched.at(-1)?.exitCode ?? null : null;
    const validation = validationFor(expectedCommand, observations);
    const diff = await this.captureDiff(cwd, timeoutMs, task.attempt_id, context.signal);
    const testLog = Buffer.from([
      `runner_exit_code=${output.code}`,
      `expected_test_command=${expectedCommand ?? ""}`,
      `observed_command_executions=${JSON.stringify(observations)}`,
      "",
      "----- codex stdout -----",
      output.stdout,
      "----- codex stderr -----",
      output.stderr,
    ].join("\n"), "utf8");
    const diffBytes = Buffer.from(diff.patch, "utf8");
    const artifactSpecs = [
      { artifactKey: "codex.diff.v1", filename: "codex-diff.patch", mediaType: "text/x-diff", bytes: diffBytes },
      { artifactKey: "codex.test-log.v1", filename: "codex-test.log", mediaType: "text/plain", bytes: testLog },
    ];
    for (const artifact of artifactSpecs) {
      if (artifact.bytes.byteLength > ARTIFACT_OUTPUT_LIMIT) throw new Error("CODEX_ARTIFACT_TOO_LARGE");
      yield { type: "artifact", artifact: { artifact_key: artifact.artifactKey, filename: artifact.filename, media_type: artifact.mediaType, sha256: digest(artifact.bytes), data_base64: artifact.bytes.toString("base64") } };
    }
    const artifacts = artifactSpecs.map((artifact) => ({ artifact_key: artifact.artifactKey, filename: artifact.filename, media_type: artifact.mediaType, size_bytes: artifact.bytes.byteLength, sha256: digest(artifact.bytes) }));
    const result = {
      workspaceId: id,
      workspace: basename(cwd),
      runnerExitCode: output.code,
      exitCode: output.code,
      userCommandExitCode,
      commandExitCodes,
      expectedTestCommand: expectedCommand ?? null,
      stdout: output.stdout.slice(-CODEX_OUTPUT_LIMIT),
      stderr: output.stderr.slice(-20_000),
    };
    const resultManifest = {
      schema_version: 1,
      kind: "CODEX",
      summary: `Codex runner ${output.code}; user command ${userCommandExitCode ?? "not observed"}`,
      text: output.stdout.slice(-CODEX_OUTPUT_LIMIT),
      format: "plain",
      execution: { worker_id: task.execution?.worker_id ?? null, runtime: "codex", model_id: null, workspace_id: id, runner_exit_code: output.code, user_command_exit_code: userCommandExitCode },
      changes: { state: "OBSERVED", files: diff.files, diff_artifact_key: "codex.diff.v1", diff_artifact_id: null, attribution: "WORKER_OBSERVED" },
      validation,
      artifacts,
      metrics: { command_count: observations.length, command_exit_codes: commandExitCodes },
    };
    yield { type: "result", result, result_manifest: resultManifest };
  }

  async cancel(attemptId: string): Promise<void> { this.children.get(attemptId)?.kill("SIGTERM"); }

  private async captureDiff(cwd: string, timeoutMs: number, attemptId: string, signal?: AbortSignal): Promise<DiffCapture> {
    const status = await this.runProcess("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], cwd, timeoutMs, attemptId, signal);
    if (status.code !== 0) throw new Error("CODEX_DIFF_CAPTURE_FAILED");
    const tracked = await this.runProcess("git", ["diff", "--binary", "--no-ext-diff", "--"], cwd, timeoutMs, attemptId, signal);
    if (tracked.code !== 0) throw new Error("CODEX_DIFF_CAPTURE_FAILED");
    const files: string[] = [];
    const untrackedDiffs: string[] = [];
    for (const entry of status.stdout.split("\0").filter(Boolean)) {
      const path = entry.slice(3);
      if (!path) continue;
      files.push(path);
      if (!entry.startsWith("?? ")) continue;
      const absolute = resolve(cwd, path);
      if (!resolvePathWithinRoots(absolute, [cwd])) throw new Error("CODEX_DIFF_PATH_INVALID");
      const untracked = await this.runProcess("git", ["diff", "--no-index", "--binary", "--", "/dev/null", absolute], cwd, timeoutMs, attemptId, signal);
      if (untracked.code !== 0 && untracked.code !== 1) throw new Error("CODEX_DIFF_CAPTURE_FAILED");
      untrackedDiffs.push(untracked.stdout);
    }
    const patch = `${tracked.stdout}${untrackedDiffs.join("")}`;
    if (Buffer.byteLength(patch, "utf8") > ARTIFACT_OUTPUT_LIMIT) throw new Error("CODEX_ARTIFACT_TOO_LARGE");
    return { patch, files: [...new Set(files)] };
  }

  private run(args: string[], cwd: string, timeoutMs: number, attemptId: string, signal?: AbortSignal): Promise<ProcessResult> { return this.runProcess(this.executable, args, cwd, timeoutMs, attemptId, signal, CODEX_OUTPUT_LIMIT); }

  private runProcess(executable: string, args: string[], cwd: string, timeoutMs: number, attemptId: string, signal?: AbortSignal, outputLimit = CODEX_OUTPUT_LIMIT): Promise<ProcessResult> {
    return new Promise((resolveResult, reject) => {
      if (signal?.aborted) { reject(new Error("CODEX_CANCELLED")); return; }
      const inherited = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR", "CODEX_HOME", "NO_COLOR"];
      const env = Object.fromEntries(inherited.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key] as string]]));
      const child = spawn(executable, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env });
      this.children.set(attemptId, child);
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("CODEX_TIMEOUT")); }, timeoutMs);
      const abort = () => { child.kill("SIGTERM"); reject(new Error("CODEX_CANCELLED")); };
      signal?.addEventListener("abort", abort, { once: true });
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); this.children.delete(attemptId); };
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8").slice(0, Math.max(0, outputLimit - stdout.length)); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8").slice(0, Math.max(0, 20_000 - stderr.length)); });
      child.once("error", (error) => { cleanup(); reject(error); });
      child.once("close", (code) => { cleanup(); resolveResult({ code: code ?? 1, stdout, stderr }); });
    });
  }
}
