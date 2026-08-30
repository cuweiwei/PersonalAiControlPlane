import { TaskEngine } from "./task-engine.ts";
import { OrchestratorDatabase } from "./db.ts";
import { createHttpServer } from "./http.ts";
import { ProcessLock } from "./process-lock.ts";
import { ArchiveDatabase } from "../../archive/src/db.ts";
import { ArchiveService } from "../../archive/src/service.ts";
import { ArchiveBackgroundRuntime } from "../../archive/src/runtime.ts";
import { ContentAddressedArtifactStore } from "../../../packages/artifacts/src/index.ts";
import { OrchestratorRuntime } from "./runtime.ts";

const port = Number.parseInt(process.env.PAI_PORT ?? "9085", 10);
const dbPath = process.env.PAI_ORCHESTRATOR_DB_PATH ?? "./data/orchestrator.db";
const archiveDbPath = process.env.PAI_CONVERSATION_DB_PATH ?? "./data/conversation.db";
const artifactRoot = process.env.PAI_ARTIFACT_ROOT ?? "./data/artifacts";
const lockPath = process.env.PAI_ORCHESTRATOR_LOCK_PATH ?? "./data/orchestrator.lock";
const allowUnauthenticated = process.env.NODE_ENV !== "production" && process.env.PAI_DEV_ALLOW_UNAUTHENTICATED !== "false";
const compatibilityProfile = process.env.PAI_OPERATIONAL_PROFILE === "compatibility";
const identityReady = allowUnauthenticated || process.env.PAI_IDENTITY_READY === "true";
const identityHealthUrl = process.env.PAI_IDENTITY_HEALTH_URL;
const bindHost = process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1";

if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PAI_PORT must be a valid TCP port");

const lock = new ProcessLock(lockPath);
lock.acquire();
const db = new OrchestratorDatabase(dbPath);
const archiveDb = new ArchiveDatabase(archiveDbPath);
const artifactStore = new ContentAddressedArtifactStore(artifactRoot);
const engine = new TaskEngine(db);
const runtime = new OrchestratorRuntime(db, engine, { scheduleOwnerId: process.env.PAI_SCHEDULE_OWNER_ID });
runtime.start();
const archiveService = new ArchiveService(archiveDb, Date.now, (digests) => {
  const removable = digests.filter((digest) => !db.one("SELECT 1 AS value FROM artifact_references WHERE artifact_hash = ? AND released_at IS NULL", digest) && !archiveDb.one("SELECT 1 AS value FROM artifact_references WHERE artifact_hash = ? AND released_at IS NULL", digest));
  const removed = artifactStore.sweep(removable, 0);
  return { removed, remaining: digests.filter((digest) => artifactStore.has(digest)) };
});
const archiveRuntime = new ArchiveBackgroundRuntime(archiveDb, archiveService, artifactStore);
archiveRuntime.start();
const identityReadyProbe = !allowUnauthenticated && identityHealthUrl
  ? async () => { const response = await fetch(identityHealthUrl, { signal: AbortSignal.timeout(1_500) }); return response.ok; }
  : undefined;
const server = createHttpServer({ db, engine, allowUnauthenticated, identityReady, identityReadyProbe, runtimeReady: () => allowUnauthenticated || runtime.isReady(), runtimeRequired: !compatibilityProfile, archiveService });

const shutdown = () => {
  runtime.stop();
  archiveRuntime.stop();
  server.close(() => {
    db.close();
    archiveDb.close();
    lock.release();
  });
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

server.listen(port, bindHost, () => {
  console.log(JSON.stringify({ event: "orchestrator.started", port, dbPath, archiveDbPath, artifactRoot, bindHost, authMode: allowUnauthenticated ? "development" : "identity-gateway", runtimeReady: runtime.isReady() }));
});
