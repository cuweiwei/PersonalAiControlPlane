import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { dirname } from "node:path";
import { WebSocket as NodeWebSocket } from "ws";
import { canonicalJson, sha256, uuidv7, type JsonValue } from "../../../packages/crypto/src/index.ts";
import { signWorkerEnvelopeWithSigner, type WorkerEnvelope } from "../../../packages/worker/src/index.ts";
import type { OutboundWorkerTransport, WorkerJobOffer } from "./runtime.ts";
import { WorkerDatabase } from "./db.ts";

type KeyStoreFile = { privateKeyPem: string };
export type CredentialStoreFile = { workerId: string; credentialId: string; credential: string; expiresAt: number; origin: string };

export interface DeviceKeyStore {
  storageClass: "native" | "file-fallback";
  ensure(): Promise<void>;
  publicKeyPem(): Promise<string>;
  sign(payload: Buffer): Promise<Buffer>;
  clear?(): void | Promise<void>;
}

export interface WorkerCredentialStore {
  storageClass: "native" | "file-fallback";
  read(): CredentialStoreFile | undefined;
  write(value: CredentialStoreFile): void;
  clear(): void;
}

export class WorkerTransportError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(operation: string, status: number, code = "WORKER_TRANSPORT_ERROR") {
    super(`${operation} failed: ${status} ${code}`);
    this.name = "WorkerTransportError";
    this.status = status;
    this.code = code;
  }
}

async function throwResponseError(response: Response, operation: string): Promise<never> {
  let code = "WORKER_TRANSPORT_ERROR";
  try {
    const body = await response.clone().json() as { error?: { code?: unknown }; code?: unknown };
    const candidate = body.error?.code ?? body.code;
    if (typeof candidate === "string" && /^[A-Z0-9_.-]{1,80}$/.test(candidate)) code = candidate;
  } catch { /* preserve a bounded generic code when the edge did not return JSON */ }
  throw new WorkerTransportError(operation, response.status, code);
}

/** Development bootstrap store. Production packages must replace this with the native helper. */
export class FileDeviceKeyStore implements DeviceKeyStore {
  readonly storageClass = "file-fallback" as const;
  private privateKey?: KeyObject;
  private readonly path: string;
  constructor(path: string) { this.path = path; }
  async ensure(): Promise<void> {
    let raw: KeyStoreFile | undefined;
    try { raw = JSON.parse(readFileSync(this.path, "utf8")) as KeyStoreFile; } catch { raw = undefined; }
    if (!raw?.privateKeyPem) {
      const { privateKey } = generateKeyPairSync("ed25519");
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify({ privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString() }), { mode: 0o600 });
      chmodSync(this.path, 0o600);
      raw = { privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
    }
    this.privateKey = createPrivateKey(raw.privateKeyPem);
  }
  async publicKeyPem(): Promise<string> {
    await this.ensure();
    return this.privateKey!.asymmetricKeyType === "ed25519" ? createPublicKey(this.privateKey!).export({ type: "spki", format: "pem" }).toString() : "";
  }
  async sign(payload: Buffer): Promise<Buffer> {
    await this.ensure();
    const { sign } = await import("node:crypto");
    return sign(null, payload, this.privateKey!);
  }
  clear(): void {
    this.privateKey = undefined;
    try { unlinkSync(this.path); } catch { /* already absent */ }
  }
}

export class FileWorkerCredentialStore implements WorkerCredentialStore {
  readonly storageClass = "file-fallback" as const;
  private readonly path: string;
  constructor(path: string) { this.path = path; }
  read(): CredentialStoreFile | undefined { try { return JSON.parse(readFileSync(this.path, "utf8")) as CredentialStoreFile; } catch { return undefined; } }
  write(value: CredentialStoreFile): void { mkdirSync(dirname(this.path), { recursive: true }); writeFileSync(this.path, JSON.stringify(value), { mode: 0o600 }); chmodSync(this.path, 0o600); }
  clear(): void { try { writeFileSync(this.path, "", { mode: 0o600 }); } catch { /* best-effort local cleanup */ } }
}

export type WorkerHttpTransportOptions = {
  origin: string;
  workerId: string;
  credential: string;
  credentialProvider?: () => string | undefined;
  db: WorkerDatabase;
  signer: (payload: Buffer) => Buffer | Promise<Buffer>;
  descriptor: Record<string, JsonValue>;
  fetchImpl?: typeof fetch;
  connectionId?: string;
  helloSent?: boolean;
  resetSequence?: boolean;
};

