import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { JsonValue } from "../../../../packages/contracts/src/index.ts";
import type { ExecutionEvent, WorkerExecutor, WorkerTaskOffer } from "../runtime.ts";

const execFileAsync = promisify(execFile);
const READ_ONLY = new Set(["observe", "list_windows"]);
const OPERATIONS = new Set(["observe", "list_windows", "click", "move", "drag", "scroll", "type_text", "press_key", "hotkey", "launch_app", "focus_window"]);
const TOOLS: Record<string, string> = {
  observe: "get_window_state",
  list_windows: "list_windows",
  click: "click",
  move: "move_cursor",
  drag: "drag",
  scroll: "scroll",
  type_text: "type_text",
  press_key: "press_key",
  hotkey: "hotkey",
  launch_app: "launch_app",
  focus_window: "bring_to_front",
};

type Runner = (args: string[], signal?: AbortSignal) => Promise<{ stdout: string; stderr: string }>;
export type CuaExecutorOptions = { executable?: string; socket?: string; enabled?: boolean; runner?: Runner; mode?: "mcp" | "cli" };

type MpcResponse = { structuredContent?: unknown; content?: unknown[]; error?: { code?: unknown; message?: unknown } };

/** One long-lived MCP stdio client per Worker executor. */
class CuaDriverMcpClient {
  private readonly executable: string;
  private readonly socket: string;
  private child?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private initialized = false;
  private readonly pending = new Map<number, { resolve: (value: MpcResponse) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  constructor(executable: string, socket: string) { this.executable = executable; this.socket = socket; }

  private fail(error: Error): void {
    for (const [id, item] of this.pending) { clearTimeout(item.timer); item.reject(error); this.pending.delete(id); }
    this.initialized = false;
  }

  private ensureProcess(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed && this.child.exitCode === null) return this.child;
    const child = spawn(this.executable, ["mcp", "--socket", this.socket], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8");
    // Drain diagnostics so a verbose local daemon cannot back-pressure the
    // JSON-RPC stream. Diagnostics are deliberately kept out of receipts.
    child.stderr.on("data", () => {});
    child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let newline = this.buffer.indexOf("\n");
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline).trim(); this.buffer = this.buffer.slice(newline + 1); newline = this.buffer.indexOf("\n");
        if (!line) continue;
        try {
          const message = JSON.parse(line) as { id?: unknown; error?: { code?: unknown; message?: unknown }; result?: MpcResponse };
          const id = Number(message.id); const item = this.pending.get(id); if (!item) continue;
          clearTimeout(item.timer); this.pending.delete(id);
          if (message.error) item.reject(new Error(`CUA_MCP_${String(message.error.code ?? "ERROR")}:${String(message.error.message ?? "driver rejected request")}`));
          else item.resolve(message.result ?? {});
        } catch { /* driver diagnostics are intentionally not promoted to a result */ }
      }
    });
    child.on("error", (error) => this.fail(new Error(`DRIVER_UNAVAILABLE:${error.message}`)));
    child.on("exit", (code, signal) => { this.child = undefined; this.fail(new Error(`DRIVER_UNAVAILABLE: mcp exited (${code ?? signal ?? "unknown"})`)); });
    this.child = child;
    return child;
  }

  private request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<MpcResponse> {
    const child = this.ensureProcess(); const id = this.nextId++;
    return new Promise<MpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("CUA_TIMEOUT")); }, 60_000);
      this.pending.set(id, { resolve, reject, timer });
      const onAbort = () => { clearTimeout(timer); this.pending.delete(id); reject(new Error("CUA_CANCELLED")); };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async call(tool: string, argumentsValue: Record<string, unknown>, signal?: AbortSignal): Promise<MpcResponse> {
    if (!this.initialized) {
      const child = this.ensureProcess();
      await this.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "personal-ai-worker", version: "2" } }, signal);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
      this.initialized = true;
    }
    return this.request("tools/call", { name: tool, arguments: argumentsValue }, signal);
  }

  close(): void { this.child?.kill(); this.child = undefined; this.fail(new Error("CUA_CLIENT_CLOSED")); }
}

