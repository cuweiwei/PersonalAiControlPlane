import { arch, cpus, freemem, homedir, hostname, loadavg, platform, totalmem } from "node:os";
import { join } from "node:path";
import { WorkerLocalDatabase } from "./local-db.ts";
import { WorkerDaemon } from "./daemon.ts";
import { OutboundWorkerRuntime, type WorkerExecutor } from "./runtime.ts";
import { WorkerWebSocketTransport, WorkerTransportError, createWorkerCredentialStore } from "./transport.ts";
import { WorkerEnrollment, type Pending } from "./enrollment.ts";
import { OpenAICompatibleExecutor } from "./executors/openai-compatible.ts";
import { OllamaExecutor } from "./executors/ollama.ts";
import { CodexExecutor } from "./executors/codex.ts";
import { PythonExecutor } from "./executors/python.ts";
import { CommandExecutor, type CommandProfile } from "./executors/command.ts";
import { configPath, readWorkerConfig } from "./config.ts";

function flag(name: string, fallback = false): boolean { return process.env[name] === undefined ? fallback : process.env[name] === "true"; }
function mapEnv(name: string): Record<string, string> { try { const value = JSON.parse(process.env[name] ?? "{}"); return value && typeof value === "object" ? value as Record<string, string> : {}; } catch { return {}; } }
export type WorkerServiceOptions = { dataDir: string; origin: string; name?: string; workspaces?: Record<string, string>; pollIntervalMs?: number; heartbeatIntervalMs?: number };
function providerReports(): Array<Record<string, string>> {
  const providers: Array<[string, string, boolean]> = [
    ["omlx", "PAI_OMLX_ENABLED", true], ["lmstudio", "PAI_LMSTUDIO_ENABLED", true], ["ollama", "PAI_OLLAMA_ENABLED", true], ["codex", "PAI_CODEX_ENABLED", false], ["python", "PAI_PYTHON_ENABLED", false], ["command", "PAI_COMMAND_ENABLED", false],
  ];
  return providers.filter(([, flagName, fallback]) => flag(flagName, fallback)).map(([provider]) => ({ provider, evidence_level: "implemented_local" }));
}
export function createWorkerDaemon(options: WorkerServiceOptions): { daemon: WorkerDaemon; db: WorkerLocalDatabase; enrollment: WorkerEnrollment; resetLocalIdentity: () => void } {
  const db = new WorkerLocalDatabase(join(options.dataDir, "worker.db"));
  const enrollment = new WorkerEnrollment({ dataDir: options.dataDir, origin: options.origin, name: options.name ?? hostname(), platform: platform(), hostname: hostname(), agentVersion: "2.0.0", hardware: { cpu: cpus().map((cpu) => cpu.model), memory_mb: Math.floor(totalmem() / 1_048_576), architecture: arch() }, tokenStore: createWorkerCredentialStore(join(options.dataDir, "worker-token.json")), pendingStore: createWorkerCredentialStore<Pending>(join(options.dataDir, "registration.json"), "registration") });
  const config = readWorkerConfig(configPath(options.dataDir)); const configuredWorkspaces = Object.fromEntries(Object.entries(config.workspaces).map(([id, value]) => [id, value.path]));
  const workspaces = { ...configuredWorkspaces, ...mapEnv("PAI_WORKSPACES_JSON"), ...(options.workspaces ?? {}) };
  const configured = (name: string, fallback = false): boolean => { const key = name.replace(/^PAI_/, "").replace(/_ENABLED$/, "").toLowerCase(); return process.env[name] === undefined && config.executors[key]?.enabled !== undefined ? config.executors[key]!.enabled === true : flag(name, fallback); };
  const omlxBaseUrl = process.env.PAI_OMLX_BASE_URL ?? "http://127.0.0.1:8000/v1";
  const executors: WorkerExecutor[] = [
    new OpenAICompatibleExecutor({ runtime: "omlx", baseUrl: omlxBaseUrl, statusUrl: process.env.PAI_OMLX_STATUS_URL ?? `${omlxBaseUrl.replace(/\/$/, "")}/models/status`, enabled: configured("PAI_OMLX_ENABLED", true), apiKey: process.env.PAI_OMLX_API_KEY, apiKeyFile: process.env.PAI_OMLX_API_KEY_FILE ?? join(homedir(), ".omlx", "settings.json"), healthUrl: process.env.PAI_OMLX_HEALTH_URL ?? "http://127.0.0.1:8000/health" }),
    new OpenAICompatibleExecutor({ runtime: "lmstudio", baseUrl: process.env.PAI_LMSTUDIO_BASE_URL ?? "http://127.0.0.1:1234/v1", enabled: configured("PAI_LMSTUDIO_ENABLED", true) }),
    new OllamaExecutor(process.env.PAI_OLLAMA_BASE_URL ?? "http://127.0.0.1:11434", configured("PAI_OLLAMA_ENABLED", true)),
    new CodexExecutor(workspaces, process.env.PAI_CODEX_EXECUTABLE ?? "codex", configured("PAI_CODEX_ENABLED")),
    new PythonExecutor(workspaces, configured("PAI_PYTHON_ENABLED")),
    new CommandExecutor((() => { try { return JSON.parse(process.env.PAI_COMMAND_PROFILES_JSON ?? "{}") as Record<string, CommandProfile>; } catch { return {}; } })(), configured("PAI_COMMAND_ENABLED")),
  ];
  let runtime: OutboundWorkerRuntime | undefined;
  const runtimeWorkspaces = Object.fromEntries(Object.entries(workspaces).map(([id, path]) => [id, { name: config.workspaces[id]?.name ?? id, path }]));
  const createRuntime = async (): Promise<OutboundWorkerRuntime | undefined> => { if (enrollment.isRemoved()) return undefined; const token = await enrollment.ensure(); if (!token) return undefined; const transport = new WorkerWebSocketTransport(token.origin, token.workerId, token.token); runtime = new OutboundWorkerRuntime({ workerId: token.workerId, db, transport, executors, workspaces: runtimeWorkspaces, report: () => ({ system: { os: platform(), architecture: arch(), cpu: cpus().length }, resources: { cpu: { usagePercent: loadavg()[0] ?? 0 }, memory: { totalMb: Math.floor(totalmem() / 1_048_576), freeMb: Math.floor(freemem() / 1_048_576) } }, execution: { running_tasks: Number(db.connection.prepare("SELECT COUNT(*) AS count FROM assignments WHERE status = 'RUNNING'").get()?.count ?? 0), max_concurrency: 1 }, connection: { transport: "wss", fallback: "none" }, providers: providerReports() }) }); return runtime; };
  const resetLocalIdentity = (): void => { enrollment.reset(); db.clearRuntimeData(); };
  const daemon = new WorkerDaemon({ createRuntime, isTerminal: () => enrollment.isRemoved(), pollIntervalMs: options.pollIntervalMs ?? 5_000, heartbeatIntervalMs: options.heartbeatIntervalMs ?? 30_000, onError: (error) => { if (error instanceof WorkerTransportError) { if (error.code === "WORKER_REMOVED") { enrollment.markRemoved(runtime?.workerId); db.clearRuntimeData(); } runtime = undefined; } console.error(JSON.stringify({ event: "worker.error", code: error instanceof Error ? error.message : "WORKER_FAILED" })); } });
  return { daemon, db, enrollment, resetLocalIdentity };
}
