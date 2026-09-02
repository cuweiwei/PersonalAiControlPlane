import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { WebSocket } from "ws";
import type { WorkerTransport } from "./runtime.ts";

export type WorkerTokenRecord = { workerId: string; token: string; origin: string };
export interface WorkerCredentialStore<T extends Record<string, unknown>> { read(): T | undefined; write(value: T): void; clear(): void; }

export class FileWorkerTokenStore<T extends Record<string, unknown> = WorkerTokenRecord> implements WorkerCredentialStore<T> {
  readonly path: string;
  constructor(path: string) { this.path = path; }
  read(): T | undefined { try { return JSON.parse(readFileSync(this.path, "utf8")) as T; } catch { return undefined; } }
  write(value: T): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
  }
  clear(): void { try { unlinkSync(this.path); } catch { /* reset is best effort */ } }
}

function credentialService(path: string): string { return `PersonalAiWorker-${createHash("sha256").update(path).digest("hex").slice(0, 24)}`; }
function encoded(value: unknown): string { return Buffer.from(JSON.stringify(value), "utf8").toString("base64"); }
function decoded<T>(value: string): T | undefined { try { return JSON.parse(Buffer.from(value.trim(), "base64").toString("utf8")) as T; } catch { return undefined; } }

/** Native macOS Keychain backend. The file backend remains available for local development and tests. */
export class MacOSKeychainStore<T extends Record<string, unknown>> implements WorkerCredentialStore<T> {
  private readonly service: string;
  private readonly account: string;
  constructor(path: string, account = "worker-token") { this.service = credentialService(path); this.account = account; }
  read(): T | undefined {
    const result = spawnSync("/usr/bin/security", ["find-generic-password", "-a", this.account, "-s", this.service, "-w"], { encoding: "utf8" });
    if (result.status !== 0 || result.error) return undefined;
    return decoded<T>(result.stdout);
  }
  write(value: T): void {
    const result = spawnSync("/usr/bin/security", ["add-generic-password", "-a", this.account, "-s", this.service, "-w", encoded(value), "-U"], { encoding: "utf8" });
    if (result.status !== 0 || result.error) throw new Error("WORKER_CREDENTIAL_STORE_FAILED");
  }
  clear(): void { spawnSync("/usr/bin/security", ["delete-generic-password", "-a", this.account, "-s", this.service], { stdio: "ignore" }); }
}

/** Windows DPAPI backend, scoped to the interactive user running the Worker. */
export class WindowsCredentialStore<T extends Record<string, unknown>> implements WorkerCredentialStore<T> {
  private readonly path: string;
  constructor(path: string) { this.path = path; }
  read(): T | undefined {
    const script = "$p=$args[0]; if (!(Test-Path -LiteralPath $p)) { exit 3 }; $blob=[Convert]::FromBase64String((Get-Content -Raw -LiteralPath $p)); $plain=[Security.Cryptography.ProtectedData]::Unprotect($blob,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))";
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script, this.path], { encoding: "utf8" });
    if (result.status !== 0 || result.error) return undefined;
    return decoded<T>(result.stdout);
  }
  write(value: T): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const script = "$p=$args[0]; $plain=[Convert]::FromBase64String($args[1]); $blob=[Security.Cryptography.ProtectedData]::Protect($plain,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [IO.File]::WriteAllText($p,[Convert]::ToBase64String($blob))";
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script, this.path, encoded(value)], { encoding: "utf8" });
    if (result.status !== 0 || result.error) throw new Error("WORKER_CREDENTIAL_STORE_FAILED");
  }
  clear(): void { try { unlinkSync(this.path); } catch { /* reset is best effort */ } }
}