export class WorkerHttpTransport implements OutboundWorkerTransport {
  private readonly fetchImpl: typeof fetch;
  private readonly closeController = new AbortController();
  private helloSent: boolean;
  private connectionId: string;
  private readonly options: WorkerHttpTransportOptions;
  constructor(options: WorkerHttpTransportOptions) {
    this.options = options;
    this.helloSent = options.helloSent ?? false;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.connectionId = options.connectionId ?? uuidv7(Date.now());
    this.writeState("connectionId", this.connectionId);
    if (options.resetSequence !== false) this.writeState("sequence", "-1");
  }
  get activeConnectionId(): string { return this.connectionId; }
  transportMode(): "HTTP_FALLBACK" { return "HTTP_FALLBACK"; }
  markHelloSent(): void { this.helloSent = true; }
  private writeState(key: string, value: string): void { this.options.db.connection.prepare("INSERT INTO worker_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value); }
  private credential(): string { return this.options.credentialProvider?.() ?? this.options.credential; }
  private async hello(): Promise<WorkerEnvelope> {
    const unsigned = { protocolVersion: "1.0", messageId: uuidv7(Date.now()), connectionId: this.connectionId, sequence: 0, workerId: this.options.workerId, sentAt: new Date().toISOString(), nonce: uuidv7(Date.now()).replaceAll("-", ""), type: "worker.hello" as const, payload: this.options.descriptor };
    return signWorkerEnvelopeWithSigner(unsigned, this.options.signer);
  }
  async poll(): Promise<WorkerJobOffer[]> {
    const body: Record<string, unknown> = { workerId: this.options.workerId, credential: this.credential(), connectionId: this.connectionId };
    if (!this.helloSent) body.hello = await this.hello();
    const response = await this.fetchImpl(`${this.options.origin.replace(/\/$/, "")}/api/v1/worker/poll`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body), signal: AbortSignal.any([AbortSignal.timeout(30_000), this.closeController.signal]) });
    if (!response.ok) await throwResponseError(response, "worker poll");
    const result = await response.json() as { connectionId: string; offers: WorkerJobOffer[] };
    if (typeof result.connectionId !== "string" || !Array.isArray(result.offers)) throw new Error("worker poll response is invalid");
    this.connectionId = result.connectionId;
    this.writeState("connectionId", this.connectionId);
    if (!this.helloSent) {
      this.writeState("sequence", "0");
      this.helloSent = true;
    }
    return result.offers;
  }
  async send(frame: WorkerEnvelope): Promise<void> {
    const response = await this.fetchImpl(`${this.options.origin.replace(/\/$/, "")}/api/v1/worker/events`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ workerId: this.options.workerId, credential: this.credential(), frame }), signal: AbortSignal.any([AbortSignal.timeout(30_000), this.closeController.signal]) });
    if (!response.ok) await throwResponseError(response, "worker event");
  }
  close(): void { this.closeController.abort(); }
}

type SocketLike = { readyState: number; send(data: string): void; close(): void; terminate?: () => void; addEventListener(name: string, listener: (event: { data?: unknown }) => void): void };

/** WebSocket-first transport. It falls back to the signed HTTP channel when
 * the desktop runtime or private edge cannot establish WSS. */
