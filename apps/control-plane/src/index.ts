import { join } from "node:path";
import type { Server } from "node:http";
import { ControlPlaneDatabase } from "./db/database.ts";
import { EventHub } from "./events/event-hub.ts";
import { ArtifactStorage } from "./artifacts/artifact-storage.ts";
import { TaskService } from "./tasks/task-service.ts";
import { WorkerService } from "./workers/worker-service.ts";
import { WorkerCoordinator } from "./workers/worker-channel.ts";
import { ResourceScheduler } from "./scheduler/scheduler.ts";
import { HermesCallbackDispatcher } from "./callbacks/outbox.ts";
import { SettingsService } from "./settings/settings-service.ts";
import { HealthMonitor } from "./systems/health-monitor.ts";
import { createControlPlaneServer } from "./server.ts";

function numberEnv(name: string, fallback: number, minimum: number, maximum: number): number { const value = Number(process.env[name] ?? fallback); if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be a bounded integer`); return value; }
function close(server: Server): Promise<void> { return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }

const dataDir = process.env.PAI_DATA_DIR ?? "./data";
const artifactRoot = process.env.PAI_ARTIFACT_DIR ?? join(dataDir, "artifacts");
const port = numberEnv("PAI_PORT", 8080, 1, 65535);
const bindAddress = process.env.PAI_LISTEN_ADDRESS ?? (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
const events = new EventHub();
const db = new ControlPlaneDatabase(join(dataDir, "controlplane.db"));
const artifacts = new ArtifactStorage(artifactRoot);
const tasks = new TaskService(db, events);
const workers = new WorkerService(db, events);
const coordinator = new WorkerCoordinator(workers, tasks, events);
const scheduler = new ResourceScheduler(db, tasks, workers, coordinator, events);
const callback = new HermesCallbackDispatcher(db);
const settings = new SettingsService(db);
const health = new HealthMonitor(db, events);
health.seed();

let schedulerAlive = true;
let coordinatorAlive = true;
let databaseReady = db.isWritable();
let artifactReady = artifacts.isWritable();
const server = createControlPlaneServer({ db, tasks, workers, coordinator, artifacts, settings, health, events, isReady: () => databaseReady && schedulerAlive && coordinatorAlive && artifactReady });
server.on("upgrade", (request, socket, head) => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  if (pathname !== "/worker/ws") { socket.destroy(); return; }
  coordinator.handleUpgrade(request, socket, head);
});

const schedulerTimer = setInterval(() => { try { scheduler.tick(); scheduler.expireTasks(); schedulerAlive = true; } catch (error) { schedulerAlive = false; console.error(JSON.stringify({ event: "scheduler.error", message: error instanceof Error ? error.message : "SCHEDULER_FAILED" })); } }, numberEnv("PAI_SCHEDULER_INTERVAL_MS", 1_000, 100, 60_000));
const staleTimer = setInterval(() => { try { scheduler.staleSweep(Date.now(), numberEnv("PAI_WORKER_OFFLINE_SECONDS", 90, 10, 86_400) * 1_000); } catch (error) { console.error(JSON.stringify({ event: "worker.stale_sweep_error", message: error instanceof Error ? error.message : "STALE_SWEEP_FAILED" })); } }, 15_000);
const healthTimer = setInterval(() => { void health.checkOnce().catch((error) => console.error(JSON.stringify({ event: "system.health_error", message: error instanceof Error ? error.message : "HEALTH_CHECK_FAILED" }))); }, numberEnv("PAI_SYSTEM_HEALTH_INTERVAL_SECONDS", 30, 10, 86_400) * 1_000);
const callbackTimer = setInterval(() => { void callback.dispatchOnce().catch((error) => console.error(JSON.stringify({ event: "hermes.callback_error", message: error instanceof Error ? error.message : "CALLBACK_FAILED" }))); }, 2_000);
const readinessTimer = setInterval(() => { databaseReady = db.isWritable(); artifactReady = artifacts.isWritable(); }, 15_000);

server.listen(port, bindAddress, () => console.log(JSON.stringify({ event: "control-plane.started", version: "2.0.0", port, bindAddress, dataDir, artifactRoot })));

let stopping = false;
async function shutdown(): Promise<void> { if (stopping) return; stopping = true; clearInterval(schedulerTimer); clearInterval(staleTimer); clearInterval(healthTimer); clearInterval(callbackTimer); clearInterval(readinessTimer); coordinator.close(); await close(server); db.close(); }
function signal(): void { void shutdown().catch((error) => { console.error(error); process.exitCode = 1; }); }
process.once("SIGINT", signal); process.once("SIGTERM", signal);