function object(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; }
function boundedText(value: unknown, max: number): string { return typeof value === "string" ? value.slice(0, max) : ""; }
function parseOutput(stdout: string): unknown {
  const text = stdout.trim();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { text: text.slice(0, 32_000) }; }
}

function finiteNumber(value: unknown, field: string, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw new Error(`CUA_${field.toUpperCase()}_OUT_OF_RANGE`);
  return number;
}

/**
 * Bounded adapter for Cua Driver's local CLI. The model never supplies the
 * executable, socket, or arbitrary tool name; those are fixed by Worker config.
 */
export class CuaDriverExecutor implements WorkerExecutor {
  readonly type = "cua-driver";
  private readonly executable: string;
  private readonly socket?: string;
  private readonly enabled: boolean;
  private readonly run: Runner;
  private readonly mode: "mcp" | "cli";
  private readonly mcp?: CuaDriverMcpClient;
  private readonly configError?: string;
  private readonly windows = new Map<string, { sessionId: string; pid: number; windowId: number; appName?: string; title?: string }>();
  private supportedOperations = new Set(OPERATIONS);
  private driverVersion = "unknown";

  constructor(options: CuaExecutorOptions = {}) {
    this.executable = options.executable ?? "cua-driver";
    this.socket = options.socket;
    this.enabled = options.enabled === true;
    this.run = options.runner ?? ((args, signal) => execFileAsync(this.executable, args, { signal, maxBuffer: 12 * 1024 * 1024 }));
    this.mode = options.mode ?? (options.runner ? "cli" : "mcp");
    if (this.enabled && !options.runner && !isAbsolute(this.executable)) this.configError = "CUA_EXECUTABLE_ABSOLUTE_REQUIRED";
    if (this.mode === "mcp" && this.socket) this.mcp = new CuaDriverMcpClient(this.executable, this.socket);
  }

  canExecute(task: WorkerTaskOffer): boolean { return this.enabled && task.task_type === "computer.use"; }

  async controlSession(sessionId: string, action: string): Promise<void> {
    if (!this.mcp || !["close", "revoke"].includes(action)) return;
    await this.mcp.call("end_session", { session: boundedText(sessionId, 200) });
  }

  close(): void { this.mcp?.close(); }

  private windowRef(sessionId: string, pid: number, windowId: number, appName?: string, title?: string): string {
    const digest = createHash("sha256").update(`${sessionId}:${pid}:${windowId}:${appName ?? ""}:${title ?? ""}`).digest("hex").slice(0, 24);
    const ref = `win_${digest}`;
    this.windows.set(ref, { sessionId, pid, windowId, appName, title });
    return ref;
  }

  private bindWindowRefs(sessionId: string, value: unknown, allowedApps: string[] = []): unknown {
    if (Array.isArray(value)) return value.map((item) => this.bindWindowRefs(sessionId, item, allowedApps)).filter((item) => item !== undefined);
    if (!value || typeof value !== "object") return value;
    const objectValue = value as Record<string, unknown>;
    const appName = typeof objectValue.app_name === "string" ? objectValue.app_name : typeof objectValue.appName === "string" ? objectValue.appName : undefined;
    if (appName && allowedApps.length > 0 && !allowedApps.includes("*") && !allowedApps.includes(appName)) return undefined;
    const bound = Object.fromEntries(Object.entries(objectValue).map(([key, item]) => [key, this.bindWindowRefs(sessionId, item, allowedApps)]));
    const pid = Number(bound.pid); const windowId = Number(bound.window_id ?? bound.windowId);
    if (Number.isInteger(pid) && pid >= 0 && Number.isInteger(windowId) && windowId >= 0) bound.window_ref = this.windowRef(sessionId, pid, windowId, typeof bound.app_name === "string" ? bound.app_name : undefined, typeof bound.title === "string" ? bound.title : undefined);
    return bound;
  }

  private resolveWindow(sessionId: string, target: Record<string, any>): { pid: number; window_id: number; appName?: string; title?: string } {
    const ref = boundedText(target.window_ref, 200); const binding = ref ? this.windows.get(ref) : undefined;
    if (!binding || binding.sessionId !== sessionId) throw new Error("WINDOW_REF_INVALID");
    return { pid: binding.pid, window_id: binding.windowId, appName: binding.appName, title: binding.title };
  }

