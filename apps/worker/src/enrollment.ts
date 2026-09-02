import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { newRegistrationSecret, FileWorkerTokenStore, type WorkerCredentialStore } from "./transport.ts";

export type Pending = { registrationId: string; secret: string; origin: string };
type Token = { workerId: string; token: string; origin: string };

export class WorkerEnrollment {
  readonly tokenStore: WorkerCredentialStore<Token>;
  private readonly path: string;
  private readonly removedPath: string;
  private readonly pendingStore: WorkerCredentialStore<Pending>;
  private readonly origin: string;
  private readonly details: Record<string, unknown>;
  constructor(options: { dataDir: string; origin: string; name: string; platform: string; hostname: string; agentVersion: string; hardware: Record<string, unknown>; tokenStore?: WorkerCredentialStore<Token>; pendingStore?: WorkerCredentialStore<Pending> }) { this.path = join(options.dataDir, "registration.json"); this.removedPath = join(options.dataDir, "removed.json"); this.tokenStore = options.tokenStore ?? new FileWorkerTokenStore<Token>(join(options.dataDir, "worker-token.json")); this.pendingStore = options.pendingStore ?? new FileWorkerTokenStore<Pending>(this.path); this.origin = options.origin.replace(/\/$/, ""); this.details = options; }
  readToken(): Token | undefined { return this.tokenStore.read() as Token | undefined; }
  isRemoved(): boolean { return existsSync(this.removedPath); }
  markRemoved(workerId?: string): void { this.tokenStore.clear(); this.pendingStore.clear(); try { mkdirSync(dirname(this.removedPath), { recursive: true }); writeFileSync(this.removedPath, `${JSON.stringify({ workerId: workerId ?? null, removedAt: Date.now() })}\n`, { mode: 0o600 }); } catch { /* best effort cleanup */ } }
  reset(): void { this.tokenStore.clear(); this.pendingStore.clear(); try { unlinkSync(this.removedPath); } catch { /* no removal marker is also a valid reset state */ } }
  async ensure(): Promise<Token | undefined> {
    if (this.isRemoved()) return undefined;
    const token = this.readToken(); if (token?.workerId && token.token) return token;
    let pending = this.pendingStore.read();
    if (!pending?.registrationId || !pending.secret) return this.createRegistration();
    const response = await fetch(`${this.origin}/api/v2/worker/registration/${encodeURIComponent(pending.registrationId)}`, { headers: { "x-registration-secret": pending.secret, accept: "application/json" } });
    if (response.status === 404) { this.clearPending(); return this.createRegistration(); }
    if (!response.ok) throw new Error("WORKER_REGISTRATION_POLL_FAILED");
    const state = await response.json() as { status?: string; workerId?: string; token?: string };
    const status = String(state.status ?? "").toLowerCase();
    if (status === "expired" || status === "rejected") { this.clearPending(); return this.createRegistration(); }
    if (status !== "approved" || !state.workerId || !state.token) return undefined;
    const enrolled = { workerId: state.workerId, token: state.token, origin: this.origin };
    this.tokenStore.write(enrolled);
    this.clearPending();
    console.log(JSON.stringify({ event: "worker.enrollment.approved", workerId: state.workerId }));
    return enrolled;
  }

  private async createRegistration(): Promise<undefined> {
    const pending: Pending = { registrationId: "", secret: newRegistrationSecret(), origin: this.origin };
    const response = await fetch(`${this.origin}/api/v2/worker/registration`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: this.details.name, registration_secret: pending.secret, platform: this.details.platform, hostname: this.details.hostname, agent_version: this.details.agentVersion, hardware: this.details.hardware }) });
    if (!response.ok) throw new Error("WORKER_REGISTRATION_FAILED");
    const created = await response.json() as { registration_id?: string; registrationId?: string };
    pending.registrationId = created.registration_id ?? created.registrationId ?? "";
    if (!pending.registrationId) throw new Error("WORKER_REGISTRATION_ID_MISSING");
    this.pendingStore.write(pending);
    console.log(JSON.stringify({ event: "worker.registration.created", registrationId: pending.registrationId, name: this.details.name }));
    return undefined;
  }

  private clearPending(): void { this.pendingStore.clear(); }
}
