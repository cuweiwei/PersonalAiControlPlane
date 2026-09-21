import type { DispatchRequestEnvelope } from "../../../../packages/contracts/src/dispatch.ts";
import { ControlPlaneDatabase } from "../db/database.ts";
import type { DispatchAction, DispatchExecutionAdapter, DispatchRule } from "./dispatch-types.ts";

type Row = Record<string, any>;

export type DispatchPolicyResult = { allowed: true; adapter: DispatchExecutionAdapter } | { allowed: false; reason: string };

export class DispatchPolicy {
  private readonly db: ControlPlaneDatabase;
  private readonly adapters: Map<string, DispatchExecutionAdapter>;
  constructor(db: ControlPlaneDatabase, adapters: readonly DispatchExecutionAdapter[]) {
    this.db = db;
    this.adapters = new Map(adapters.map((adapter) => [adapter.operationId, adapter]));
  }

  evaluate(request: DispatchRequestEnvelope, rule: DispatchRule, action: DispatchAction, assurance: "UNASSESSED" | "HIGH"): DispatchPolicyResult {
    if (request.privacyClass !== "LOCAL_ONLY") return { allowed: false, reason: "PRIVACY_POLICY" };
    if (rule.risk.declaredEffect !== "READ_ONLY" || rule.risk.requiredAssurance !== "HIGH" || assurance !== "HIGH") return { allowed: false, reason: "LOW_CONFIDENCE" };
    if (action.operation !== "service.health_check" || action.operationSchemaVersion !== 1 || action.logicalWorker !== "control-plane-health") return { allowed: false, reason: "CAPABILITY_UNAVAILABLE" };
    if (Object.keys(action.parameters).some((key) => key !== "service_ref")) return { allowed: false, reason: "INVALID_SLOTS" };
    const serviceRef = action.parameters.service_ref;
    if (typeof serviceRef !== "string" || !/^[a-z0-9][a-z0-9-]{1,80}$/.test(serviceRef)) return { allowed: false, reason: "INVALID_SLOTS" };
    const system = this.db.one<Row>("SELECT id, enabled FROM systems WHERE id = ?", serviceRef);
    if (!system || Number(system.enabled) !== 1) return { allowed: false, reason: "CAPABILITY_UNAVAILABLE" };
    const adapter = this.adapters.get(action.operation);
    if (!adapter) return { allowed: false, reason: "CAPABILITY_UNAVAILABLE" };
    if (!adapter.supportsOperationDedup) return { allowed: false, reason: "CAPABILITY_UNAVAILABLE" };
    return { allowed: true, adapter };
  }

  adapter(operation: string): DispatchExecutionAdapter | undefined { return this.adapters.get(operation); }
}

export class SystemHealthCheckAdapter implements DispatchExecutionAdapter {
  readonly operationId = "service.health_check";
  readonly descriptorHash = "sha256:service-health-v1";
  readonly supportsOperationDedup = true;
  private readonly db: ControlPlaneDatabase;
  constructor(db: ControlPlaneDatabase) { this.db = db; }

  async execute(action: DispatchAction, _operationKey: string, signal: AbortSignal): Promise<import("./dispatch-types.ts").ExecutionResult> {
    const serviceRef = action.parameters.service_ref;
    if (typeof serviceRef !== "string") throw new Error("INVALID_SLOTS");
    const system = this.db.one<Row>("SELECT id, base_url, health_path FROM systems WHERE id = ? AND enabled = 1", serviceRef);
    if (!system) throw new Error("CAPABILITY_UNAVAILABLE");
    const observedAt = new Date().toISOString();
    const url = `${String(system.base_url).replace(/\/$/, "")}${String(system.health_path)}`;
    try {
      const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]) });
      return { schemaVersion: 1, status: response.ok ? "HEALTHY" : "DEGRADED", observedAt, sourceRef: `system-health:${serviceRef}`, serviceRef, message: response.ok ? null : `HTTP_${response.status}` };
    } catch (error) {
      if (signal.aborted) throw error;
      return { schemaVersion: 1, status: "OFFLINE", observedAt, sourceRef: `system-health:${serviceRef}`, serviceRef, message: error instanceof Error ? error.message.slice(0, 160) : "HEALTH_CHECK_FAILED" };
    }
  }
}
