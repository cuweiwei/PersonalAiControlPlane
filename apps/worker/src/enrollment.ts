import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { newRegistrationSecret, FileWorkerTokenStore } from "./transport.ts";

type Pending = { registrationId: string; secret: string; origin: string };
type Token = { workerId: string; token: string; origin: string };
function json(path: string): any { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; } }

export class WorkerEnrollment {
  readonly tokenStore: FileWorkerTokenStore;
  private readonly path: string;
  private readonly origin: string;
  private readonly details: Record<string, unknown>;
  constructor(options: { dataDir: string; origin: string; name: string; platform: string; hostname: string; agentVersion: string; hardware: Record<string, unknown> }) { this.path = join(options.dataDir, "registration.json"); this.tokenStore = new FileWorkerTokenStore(join(options.dataDir, "worker-token.json")); this.origin = options.origin.replace(/\/$/, ""); this.details = options; }
  readToken(): Token | undefined { return this.tokenStore.read() as Token | undefined; }
  reset(): void { this.tokenStore.clear(); try { writeFileSync(this.path, "", { mode: 0o600 }); } catch { /* no registration is also a valid reset state */ } }
  async ensure(): Promise<Token | undefined> {
    const token = this.readToken(); if (token?.workerId && token.token) return token;
    let pending = json(this.path) as Pending | undefined;
    if (!pending?.registrationId || !pending.secret) { pending = { registrationId: "", secret: newRegistrationSecret(), origin: this.origin }; const response = await fetch(`${this.origin}/api/v2/worker/registration`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: this.details.name, registration_secret: pending.secret, platform: this.details.platform, hostname: this.details.hostname, agent_version: this.details.agentVersion, hardware: this.details.hardware }) }); if (!response.ok) throw new Error("WORKER_REGISTRATION_FAILED"); const created = await response.json() as { registration_id?: string; registrationId?: string }; pending.registrationId = created.registration_id ?? created.registrationId ?? ""; if (!pending.registrationId) throw new Error("WORKER_REGISTRATION_ID_MISSING"); mkdirSync(dirname(this.path), { recursive: true }); writeFileSync(this.path, `${JSON.stringify(pending)}\n`, { mode: 0o600 }); console.log(JSON.stringify({ event: "worker.registration.created", registrationId: pending.registrationId, name: this.details.name })); return undefined; }
    const response = await fetch(`${this.origin}/api/v2/worker/registration/${encodeURIComponent(pending.registrationId)}`, { headers: { "x-registration-secret": pending.secret, accept: "application/json" } }); if (!response.ok) throw new Error("WORKER_REGISTRATION_POLL_FAILED"); const state = await response.json() as { status?: string; workerId?: string; token?: string }; if (state.status !== "approved" || !state.workerId || !state.token) return undefined; const enrolled = { workerId: state.workerId, token: state.token, origin: this.origin }; this.tokenStore.write(enrolled); try { writeFileSync(this.path, "", { mode: 0o600 }); } catch { /* token is authoritative */ } console.log(JSON.stringify({ event: "worker.enrollment.approved", workerId: state.workerId })); return enrolled;
  }
}
