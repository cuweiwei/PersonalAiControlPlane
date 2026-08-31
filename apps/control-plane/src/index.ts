import type { Server } from "node:http";
import { ArchiveDatabase } from "../../archive/src/db.ts";
import { ArchiveBackgroundRuntime } from "../../archive/src/runtime.ts";
import { ArchiveService } from "../../archive/src/service.ts";
import { IdentityDatabase } from "../../identity-gateway/src/db.ts";
import { createIdentityHttpServer } from "../../identity-gateway/src/http.ts";
import { IdentityService } from "../../identity-gateway/src/service.ts";
import { PasskeyRpAdapter } from "../../identity-gateway/src/webauthn.ts";
import { OrchestratorDatabase } from "../../orchestrator/src/db.ts";
import { createHttpServer } from "../../orchestrator/src/http.ts";
import { ProcessLock } from "../../orchestrator/src/process-lock.ts";
import { OrchestratorRuntime } from "../../orchestrator/src/runtime.ts";
import { TaskEngine } from "../../orchestrator/src/task-engine.ts";
import { WorkerChannelService } from "../../orchestrator/src/worker-channel.ts";
import { ContentAddressedArtifactStore } from "../../../packages/artifacts/src/index.ts";
import { createControlWebServer } from "./control-web-server.ts";
import { createPrivateEdgeServer } from "./private-edge.ts";

