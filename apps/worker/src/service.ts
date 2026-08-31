import { arch, platform } from "node:os";
import { join } from "node:path";
import { WorkerDatabase } from "./db.ts";
import { CodexExecAdapter } from "./codex-adapter.ts";
import { WorkerDaemon } from "./daemon.ts";
import { FileDeviceKeyStore, FileWorkerCredentialStore, WorkerWebSocketTransport } from "./transport.ts";
import { OutboundWorkerRuntime } from "./runtime.ts";
import { importActionGrantPublicKey } from "../../../packages/identity/src/index.ts";
import { readFileSync } from "node:fs";

export type WorkerServiceOptions = {
  dataDir: string;
  origin: string;
  repositories: Record<string, string>;
};

export function createWorkerDaemon(options: WorkerServiceOptions): { daemon: WorkerDaemon; db: WorkerDatabase; storageClass: string } {
  const db = new WorkerDatabase(join(options.dataDir, "worker.db"));
  const keyStore = new FileDeviceKeyStore(join(options.dataDir, "device-key.json"));
  const credentials = new FileWorkerCredentialStore(join(options.dataDir, "credential.json")).read();
  if (!credentials || credentials.expiresAt <= Date.now()) throw new Error("worker credential is missing or expired; run enroll-finalize or rotate it");
  const adapter = new CodexExecAdapter({ repositories: options.repositories, codexHome: join(options.dataDir, "codex-home") });
  const transport = new WorkerWebSocketTransport({ origin: options.origin, workerId: credentials.workerId, credential: credentials.credential, db, signer: (payload) => keyStore.sign(payload), descriptor: { ...adapter.descriptor, platform: `${platform()}-${arch()}` } });
  const grantKid = process.env.PAI_WORKER_GRANT_KID;
  const grantPublicKeyPem = process.env.PAI_WORKER_GRANT_PUBLIC_KEY_PEM ?? (process.env.PAI_WORKER_GRANT_PUBLIC_KEY_FILE ? readFileSync(process.env.PAI_WORKER_GRANT_PUBLIC_KEY_FILE, "utf8") : undefined);
  const grantKey = grantKid && grantPublicKeyPem ? importActionGrantPublicKey(grantKid, grantPublicKeyPem) : undefined;
  const runtime = new OutboundWorkerRuntime({ workerId: credentials.workerId, connectionId: transport.activeConnectionId, db, transport, adapter, resolveGrantKey: (kid) => grantKey && kid === grantKey.kid ? grantKey : undefined, signFrame: (payload: Buffer) => keyStore.sign(payload) });
  return { daemon: new WorkerDaemon({ runtime, onError: (error) => console.error(JSON.stringify({ event: "worker.error", error: error instanceof Error ? error.message : String(error) })) }), db, storageClass: `${keyStore.storageClass}/${new FileWorkerCredentialStore(join(options.dataDir, "credential.json")).storageClass}` };
}
