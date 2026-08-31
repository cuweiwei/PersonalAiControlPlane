import { join } from "node:path";
import { WorkerDatabase } from "./db.ts";
import { CodexExecAdapter } from "./codex-adapter.ts";
import { WorkerDaemon } from "./daemon.ts";
import { FileDeviceKeyStore, FileWorkerCredentialStore, WorkerWebSocketTransport } from "./transport.ts";
import { OutboundWorkerRuntime } from "./runtime.ts";
import { importActionGrantPublicKey } from "../../../packages/identity/src/index.ts";
import { readFileSync } from "node:fs";
import { hostname, arch } from "node:os";
import { WorkerBootstrap } from "./bootstrap.ts";

export type WorkerServiceOptions = {
  dataDir: string;
  origin: string;
  repositories: Record<string, string>;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
};

export function createWorkerDaemon(options: WorkerServiceOptions): { daemon: WorkerDaemon; db: WorkerDatabase; storageClass: string } {
  const db = new WorkerDatabase(join(options.dataDir, "worker.db"));
  const keyStore = new FileDeviceKeyStore(join(options.dataDir, "device-key.json"));
  const credentialStore = new FileWorkerCredentialStore(join(options.dataDir, "credential.json"));
  const bootstrap = new WorkerBootstrap({ origin: options.origin, keyStore, credentialStore, enrollmentPath: join(options.dataDir, "enrollment.json"), deviceSummary: { name: hostname(), platform: process.platform, arch: arch(), version: "0.1.0" }, onEvent: (event) => console.log(JSON.stringify(event)) });
  const grantKid = process.env.PAI_WORKER_GRANT_KID;
  const grantPublicKeyPem = process.env.PAI_WORKER_GRANT_PUBLIC_KEY_PEM ?? (process.env.PAI_WORKER_GRANT_PUBLIC_KEY_FILE ? readFileSync(process.env.PAI_WORKER_GRANT_PUBLIC_KEY_FILE, "utf8") : undefined);
  const grantKey = grantKid && grantPublicKeyPem ? importActionGrantPublicKey(grantKid, grantPublicKeyPem) : undefined;
  const createRuntime = async (): Promise<OutboundWorkerRuntime | undefined> => {
    const credentials = await bootstrap.ensureCredential();
    if (!credentials) return undefined;
    const adapter = new CodexExecAdapter({ repositories: options.repositories, codexHome: join(options.dataDir, "codex-home") });
    const transport = new WorkerWebSocketTransport({ origin: options.origin, workerId: credentials.workerId, credential: credentials.credential, credentialProvider: () => credentialStore.read()?.credential, db, signer: (payload) => keyStore.sign(payload), descriptor: adapter.descriptor });
    return new OutboundWorkerRuntime({ workerId: credentials.workerId, connectionId: transport.activeConnectionId, db, transport, adapter, resolveGrantKey: (kid) => grantKey && kid === grantKey.kid ? grantKey : undefined, signFrame: (payload: Buffer) => keyStore.sign(payload) });
  };
  return { daemon: new WorkerDaemon({ createRuntime, beforePoll: async () => Boolean(await bootstrap.ensureCredential()), pollIntervalMs: options.pollIntervalMs, heartbeatIntervalMs: options.heartbeatIntervalMs, onError: (error) => console.error(JSON.stringify({ event: "worker.error", error: error instanceof Error ? error.message : String(error) })) }), db, storageClass: `${keyStore.storageClass}/${credentialStore.storageClass}` };
}
