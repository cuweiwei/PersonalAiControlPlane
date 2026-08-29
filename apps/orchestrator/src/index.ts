import { TaskEngine } from "./task-engine.ts";
import { OrchestratorDatabase } from "./db.ts";
import { createHttpServer } from "./http.ts";
import { ProcessLock } from "./process-lock.ts";

const port = Number.parseInt(process.env.PAI_PORT ?? "9085", 10);
const dbPath = process.env.PAI_ORCHESTRATOR_DB_PATH ?? "./data/orchestrator.db";
const lockPath = process.env.PAI_ORCHESTRATOR_LOCK_PATH ?? "./data/orchestrator.lock";
const allowUnauthenticated = process.env.NODE_ENV !== "production" && process.env.PAI_DEV_ALLOW_UNAUTHENTICATED !== "false";
const identityReady = allowUnauthenticated || process.env.PAI_IDENTITY_READY === "true";
const bindHost = process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1";

if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PAI_PORT must be a valid TCP port");

const lock = new ProcessLock(lockPath);
lock.acquire();
const db = new OrchestratorDatabase(dbPath);
const engine = new TaskEngine(db);
const server = createHttpServer({ db, engine, allowUnauthenticated, identityReady });

const shutdown = () => {
  server.close(() => {
    db.close();
    lock.release();
  });
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

server.listen(port, bindHost, () => {
  console.log(JSON.stringify({ event: "orchestrator.started", port, dbPath, bindHost, authMode: allowUnauthenticated ? "development" : "identity-gateway" }));
});
