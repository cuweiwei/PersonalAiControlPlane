import { IdentityDatabase } from "./db.ts";
import { createIdentityHttpServer } from "./http.ts";
import { IdentityService } from "./service.ts";
import { PasskeyRpAdapter } from "./webauthn.ts";

const port = Number.parseInt(process.env.PAI_IDENTITY_PORT ?? "9084", 10);
const dbPath = process.env.PAI_IDENTITY_DB_PATH ?? "./data/identity.db";
const passkeyConfigured = process.env.PAI_CANONICAL_ORIGIN !== undefined && process.env.PAI_WEBAUTHN_RP_ID !== undefined;
const compatibilityProfile = process.env.PAI_OPERATIONAL_PROFILE === "compatibility";
const bindHost = process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1";
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PAI_IDENTITY_PORT must be a valid TCP port");
const db = new IdentityDatabase(dbPath);
const identity = new IdentityService(db);
const canonicalOrigin = process.env.PAI_CANONICAL_ORIGIN;
const rpId = process.env.PAI_WEBAUTHN_RP_ID;
const passkeyAdapter = passkeyConfigured && canonicalOrigin && rpId
  ? new PasskeyRpAdapter({ db, identity, rpName: process.env.PAI_WEBAUTHN_RP_NAME ?? "Personal AI Control Plane", rpId, expectedOrigin: canonicalOrigin, bootstrapToken: process.env.PAI_BOOTSTRAP_TOKEN })
  : undefined;
const server = createIdentityHttpServer({ db, identity, passkeyConfigured, passkeyAdapterReady: passkeyAdapter !== undefined, passkeyAdapter, canonicalOrigin, actionGrantRequired: !compatibilityProfile });
const shutdown = () => server.close(() => db.close());
process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
server.listen(port, bindHost, () => console.log(JSON.stringify({ event: "identity.started", port, dbPath, bindHost, passkeyConfigured, passkeyAdapterReady: passkeyAdapter !== undefined })));
