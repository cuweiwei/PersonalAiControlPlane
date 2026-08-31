import { hostname, platform, arch } from "node:os";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { FileDeviceKeyStore, FileWorkerCredentialStore } from "./transport.ts";
import { createWorkerDaemon } from "./service.ts";
import { WorkerBootstrap } from "./bootstrap.ts";

function arg(name: string): string | undefined { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }
function json(value: unknown): void { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

const dataDir = arg("--data-dir") ?? process.env.PAI_WORKER_DATA_DIR ?? join(process.env.LOCALAPPDATA ?? process.env.HOME ?? ".", ".personal-ai-worker");
const origin = arg("--origin") ?? process.env.PAI_CONTROL_PLANE_ORIGIN ?? "https://gnest.taila77e5f.ts.net";
const keyStore = new FileDeviceKeyStore(join(dataDir, "device-key.json"));
const credentialStore = new FileWorkerCredentialStore(join(dataDir, "credential.json"));
const enrollmentPath = join(dataDir, "enrollment.json");
const bootstrap = new WorkerBootstrap({ origin, keyStore, credentialStore, enrollmentPath, deviceSummary: { name: hostname(), platform: process.platform, arch: arch(), version: "0.1.0" } });

async function enroll(): Promise<void> {
  const body = await bootstrap.requestEnrollment();
  json({ ...body, storageClass: keyStore.storageClass, next: "Owner approves the fingerprint in Control Web; the resident worker will now finalize automatically (manual fallback: pai-worker enroll-finalize)" });
}

async function finalize(): Promise<void> {
  const credential = await bootstrap.finalizeEnrollment({ requestId: arg("--request-id"), challenge: arg("--challenge"), serverNonce: arg("--server-nonce") });
  if (!credential) throw new Error("enrollment is not approved or has no server nonce yet");
  json({ workerId: credential.workerId, credentialId: credential.credentialId, expiresAt: credential.expiresAt, storageClass: credentialStore.storageClass });
}

async function status(): Promise<void> {
  const credential = credentialStore.read();
  json({ origin, dataDir, platform: platform(), arch: arch(), credential: credential ? { workerId: credential.workerId, credentialId: credential.credentialId, expiresAt: credential.expiresAt } : null, deviceKeyStorage: keyStore.storageClass, credentialStorage: credentialStore.storageClass });
}

async function rotate(): Promise<void> {
  const current = credentialStore.read();
  if (!current) throw new Error("worker credential is missing; run enroll-finalize first");
  const response = await fetch(`${current.origin.replace(/\/$/, "")}/api/v1/worker/credentials/rotate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workerId: current.workerId, credential: current.credential }) });
  const body = await response.json();
  if (!response.ok) throw new Error(`credential rotation failed: ${response.status} ${JSON.stringify(body)}`);
  credentialStore.write({ ...current, credentialId: body.credentialId, credential: body.credential, expiresAt: body.expiresAt });
  json({ workerId: current.workerId, credentialId: body.credentialId, expiresAt: body.expiresAt, storageClass: credentialStore.storageClass });
}

async function start(): Promise<void> {
  const repoId = arg("--repo-id");
  const repoPath = arg("--repo-path");
  if (!repoId || !repoPath) throw new Error("--repo-id and --repo-path are required for start");
  const service = createWorkerDaemon({ dataDir, origin, repositories: { [repoId]: repoPath } });
  service.daemon.start();
  process.stdout.write(`${JSON.stringify({ event: "worker.started", origin, workerId: credentialStore.read()?.workerId, storageClass: service.storageClass })}\n`);
  await new Promise<void>((resolve) => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
  service.daemon.stop();
  service.db.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const command = process.argv[2] ?? "status";
    if (command === "enroll") await enroll();
    else if (command === "enroll-finalize") await finalize();
    else if (command === "rotate") await rotate();
    else if (command === "start") await start();
    else if (command === "status" || command === "diagnose") await status();
    else throw new Error(`unsupported command: ${command}`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
