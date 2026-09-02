import { arch, cpus, freemem, hostname, loadavg, platform, totalmem } from "node:os";
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

function flag(name: string, fallback = false): boolean { return process.env[name] === undefined ? fallback : process.env[name] === "true"; }
function mapEnv(name: string): Record<string, string> { try { const value = JSON.parse(process.env[name] ?? "{}"); return value && typeof value === "object" ? value as Record<string, string> : {}; } catch { return {}; } }
export type WorkerServiceOptions = { dataDir: string; origin: string; name?: string; workspaces?: Record<string, string>; pollIntervalMs?: number; heartbeatIntervalMs?: number };
function providerReports(): Array<Record<string, string>> { return [
  ["omlx", "PAI_OMLX_ENABLED"], ["lmstudio", "PAI_LMSTUDIO_ENABLED"], ["ollama", "PAI_OLLAMA_ENABLED"], ["codex", "PAI_CODEX_ENABLED"], ["python", "PAI_PYTHON_ENABLED"], ["command", "PAI_COMMAND_ENABLED"],
].filter(([, flagName]) => process.env[flagName] === "true").map(([provider]) => ({ provider, evidence_level: "implemented_local" })); }
export function createWorkerDaemon(options: WorkerServiceOptions): { daemon: WorkerDaemon; db: WorkerLocalDatabase; enrollment: WorkerEnrollment; resetLocalIdentity: () => void } {
  const db = new WorkerLocalDatabase(join(options.dataDir, "worker.db"));
  const enrollment = new WorkerEnrollment({ dataDir: options.dataDir, origin: options.origin, name: options.name ?? hostname(), platform: platform(), hostname: hostname(), agentVersion: "2.0.0", hardware: { cpu: cpus().map((cpu) => cpu.model), memory_mb: Math.floor(totalmem() / 1_048_576), architecture: arch() }, tokenStore: createWorkerCredentialStore(join(options.dataDir, "worker-token.json")), pendingStore: createWorkerCredentialStore<Pending>(join(options.dataDir, "registration.json"), "registration") });
  const workspaces = options.workspaces ?? mapEnv("PAI_WORKSPACES_JSON");
  const executors: WorkerExecutor[] = [
    new OpenAICompatibleExecutor({ runtime: "omlx", baseUrl: process.env.PAI_OMLX_BASE_URL ?? "http://127.0.0.1:8000/v1", enabled: flag("PAI_OMLX_ENABLED") }),
    new OpenAICompatibleExecutor({ runtime: "lmstudio", baseUrl: process.env.PAI_LMSTUDIO_BASE_URL ?? "http://127.0.0.1:1234/v1", enabled: flag("PAI_LMSTUDIO_ENABLED") }),
    new OllamaExecutor(process.env.PAI_OLLAMA_BASE_URL ?? "http://127.0.0.1:11434", flag("PAI_OLLAMA_ENABLED")),
    new CodexExecutor(workspaces, process.env.PAI_CODEX_EXECUTABLE ?? "codex", flag("PAI_CODEX_ENABLED")),
    new PythonExecutor(workspaces, flag("PAI_PYTHON_ENABLED")),
    new CommandExecutor((() => { try { return JSON.parse(process.env.PAI_COMMAND_PROFILES_JSON ?? "{}") as Record<string, CommandProfile>; } catch { return {}; } })(), flag("PAI_COMMAND_ENABLED")),
  ];
  let runtime: OutboundWorkerRuntime | undefined;
  const createRuntime = async (): Promise<OutboundWorkerRuntime | undefined> => { if (enrollment.isRemoved()) return undefined; const token = await enrollment.ensure(); if (!token) return undefined; const transport = new WorkerWebSocketTransport(token.origin, token.workerId, token.token); runtime = new OutboundWorkerRuntime({ workerId: token.workerId, db, transport, executors, report: () => ({ system: { os: platform(), architecture: arch(), cpu: cpus().length }, resources: { cpu: { usagePercent: loadavg()[0] ?? 0 }, memory: { totalMb: Math.floor(totalmem() / 1_048_576), freeMb: Math.floor(freemem() / 1_048_576) } }, execution: { running_tasks: Number(db.connection.prepare("SELECT COUNT(*) AS count FROM assignments WHERE status = 'RUNNING'").get()?.count ?? 0), max_concurrency: 1 }, connection: { transport: "wss", fallback: "none" }, providers: providerReports() }) }); return runtime; };
  const resetLocalIdentity = (): void => { enrollment.reset(); db.clearRuntimeData(); };
  const daemon = new WorkerDaemon({ createRuntime, isTerminal: () => enrollment.isRemoved(), pollIntervalMs: options.pollIntervalMs ?? 5_000, heartbeatIntervalMs: options.heartbeatIntervalMs ?? 30_000, onError: (error) => { if (error instanceof WorkerTransportError) { if (error.code === "WORKER_REMOVED") { enrollment.markRemoved(runtime?.workerId); db.clearRuntimeData(); } runtime = undefined; } console.error(JSON.stringify({ event: "worker.error", code: error instanceof Error ? error.message : "WORKER_FAILED" })); } });
  return { daemon, db, enrollment, resetLocalIdentity };
}