function port(name: string, fallback: string): number {
  const value = Number.parseInt(process.env[name] ?? fallback, 10);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${name} must be a valid TCP port`);
  return value;
}

function close(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}

const controlWebPort = port("PAI_CONTROL_WEB_PORT", "8080");
const identityPort = port("PAI_IDENTITY_PORT", "9084");
const orchestratorPort = port("PAI_PORT", "9085");
const edgePort = port("PAI_EDGE_PORT", "8081");
if (new Set([controlWebPort, identityPort, orchestratorPort]).size !== 3) throw new Error("Control Web, Identity, and Orchestrator ports must be distinct");
if ([controlWebPort, identityPort, orchestratorPort].includes(edgePort)) throw new Error("Private edge port must be distinct from internal service ports");

const bindHost = process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1";
const compatibilityProfile = process.env.PAI_OPERATIONAL_PROFILE === "compatibility";
const allowUnauthenticated = process.env.NODE_ENV !== "production" && process.env.PAI_DEV_ALLOW_UNAUTHENTICATED !== "false";

const identityDbPath = process.env.PAI_IDENTITY_DB_PATH ?? "./data/identity.db";
const identityDb = new IdentityDatabase(identityDbPath);
const identity = new IdentityService(identityDb);
const canonicalOrigin = process.env.PAI_CANONICAL_ORIGIN;
const rpId = process.env.PAI_WEBAUTHN_RP_ID;
const passkeyConfigured = canonicalOrigin !== undefined && rpId !== undefined;
const passkeyAdapter = passkeyConfigured && canonicalOrigin && rpId
  ? new PasskeyRpAdapter({ db: identityDb, identity, rpName: process.env.PAI_WEBAUTHN_RP_NAME ?? "Personal AI Control Plane", rpId, expectedOrigin: canonicalOrigin, bootstrapToken: process.env.PAI_BOOTSTRAP_TOKEN })
  : undefined;
const identityServer = createIdentityHttpServer({ db: identityDb, identity, passkeyConfigured, passkeyAdapterReady: passkeyAdapter !== undefined, passkeyAdapter, canonicalOrigin, actionGrantRequired: !compatibilityProfile });

const orchestratorDbPath = process.env.PAI_ORCHESTRATOR_DB_PATH ?? "./data/orchestrator.db";
const archiveDbPath = process.env.PAI_CONVERSATION_DB_PATH ?? "./data/conversation.db";
const artifactRoot = process.env.PAI_ARTIFACT_ROOT ?? "./data/artifacts";
const lockPath = process.env.PAI_ORCHESTRATOR_LOCK_PATH ?? "./data/orchestrator.lock";
const lock = new ProcessLock(lockPath);
lock.acquire();
const orchestratorDb = new OrchestratorDatabase(orchestratorDbPath);
const archiveDb = new ArchiveDatabase(archiveDbPath);
const artifactStore = new ContentAddressedArtifactStore(artifactRoot);
const engine = new TaskEngine(orchestratorDb);
const runtime = new OrchestratorRuntime(orchestratorDb, engine, { scheduleOwnerId: process.env.PAI_SCHEDULE_OWNER_ID });
runtime.start();
const workerChannel = new WorkerChannelService(orchestratorDb);
const archiveService = new ArchiveService(archiveDb, Date.now, (digests) => {
  const removable = digests.filter((digest) => !orchestratorDb.one("SELECT 1 AS value FROM artifact_references WHERE artifact_hash = ? AND released_at IS NULL", digest) && !archiveDb.one("SELECT 1 AS value FROM artifact_references WHERE artifact_hash = ? AND released_at IS NULL", digest));
  const removed = artifactStore.sweep(removable, 0);
  return { removed, remaining: digests.filter((digest) => artifactStore.has(digest)) };
});
const archiveRuntime = new ArchiveBackgroundRuntime(archiveDb, archiveService, artifactStore);
archiveRuntime.start();
const identityHealthUrl = process.env.PAI_IDENTITY_HEALTH_URL ?? `http://127.0.0.1:${identityPort}/health/ready`;
const identityReadyProbe = allowUnauthenticated
  ? undefined
  : async () => { const response = await fetch(identityHealthUrl, { signal: AbortSignal.timeout(1_500) }); return response.ok; };
const orchestratorServer = createHttpServer({ db: orchestratorDb, engine, allowUnauthenticated, identityReady: allowUnauthenticated, identityReadyProbe, runtimeReady: () => allowUnauthenticated || runtime.isReady(), runtimeRequired: !compatibilityProfile, archiveService, workerChannel });
const controlWebServer = createControlWebServer();
const privateEdgeServer = createPrivateEdgeServer({
  identityOrigin: `http://127.0.0.1:${identityPort}`,
  orchestratorOrigin: `http://127.0.0.1:${orchestratorPort}`,
  controlWebOrigin: `http://127.0.0.1:${controlWebPort}`,
  memoryOrigin: process.env.PAI_MEMORY_ORIGIN,
  publicProto: process.env.NODE_ENV === "production" ? "https" : "http",
});

identityServer.listen(identityPort, bindHost, () => console.log(JSON.stringify({ event: "identity.started", port: identityPort, dbPath: identityDbPath, bindHost, passkeyConfigured, passkeyAdapterReady: passkeyAdapter !== undefined })));
orchestratorServer.listen(orchestratorPort, bindHost, () => console.log(JSON.stringify({ event: "orchestrator.started", port: orchestratorPort, dbPath: orchestratorDbPath, archiveDbPath, artifactRoot, bindHost, authMode: allowUnauthenticated ? "development" : "identity-gateway", runtimeReady: runtime.isReady() })));
controlWebServer.listen(controlWebPort, bindHost, () => console.log(JSON.stringify({ event: "control-web.started", port: controlWebPort, bindHost })));
privateEdgeServer.listen(edgePort, bindHost, () => console.log(JSON.stringify({ event: "private-edge.started", port: edgePort, bindHost })));

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  runtime.stop();
  workerChannel.close();
  archiveRuntime.stop();
  await Promise.all([close(privateEdgeServer), close(controlWebServer), close(orchestratorServer), close(identityServer)]);
  orchestratorDb.close();
  archiveDb.close();
  identityDb.close();
  lock.release();
};
const handleSignal = () => { void shutdown().catch((error) => { console.error(error); process.exitCode = 1; }); };
process.once("SIGINT", handleSignal);
process.once("SIGTERM", handleSignal);
