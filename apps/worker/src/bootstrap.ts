import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { enrollmentProofPayload } from "../../../packages/worker/src/index.ts";
import { WorkerTransportError } from "./transport.ts";
import type { CredentialStoreFile, DeviceKeyStore, WorkerCredentialStore } from "./transport.ts";

type EnrollmentState = { requestId: string; challenge: string; expiresAt: number };
type EnrollmentStatus = { status?: string; serverNonce?: string | null; expiresAt?: number; finalized?: boolean };

export type WorkerBootstrapOptions = {
  origin: string;
  keyStore: DeviceKeyStore;
  credentialStore: WorkerCredentialStore;
  enrollmentPath: string;
  removedPath?: string;
  deviceSummary: Record<string, unknown>;
  fetchImpl?: typeof fetch;
  onEvent?: (event: Record<string, unknown>) => void;
};

function safeJson(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export class WorkerBootstrap {
  private readonly options: WorkerBootstrapOptions;
  private readonly fetchImpl: typeof fetch;
  constructor(options: WorkerBootstrapOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Keep the resident process responsive when the private edge is unavailable. */
  private request(url: string, init: RequestInit = {}): Promise<Response> {
    return this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(30_000) });
  }

  async requestEnrollment(): Promise<EnrollmentState & { fingerprint: string; status: string }> {
    if (this.isRemoved()) throw new WorkerTransportError("worker enrollment", 410, "WORKER_REMOVED");
    await this.options.keyStore.ensure();
    const response = await this.request(`${this.baseUrl()}/api/v1/worker/enrollment-requests`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ publicKeyPem: await this.options.keyStore.publicKeyPem(), deviceSummary: this.options.deviceSummary }) });
    const body = safeJson(await response.json());
    if (!response.ok) throw this.responseError("enrollment request", response.status, body);
    if (typeof body.requestId !== "string" || typeof body.challenge !== "string" || typeof body.expiresAt !== "number") throw new Error(`enrollment request failed: ${response.status} invalid response`);
    const state = { requestId: body.requestId, challenge: body.challenge, expiresAt: body.expiresAt };
    this.writeEnrollment(state);
    this.options.onEvent?.({ event: "worker.enrollment.requested", requestId: state.requestId, fingerprint: typeof body.fingerprint === "string" ? body.fingerprint : undefined, expiresAt: state.expiresAt });
    return { ...state, fingerprint: typeof body.fingerprint === "string" ? body.fingerprint : "", status: typeof body.status === "string" ? body.status : "PENDING" };
  }

  async finalizeEnrollment(input?: Partial<EnrollmentState> & { serverNonce?: string }): Promise<CredentialStoreFile | undefined> {
    const pending = this.readEnrollment();
    const requestId = input?.requestId ?? pending?.requestId;
    const challenge = input?.challenge ?? pending?.challenge;
    let serverNonce = input?.serverNonce;
    if (!requestId || !challenge) throw new Error("enrollment state is missing; run enroll first");
    if (!serverNonce) {
      const status = await this.enrollmentStatus(requestId);
      if (status.status !== "APPROVED" || typeof status.serverNonce !== "string") return undefined;
      serverNonce = status.serverNonce;
    }
    await this.options.keyStore.ensure();
    const signature = (await this.options.keyStore.sign(enrollmentProofPayload(challenge, serverNonce))).toString("base64url");
    const response = await this.request(`${this.baseUrl()}/api/v1/worker/enrollment-requests/${encodeURIComponent(requestId)}/finalize`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challenge, serverNonce, workerSignature: signature }) });
    const body = safeJson(await response.json());
    if (!response.ok) throw this.responseError("enrollment finalize", response.status, body);
    if (typeof body.workerId !== "string" || typeof body.credentialId !== "string" || typeof body.credential !== "string" || typeof body.expiresAt !== "number") throw new Error(`enrollment finalize failed: ${response.status} invalid response`);
    const credential: CredentialStoreFile = { workerId: body.workerId, credentialId: body.credentialId, credential: body.credential, expiresAt: body.expiresAt, origin: this.options.origin };
    this.options.credentialStore.write(credential);
    this.clearEnrollment();
    this.options.onEvent?.({ event: "worker.enrollment.finalized", workerId: credential.workerId, credentialId: credential.credentialId, expiresAt: credential.expiresAt });
    return credential;
  }

  async ensureCredential(now = Date.now()): Promise<CredentialStoreFile | undefined> {
    if (this.isRemoved()) return undefined;
    await this.options.keyStore.ensure();
    const current = this.options.credentialStore.read();
    if (current && current.expiresAt > now + 5 * 60_000) return current;
    if (current && current.expiresAt > now) {
      try {
        const rotated = await this.rotate(current);
        if (rotated) return rotated;
      } catch (error) {
        if (current.expiresAt > now + 30_000) return current;
        throw error;
      }
    }
    if (current) this.options.credentialStore.clear();
    const pending = this.readEnrollment();
    if (!pending || pending.expiresAt <= now) {
      await this.requestEnrollment();
      return undefined;
    }
    const status = await this.enrollmentStatus(pending.requestId);
    if (status.status === "APPROVED" && typeof status.serverNonce === "string") return this.finalizeEnrollment({ serverNonce: status.serverNonce });
    if (status.status === "EXPIRED" || status.status === "REJECTED" || status.finalized) this.clearEnrollment();
    return undefined;
  }

  isRemoved(): boolean { return existsSync(this.removedPath()); }

  /** Mark this identity terminal after the server has permanently removed it. */
  markRemoved(reason = "WORKER_REMOVED"): void {
    mkdirSync(dirname(this.removedPath()), { recursive: true });
    writeFileSync(this.removedPath(), JSON.stringify({ reason, markedAt: Date.now() }), { mode: 0o600 });
    chmodSync(this.removedPath(), 0o600);
    this.options.credentialStore.clear();
    this.clearEnrollment();
    this.options.onEvent?.({ event: "worker.removed", reason });
  }

  /** Explicit operator action: erase local identity and runtime enrollment state. */
  async resetLocalIdentity(): Promise<void> {
    await this.options.keyStore.clear?.();
    this.options.credentialStore.clear();
    this.clearEnrollment();
    try { unlinkSync(this.removedPath()); } catch { /* reset may run before a marker exists */ }
    this.options.onEvent?.({ event: "worker.reset" });
  }

  readEnrollment(): EnrollmentState | undefined {
    try {
      const value = JSON.parse(readFileSync(this.options.enrollmentPath, "utf8")) as Partial<EnrollmentState>;
      if (typeof value.requestId !== "string" || typeof value.challenge !== "string" || typeof value.expiresAt !== "number") return undefined;
      return { requestId: value.requestId, challenge: value.challenge, expiresAt: value.expiresAt };
    } catch { return undefined; }
  }

  clearEnrollment(): void {
    try { writeFileSync(this.options.enrollmentPath, "", { mode: 0o600 }); chmodSync(this.options.enrollmentPath, 0o600); } catch { /* best-effort cleanup */ }
  }

  private async rotate(current: CredentialStoreFile): Promise<CredentialStoreFile | undefined> {
    const response = await this.request(`${this.baseUrl()}/api/v1/worker/credentials/rotate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workerId: current.workerId, credential: current.credential }) });
    const body = safeJson(await response.json());
    if (response.status === 401) return undefined;
    if (!response.ok) throw this.responseError("credential rotation", response.status, body);
    if (typeof body.credentialId !== "string" || typeof body.credential !== "string" || typeof body.expiresAt !== "number") throw new Error(`credential rotation failed: ${response.status} invalid response`);
    const next = { ...current, credentialId: body.credentialId, credential: body.credential, expiresAt: body.expiresAt };
    this.options.credentialStore.write(next);
    return next;
  }

  private async enrollmentStatus(requestId: string): Promise<EnrollmentStatus> {
    const response = await this.request(`${this.baseUrl()}/api/v1/worker/enrollment-requests/${encodeURIComponent(requestId)}/status`, { headers: { accept: "application/json" } });
    const body = safeJson(await response.json());
    if (!response.ok) {
      if (response.status === 404) { this.clearEnrollment(); return { status: "EXPIRED" }; }
      throw this.responseError("enrollment status", response.status, body);
    }
    return { status: typeof body.status === "string" ? body.status : undefined, serverNonce: typeof body.serverNonce === "string" ? body.serverNonce : null, expiresAt: typeof body.expiresAt === "number" ? body.expiresAt : undefined, finalized: body.finalized === true };
  }

  private writeEnrollment(state: EnrollmentState): void {
    mkdirSync(dirname(this.options.enrollmentPath), { recursive: true });
    writeFileSync(this.options.enrollmentPath, JSON.stringify(state), { mode: 0o600 });
    chmodSync(this.options.enrollmentPath, 0o600);
  }

  private baseUrl(): string { return this.options.origin.replace(/\/$/, ""); }

  private responseError(operation: string, status: number, body: Record<string, unknown>): WorkerTransportError {
    const candidate = body.error && typeof body.error === "object" && !Array.isArray(body.error) ? (body.error as Record<string, unknown>).code : body.code;
    const code = typeof candidate === "string" ? candidate : status === 410 ? "WORKER_REMOVED" : "WORKER_BOOTSTRAP_ERROR";
    const error = new WorkerTransportError(operation, status, code);
    if (status === 410 || code === "WORKER_ENROLLMENT_BLOCKED" || code === "WORKER_REMOVED") this.markRemoved(code);
    else if (["ENROLLMENT_EXPIRED", "ENROLLMENT_NOT_APPROVED", "ENROLLMENT_ALREADY_FINALIZED"].includes(code)) this.clearEnrollment();
    return error;
  }

  private removedPath(): string { return this.options.removedPath ?? `${this.options.enrollmentPath}.removed`; }
}
