import { IdentityDatabase } from "./db.ts";
import { createIdentityHttpServer } from "./http.ts";
import { IdentityService } from "./service.ts";

const port = Number.parseInt(process.env.PAI_IDENTITY_PORT ?? "9084", 10);
const dbPath = process.env.PAI_IDENTITY_DB_PATH ?? "./data/identity.db";
const passkeyConfigured = process.env.PAI_CANONICAL_ORIGIN !== undefined && process.env.PAI_WEBAUTHN_RP_ID !== undefined;
const bindHost = process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1";
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PAI_IDENTITY_PORT must be a valid TCP port");
const db = new IdentityDatabase(dbPath);
const identity = new IdentityService(db);
const server = createIdentityHttpServer({ db, identity, passkeyConfigured });
const shutdown = () => server.close(() => db.close());
process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
server.listen(port, bindHost, () => console.log(JSON.stringify({ event: "identity.started", port, dbPath, bindHost, passkeyConfigured })));