  private mcpImage(response: MpcResponse): Buffer | undefined {
    const content = Array.isArray(response.content) ? response.content : [];
    const image = content.find((item) => item && typeof item === "object" && (item as Record<string, unknown>).type === "image") as Record<string, unknown> | undefined;
    if (!image || typeof image.data !== "string") return undefined;
    const bytes = Buffer.from(image.data, "base64");
    if (bytes.byteLength > 8 * 1024 * 1024) throw new Error("CUA_SCREENSHOT_TOO_LARGE");
    return bytes;
  }

  async discover(): Promise<{ capabilities: Record<string, JsonValue>[]; models: Record<string, JsonValue>[] }> {
    if (!this.enabled) return { capabilities: [], models: [] };
    if (this.configError) return { capabilities: [{ capability: "computer.use", runtime: "cua-driver", status: "UNAVAILABLE", evidence_state: "ADVERTISED", error_code: this.configError }], models: [] };
    if (this.mode === "mcp" && !this.socket) return { capabilities: [{ capability: "computer.use", runtime: "cua-driver", status: "UNAVAILABLE", evidence_state: "ADVERTISED", error_code: "DRIVER_ENDPOINT_REQUIRED" }], models: [] };
    try {
      const version = await this.run(["--version"]);
      const versionText = boundedText(version.stdout || version.stderr, 120);
      this.driverVersion = versionText || "unknown";
      const manifestResult = await this.run(["manifest"]);
      const manifest = object(parseOutput(manifestResult.stdout));
      let toolList: unknown = {};
      try { toolList = parseOutput((await this.run(["list-tools", "--json"])).stdout); } catch { /* manifest remains the minimum discovery contract */ }
      const toolNames = new Set<string>();
      if (toolList && typeof toolList === "object" && !Array.isArray(toolList)) {
        for (const key of Object.keys(toolList as Record<string, unknown>)) toolNames.add(key);
        const textOutput = typeof (toolList as Record<string, unknown>).text === "string" ? String((toolList as Record<string, unknown>).text) : "";
        for (const line of textOutput.split(/\r?\n/)) { const match = line.match(/^([a-z][a-z0-9_]+):/); if (match) toolNames.add(match[1]); }
      }
      if (toolNames.size > 0) this.supportedOperations = new Set([...OPERATIONS].filter((operation) => operation === "observe" ? toolNames.has("get_window_state") || toolNames.has("get_desktop_state") : toolNames.has(TOOLS[operation])));
      let permissionState: Record<string, any> = {};
      try { permissionState = object(parseOutput((await this.run(["permissions", "status", "--json"])).stdout)); } catch { /* permission probe is best effort and remains explicit */ }
      const isGranted = (value: unknown): boolean => value === true || value === "granted" || value === "GRANTED";
      const accessibilityGranted = isGranted(permissionState.accessibility);
      const screenRecordingGranted = isGranted(permissionState.screen_recording) || isGranted(permissionState.screenRecording);
      const permissionsGranted = accessibilityGranted && screenRecordingGranted;
      const permissionLabel = (value: unknown, granted: boolean): string => granted ? "granted" : boundedText(value == null ? "unknown" : String(value), 32);
      const status = permissionsGranted && this.supportedOperations.has("observe") ? "READY" : "DEGRADED";
      const manifestHash = `sha256:${createHash("sha256").update(JSON.stringify({ manifest, toolList })).digest("hex")}`;
      return { capabilities: [{ capability: "computer.use", runtime: "cua-driver", contract_version: 1, status, evidence_state: permissionsGranted && this.supportedOperations.has("observe") ? "VERIFIED" : "ADVERTISED", permissions: { accessibility: permissionLabel(permissionState.accessibility, accessibilityGranted), screen_recording: permissionLabel(permissionState.screen_recording ?? permissionState.screenRecording, screenRecordingGranted), status: boundedText(permissionState.status ?? "granted", 32) }, max_concurrency: 1, descriptor: { capability: "computer.use", runtime: "cua-driver", runtime_version: versionText, driver_version: versionText, schema_version: 1, operations: [...this.supportedOperations], desktop_kinds: ["desktop", "window"], capture_scopes: ["window", "desktop"], delivery_modes: ["background", "foreground"], manifest_hash: manifestHash } }], models: [] };
    } catch (error) {
      const message = error instanceof Error ? error.message : "DRIVER_UNAVAILABLE";
      return { capabilities: [{ capability: "computer.use", runtime: "cua-driver", status: "UNAVAILABLE", evidence_state: "ADVERTISED", error_code: boundedText(message, 120) }], models: [] };
    }
  }

