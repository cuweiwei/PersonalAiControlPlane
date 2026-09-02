import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import type { WorkerTransport } from "./runtime.ts";

export type WorkerTokenRecord = { workerId: string; token: string; origin: string };
export class FileWorkerTokenStore {
  readonly path: string;
  constructor(path: string) { this.path = path; }
  read(): WorkerTokenRecord | undefined { try { return JSON.parse(readFileSync(this.path, "utf8")) as WorkerTokenRecord; } catch { return undefined; } }
  write(value: WorkerTokenRecord): void { mkdirSync(dirname(this.path), { recursive: true }); writeFileSync(this.path, `${JSON.stringify(value)}\n`, { mode: 0o600 }); }
  clear(): void { try { writeFileSync(this.path, "", { mode: 0o600 }); } catch { /* reset is best effort */ } }
}

export class WorkerTransportError extends Error { readonly name = "WorkerTransportError"; constructor(message: string, readonly code = "WORKER_TRANSPORT_FAILED") { super(message); } }
export class WorkerWebSocketTransport implements WorkerTransport {
  private socket?: WebSocket;
  private onMessage?: (message: Record<string, any>) => void;
  readonly origin: string;
  readonly workerId: string;
  readonly token: string;
  constructor(origin: string, workerId: string, token: string) { this.origin = origin; this.workerId = workerId; this.token = token; }
  connect(onMessage: (message: Record<string, any>) => void): Promise<void> { this.onMessage = onMessage; const url = this.origin.replace(/^http/, "ws").replace(/\/$/, "") + "/worker/ws"; return new Promise((resolve, reject) => { const socket = new WebSocket(url, { headers: { authorization: `Bearer ${this.token}` } }); this.socket = socket; socket.once("open", () => resolve()); socket.once("error", (error) => reject(new WorkerTransportError(error.message))); socket.on("message", (raw) => { try { this.onMessage?.(JSON.parse(raw.toString()) as Record<string, any>); } catch { /* malformed server messages are ignored */ } }); socket.on("close", () => { if (this.socket === socket) this.socket = undefined; }); }); }
  connected(): boolean { return this.socket?.readyState === WebSocket.OPEN; }
  send(message: Record<string, any>): void { if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new WorkerTransportError("worker WebSocket is not connected", "WORKER_DISCONNECTED"); this.socket.send(JSON.stringify(message)); }
  close(): void { this.socket?.close(); this.socket = undefined; }
}

export function newRegistrationSecret(): string { return randomBytes(32).toString("base64url"); }