export function createWorkerCredentialStore<T extends Record<string, unknown>>(path: string, account = "worker-token"): WorkerCredentialStore<T> {
  const backend = (process.env.PAI_WORKER_CREDENTIAL_BACKEND ?? "auto").toLowerCase();
  if (backend === "file") return new FileWorkerTokenStore(path);
  if ((backend === "auto" || backend === "keychain") && process.platform === "darwin") return new MacOSKeychainStore<T>(path, account);
  if ((backend === "auto" || backend === "dpapi" || backend === "credential-manager") && process.platform === "win32") return new WindowsCredentialStore<T>(path);
  if (backend !== "auto") throw new Error(`WORKER_CREDENTIAL_BACKEND_UNAVAILABLE:${backend}`);
  return new FileWorkerTokenStore(path);
}

export function createWorkerTokenStore(path: string): WorkerCredentialStore<WorkerTokenRecord> { return createWorkerCredentialStore<WorkerTokenRecord>(path, "worker-token"); }

export class WorkerTransportError extends Error { readonly name = "WorkerTransportError"; readonly code: string; constructor(message: string, code = "WORKER_TRANSPORT_FAILED") { super(message); this.code = code; } }
export class WorkerWebSocketTransport implements WorkerTransport {
  private socket?: WebSocket;
  private onMessage?: (message: Record<string, any>) => void;
  private onClose?: (error: WorkerTransportError) => void;
  private intentionalClose = false;
  readonly origin: string;
  readonly workerId: string;
  readonly token: string;
  constructor(origin: string, workerId: string, token: string) { this.origin = origin; this.workerId = workerId; this.token = token; }
  connect(onMessage: (message: Record<string, any>) => void, onClose?: (error: WorkerTransportError) => void): Promise<void> {
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.intentionalClose = false;
    const url = this.origin.replace(/^http/, "ws").replace(/\/$/, "") + "/worker/ws";
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { headers: { authorization: `Bearer ${this.token}` } });
      this.socket = socket;
      let opened = false;
      let settled = false;
      let notified = false;
      socket.once("open", () => { opened = true; settled = true; resolve(); });
      socket.on("unexpected-response", (_request, response) => {
        const code = response.statusCode === 410 ? "WORKER_REMOVED" : response.statusCode === 403 ? "WORKER_DISABLED" : response.statusCode === 401 ? "WORKER_AUTH_REJECTED" : "WORKER_TRANSPORT_FAILED";
        const failure = new WorkerTransportError(`worker WebSocket HTTP ${response.statusCode}`, code);
        if (!settled) { settled = true; notified = true; reject(failure); }
        else if (!this.intentionalClose && !notified) { notified = true; this.onClose?.(failure); }
      });
      socket.on("error", (error) => {
        const failure = new WorkerTransportError(error.message || "worker WebSocket error", "WORKER_TRANSPORT_FAILED");
        if (!settled) { settled = true; notified = true; reject(failure); }
        else if (!this.intentionalClose && !notified) { notified = true; this.onClose?.(failure); }
      });
      socket.on("message", (raw) => {
        try { this.onMessage?.(JSON.parse(raw.toString()) as Record<string, any>); } catch { /* malformed server messages are ignored */ }
      });
      socket.on("close", (code) => {
        if (this.socket === socket) this.socket = undefined;
        if (!opened || this.intentionalClose) return;
        const failure = code === 4001
          ? new WorkerTransportError("worker was removed by the control plane", "WORKER_REMOVED")
          : code === 4005
            ? new WorkerTransportError("worker is disabled by the control plane", "WORKER_DISABLED")
            : new WorkerTransportError(`worker WebSocket closed (${code})`, "WORKER_DISCONNECTED");
        if (!notified) { notified = true; this.onClose?.(failure); }
      });
    });
  }
  connected(): boolean { return this.socket?.readyState === WebSocket.OPEN; }
  send(message: Record<string, any>): void { if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new WorkerTransportError("worker WebSocket is not connected", "WORKER_DISCONNECTED"); this.socket.send(JSON.stringify(message)); }
  close(): void { this.intentionalClose = true; this.socket?.close(); this.socket = undefined; }
}

export function newRegistrationSecret(): string { return randomBytes(32).toString("base64url"); }
