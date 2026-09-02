import { arch, hostname, platform } from "node:os";
import { join } from "node:path";
import { createWorkerDaemon } from "./service.ts";

function arg(name: string): string | undefined { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }
function dataDir(): string { return arg("--data-dir") ?? process.env.PAI_WORKER_DATA_DIR ?? join(process.env.LOCALAPPDATA ?? process.env.HOME ?? ".", ".personal-ai-worker"); }
function origin(): string { return arg("--origin") ?? process.env.PAI_CONTROL_PLANE_ORIGIN ?? "http://127.0.0.1:8080"; }
function json(value: unknown): void { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

const command = process.argv[2] ?? "status";
const root = dataDir(); const service = createWorkerDaemon({ dataDir: root, origin: origin(), name: arg("--name") ?? hostname(), workspaces: process.env.PAI_WORKSPACES_JSON ? JSON.parse(process.env.PAI_WORKSPACES_JSON) : undefined });
if (command === "enroll") { const pending = await service.enrollment.ensure(); json(service.enrollment.isRemoved() ? { status: "removed", message: "Worker 已被 Control Plane 移除，請先執行 reset。" } : pending ? { status: "approved", workerId: pending.workerId } : { status: "waiting", message: "Registration request created or waiting for owner approval.", next: "Personal AI Control Plane -> Workers -> Approve" }); service.db.close(); }
else if (command === "reset") { service.resetLocalIdentity(); json({ status: "reset", dataDir: root, runtimeData: "cleared" }); service.db.close(); }
else if (command === "status") { const token = service.enrollment.readToken(); json({ worker: arg("--name") ?? hostname(), platform: platform(), architecture: arch(), enrolled: Boolean(token), removed: service.enrollment.isRemoved(), workerId: token?.workerId ?? null, origin: origin() }); service.db.close(); }
else if (command === "models") { json({ status: "use_start_to_publish_models", worker: arg("--name") ?? hostname() }); service.db.close(); }
else if (command === "start") { service.daemon.start(); process.on("SIGINT", () => service.daemon.stop()); process.on("SIGTERM", () => service.daemon.stop()); }
else { json({ error: "UNKNOWN_COMMAND", commands: ["enroll", "start", "status", "reset", "models"] }); process.exitCode = 2; service.db.close(); }