  async *execute(task: WorkerTaskOffer, context: { emit(event: ExecutionEvent): Promise<void>; signal?: AbortSignal }): AsyncIterable<ExecutionEvent> {
    const payload = object(task.payload);
    const operation = boundedText(payload.operation, 40);
    if (!OPERATIONS.has(operation)) throw new Error("CUA_OPERATION_UNSUPPORTED");
    if (!this.supportedOperations.has(operation)) throw new Error("DRIVER_SCHEMA_UNSUPPORTED");
    const session = object(payload.session);
    if (String(session.state ?? "") !== "ACTIVE") throw new Error("SESSION_NOT_ACTIVE");
    const expiresAt = Number(session.expires_at ?? 0);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error("SESSION_EXPIRED");
    const args = object(payload.arguments);
    const target = object(payload.target);
    const sessionId = boundedText(payload.session_id, 200);
    const desktopKind = String(target.kind ?? (operation === "list_windows" ? "desktop" : "window"));
    const allowed = Array.isArray(session.allowed_operations) ? session.allowed_operations.map(String) : [];
    if (!allowed.includes(operation)) throw new Error("SESSION_SCOPE_DENIED");
    const approvalRef = boundedText(payload.approval_ref ?? payload.approvalRef, 500);
    if ((payload.sensitive === true || payload.requires_approval === true || payload.requiresApproval === true) && !approvalRef) throw new Error("APPROVAL_REQUIRED");
    const captureScope = String(session.capture_scope ?? (desktopKind === "desktop" ? "desktop" : "window"));
    if (desktopKind === "desktop" && captureScope !== "desktop") throw new Error("CAPTURE_SCOPE_DENIED");
    const allowedApps = Array.isArray(session.allowed_apps) ? session.allowed_apps.map((item) => boundedText(item, 200)) : [];
    if ((operation === "list_windows" || operation === "launch_app" || operation === "focus_window") && allowedApps.length === 0) throw new Error("APP_SCOPE_DENIED");
    if (context.signal?.aborted) throw new Error("CUA_CANCELLED");
    yield { type: "progress", progress: { phase: "computer.use", operation, read_only: READ_ONLY.has(operation) } };

    let tool = TOOLS[operation];
    const input: Record<string, any> = { ...args, session: sessionId };
    if (operation === "observe") {
      if (desktopKind === "desktop") tool = "get_desktop_state";
      else {
        tool = "get_window_state";
        const resolved = this.resolveWindow(sessionId, target); input.pid = resolved.pid; input.window_id = resolved.window_id;
      }
    } else if (operation === "list_windows") {
      delete input.session;
    } else if (operation === "launch_app") {
      delete input.session;
    } else if (operation === "focus_window") {
      const resolved = this.resolveWindow(sessionId, target); input.pid = resolved.pid; input.window_id = resolved.window_id;
      if (resolved.appName && !allowedApps.includes("*") && !allowedApps.includes(resolved.appName)) throw new Error("APP_SCOPE_DENIED");
    } else if (desktopKind === "desktop") {
      input.target = { kind: "desktop", display_id: boundedText(target.display_id || "primary", 80) }; input.scope = "desktop";
    } else {
      const resolved = this.resolveWindow(sessionId, target); input.pid = resolved.pid; input.window_id = resolved.window_id; input.target = { kind: "window", pid: resolved.pid, window_id: resolved.window_id };
    }
    if (["click", "move", "drag"].includes(operation)) {
      input.x = finiteNumber(input.x, "coordinate", -100_000, 100_000);
      input.y = finiteNumber(input.y, "coordinate", -100_000, 100_000);
    }
    if (operation === "drag") {
      input.from_x = input.x; input.from_y = input.y;
      input.to_x = finiteNumber(input.to_x ?? input.end_x, "coordinate", -100_000, 100_000);
      input.to_y = finiteNumber(input.to_y ?? input.end_y, "coordinate", -100_000, 100_000);
      delete input.x; delete input.y;
    }
    if (operation === "scroll") {
      const direction = boundedText(input.direction, 20).toLowerCase();
      if (!["up", "down", "left", "right"].includes(direction)) throw new Error("CUA_DIRECTION_REQUIRED");
      input.direction = direction; input.amount = Math.floor(finiteNumber(input.amount ?? 3, "scroll_amount", 1, 50));
    }
    if (operation === "type_text") input.text = boundedText(input.text, 20_000);
    if (operation === "press_key" || operation === "hotkey") input.key = boundedText(input.key, 100);
    if (operation === "hotkey") {
      if (!Array.isArray(input.keys) && input.key) input.keys = [input.key];
      if (!Array.isArray(input.keys) || input.keys.length < 2) throw new Error("CUA_KEYS_REQUIRED");
      input.keys = input.keys.map((key: unknown) => boundedText(key, 100)).slice(0, 8); delete input.key;
    }
    if (operation === "launch_app") {
      const app = boundedText(input.bundle_id ?? input.name ?? input.app, 200);
      const allowedApps = (session.allowed_apps as unknown[]).map((item) => boundedText(item, 200));
      if (!app || (!allowedApps.includes("*") && !allowedApps.includes(app))) throw new Error("APP_SCOPE_DENIED");
    }
    const temp = await mkdtemp(join(tmpdir(), "pai-cua-"));
    const screenshotPath = operation === "observe" ? join(temp, "observation.png") : undefined;
    const cliArgs = ["call", tool, JSON.stringify(input), ...(this.socket ? ["--socket", this.socket] : []), ...(screenshotPath ? ["--screenshot-out-file", screenshotPath] : [])];
    let output: unknown;
    try {
      if (this.mode === "mcp") {
        if (!this.mcp) throw new Error("DRIVER_ENDPOINT_REQUIRED");
        const response = await this.mcp.call(tool, input, context.signal);
        output = response.structuredContent ?? response.content ?? {};
        const bytes = operation === "observe" ? this.mcpImage(response) : undefined;
        if (bytes) yield { type: "artifact", artifact: { artifact_key: `computer-observation-${String(payload.sequence ?? 0)}`, filename: "observation.png", media_type: "image/png", data_base64: bytes.toString("base64") } };
        if (operation === "list_windows") output = this.bindWindowRefs(sessionId, output, allowedApps);
      } else {
        const result = await this.run(cliArgs, context.signal);
        output = parseOutput(result.stdout);
        if (operation === "list_windows") output = this.bindWindowRefs(sessionId, output, allowedApps);
        if (screenshotPath) {
          try {
            await access(screenshotPath);
            const bytes = await readFile(screenshotPath);
            if (bytes.byteLength > 8 * 1024 * 1024) throw new Error("CUA_SCREENSHOT_TOO_LARGE");
            yield { type: "artifact", artifact: { artifact_key: `computer-observation-${String(payload.sequence ?? 0)}`, filename: "observation.png", media_type: "image/png", data_base64: bytes.toString("base64") } };
          } catch (error) {
            if (error instanceof Error && error.message === "CUA_SCREENSHOT_TOO_LARGE") throw error;
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "CUA_DRIVER_FAILED";
      if (message.includes("ENOENT")) throw new Error("DRIVER_UNAVAILABLE");
      if (message.includes("timed out") || message.includes("TIMEOUT")) throw new Error("CUA_TIMEOUT");
      throw new Error(message.slice(0, 160));
    } finally { await rm(temp, { recursive: true, force: true }); }
    yield { type: "result", result: { session_id: sessionId, operation, driver: "cua-driver", driver_version: this.driverVersion, sequence: Number(payload.sequence ?? 0), desktop_epoch: Number(payload.desktop_epoch ?? 0), before_observation_id: payload.observation_id ?? null, after_observation_id: null, artifact_ids: operation === "observe" ? [`computer-observation-${String(payload.sequence ?? 0)}`] : [], execution_outcome: "COMPLETED", stop_state: "NOT_REQUESTED", output: output as JsonValue, effect_state: READ_ONLY.has(operation) ? "NONE_CONFIRMED" : "UNKNOWN" }, metrics: { driver_calls: 1 } };
  }
}
