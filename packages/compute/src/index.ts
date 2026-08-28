import { selectRoute, type RouteCandidate } from "../../scheduler/src/index.ts";
import type { ComputeProvider, ProviderDescriptor, ProviderHealth, ComputeRequest, ProviderReservation, ComputeEvent } from "../../adapters/src/index.ts";

export type QuotaState = "UNKNOWN" | "AVAILABLE_ESTIMATE" | "NEAR_LIMIT" | "EXHAUSTED" | "RECOVERY_EXPECTED";
export class QuotaTracker {
  private state: QuotaState = "UNKNOWN";
  private recoveryAt: number | null = null;
  observe(state: QuotaState, source: "telemetry" | "usage-event" | "limit-error" | "historical", recoveryAt: number | null = null): QuotaState { if (source === "limit-error") this.state = "EXHAUSTED"; else this.state = state; this.recoveryAt = recoveryAt; return this.state; }
  probeEligible(now = Date.now()): boolean { return this.state === "EXHAUSTED" && this.recoveryAt !== null && now >= this.recoveryAt; }
  get(): { state: QuotaState; recoveryAt: number | null } { return { state: this.state, recoveryAt: this.recoveryAt }; }
}

export type RegisteredProvider = { provider: ComputeProvider; descriptor: ProviderDescriptor; health: ProviderHealth; quota: QuotaTracker };
export class ComputeBroker {
  private readonly providers = new Map<string, RegisteredProvider>();
  register(provider: ComputeProvider, descriptor: ProviderDescriptor, health: ProviderHealth): void { if (this.providers.has(descriptor.providerId)) throw new Error("provider already registered"); this.providers.set(descriptor.providerId, { provider, descriptor, health, quota: new QuotaTracker() }); }
  list(): ProviderDescriptor[] { return [...this.providers.values()].map((entry) => ({ ...entry.descriptor })); }
  route(candidates: readonly RouteCandidate[]): { selected?: string; rejected: Array<{ id: string; reasons: string[] }> } { const selection = selectRoute(candidates); return { selected: selection.selected ? selection.selected.providerId : undefined, rejected: selection.rejected }; }
  async reserve(providerId: string, request: ComputeRequest): Promise<ProviderReservation> { const entry = this.providers.get(providerId); if (!entry || entry.health.status === "DISABLED" || entry.health.status === "EXHAUSTED" || entry.quota.get().state === "EXHAUSTED") throw new Error("provider is unavailable"); return entry.provider.reserve(request); }
  async *execute(providerId: string, reservation: ProviderReservation, inputDigest: string): AsyncIterable<ComputeEvent> { const entry = this.providers.get(providerId); if (!entry || entry.health.status === "DISABLED") throw new Error("provider is unavailable"); for await (const event of entry.provider.execute(reservation, inputDigest)) yield event; }
  observeQuota(providerId: string, state: QuotaState, source: "telemetry" | "usage-event" | "limit-error" | "historical", recoveryAt: number | null = null): QuotaState { const entry = this.providers.get(providerId); if (!entry) throw new Error("provider is unknown"); return entry.quota.observe(state, source, recoveryAt); }
}