export class WorkerWebSocketTransport implements OutboundWorkerTransport {
  private readonly options: WorkerHttpTransportOptions;
  private readonly fallback: WorkerHttpTransport;
  private socket?: SocketLike;
  private connectPromise?: Promise<void>;
  private pollResolver?: (offers: WorkerJobOffer[]) => void;
  private pollRejecter?: (error: unknown) => void;
  private pollTimer?: ReturnType<typeof setTimeout>;
  private helloSent = false;
  private failed = false;
  private readonly connectionId: string;
  constructor(options: WorkerHttpTransportOptions) {
    this.options = options;
    this.connectionId = options.connectionId ?? uuidv7(Date.now());
    this.helloSent = options.helloSent ?? false;
    this.fallback = new WorkerHttpTransport({ ...options, connectionId: this.connectionId, helloSent: options.helloSent ?? false, resetSequence: false });
    if (options.resetSequence !== false) options.db.connection.prepare("INSERT INTO worker_state(key, value) VALUES ('sequence', '-1') ON CONFLICT(key) DO UPDATE SET value = '-1'").run();
  }
  get activeConnectionId(): string { return this.connectionId; }
  transportMode(): "WSS" | "HTTP_FALLBACK" { return this.failed ? "HTTP_FALLBACK" : "WSS"; }
  private terminateSocket(): void { if (this.socket?.terminate) this.socket.terminate(); else this.socket?.close(); this.socket = undefined; }
  private async connect(): Promise<void> {
    if (this.failed) throw new Error("WSS_DISABLED");
    if (this.socket?.readyState === 1) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      const Constructor = NodeWebSocket as unknown as new (url: string) => SocketLike;
      if (!Constructor) { reject(new Error("WSS_UNAVAILABLE")); return; }
      let socket: SocketLike;
      try { socket = new Constructor(this.options.origin.replace(/^http/, "ws").replace(/\/$/, "") + "/api/v1/worker/connect"); } catch (error) { reject(error); return; }
      this.socket = socket;
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", (event) => reject(event));
      socket.addEventListener("close", () => { this.failed = true; this.socket = undefined; if (this.pollTimer) clearTimeout(this.pollTimer); this.pollTimer = undefined; this.pollRejecter?.(new Error("WSS_CLOSED")); this.pollResolver = undefined; this.pollRejecter = undefined; });
      socket.addEventListener("message", (event) => {
        try {
          const body = JSON.parse(typeof event.data === "string" ? event.data : String(event.data)) as { connectionId?: string; offers?: WorkerJobOffer[] };
          if ("error" in body) {
            const errorBody = (body as { error?: { code?: unknown; status?: unknown } }).error;
            throw new WorkerTransportError("worker websocket", Number(errorBody?.status) || 400, typeof errorBody?.code === "string" ? errorBody.code : "WORKER_CHANNEL_ERROR");
          }
          if (body.connectionId && body.connectionId !== this.connectionId) throw new Error("WSS_CONNECTION_CHANGED");
          if (this.pollResolver) { const resolvePoll = this.pollResolver; this.pollResolver = undefined; this.pollRejecter = undefined; if (this.pollTimer) clearTimeout(this.pollTimer); this.pollTimer = undefined; resolvePoll(Array.isArray(body.offers) ? body.offers : []); }
        } catch (error) {
          if (this.pollTimer) clearTimeout(this.pollTimer);
          this.pollTimer = undefined;
          const rejectPoll = this.pollRejecter;
          this.pollResolver = undefined;
          this.pollRejecter = undefined;
          if (rejectPoll) rejectPoll(error);
          else { this.failed = true; this.terminateSocket(); }
        }
      });
    }).finally(() => { this.connectPromise = undefined; });
    await this.connectPromise;
  }
  async poll(): Promise<WorkerJobOffer[]> {
    if (this.failed) return this.fallback.poll();
    try {
      await this.connect();
      const body: Record<string, unknown> = { workerId: this.options.workerId, credential: this.options.credentialProvider?.() ?? this.options.credential, connectionId: this.connectionId };
      if (!this.helloSent) {
        body.hello = await signWorkerEnvelopeWithSigner({ protocolVersion: "1.0", messageId: uuidv7(Date.now()), connectionId: this.connectionId, sequence: 0, workerId: this.options.workerId, sentAt: new Date().toISOString(), nonce: uuidv7(Date.now()).replaceAll("-", ""), type: "worker.hello", payload: this.options.descriptor }, this.options.signer);
        this.helloSent = true;
        this.options.db.connection.prepare("UPDATE worker_state SET value = '0' WHERE key = 'sequence'").run();
      }
      this.socket!.send(JSON.stringify(body));
      const offers = await new Promise<WorkerJobOffer[]>((resolve, reject) => {
        this.pollResolver = resolve;
        this.pollRejecter = reject;
        this.pollTimer = setTimeout(() => { if (this.pollRejecter === reject) { this.pollResolver = undefined; this.pollRejecter = undefined; this.pollTimer = undefined; reject(new Error("WSS_POLL_TIMEOUT")); } }, 30_000);
      });
      if (this.helloSent) this.fallback.markHelloSent();
      return offers;
    } catch (error) {
      if (error instanceof WorkerTransportError && error.status === 410) { this.failed = true; this.terminateSocket(); throw error; }
      this.failed = true;
      this.terminateSocket();
      return this.fallback.poll();
    }
  }
  async send(frame: WorkerEnvelope): Promise<void> {
    if (this.failed) { await this.fallback.send(frame); return; }
    try { await this.connect(); this.socket!.send(JSON.stringify({ workerId: this.options.workerId, credential: this.options.credentialProvider?.() ?? this.options.credential, frame })); }
    catch (error) { if (error instanceof WorkerTransportError && error.status === 410) { this.failed = true; this.terminateSocket(); throw error; } this.failed = true; this.terminateSocket(); await this.fallback.send(frame); }
  }
  close(): void {
    this.failed = true;
    this.fallback.close();
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    this.pollRejecter?.(new Error("WSS_CLOSED"));
    this.pollResolver = undefined;
    this.pollRejecter = undefined;
    this.terminateSocket();
  }
}

export function workerDescriptor(input: { platform: string; version: string; loginMode?: string; sandboxModes?: string[] }): Record<string, JsonValue> {
  const base = { kind: "codex.execute", version: input.version, health: "HEALTHY", properties: { loginMode: input.loginMode ?? "chatgpt", sandboxModes: input.sandboxModes ?? ["workspace_write"], maxConcurrency: 1 } } as Record<string, JsonValue>;
  return { ...base, descriptorHash: sha256(canonicalJson(base)) };
}
