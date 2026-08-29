import { randomBytes } from "node:crypto";
import { canonicalJson, type JsonValue } from "../../../packages/crypto/src/index.ts";
import { workloadRequestSigningPayload, type ActionGrantIssueInput } from "../../identity-gateway/src/grants.ts";
import type { WorkerJobOffer } from "../../worker/src/runtime.ts";
import type { ExecutionPort, ExecutionRequest, ExecutionResult, RuntimeTask } from "./runtime.ts";

export type WorkerRoute = {
  workerId: string;
  capabilityId: string;
  capabilityDescriptorHash: string;
  action: string;
  resources: string[];
};

export type WorkerRouteResolver = { resolve(task: RuntimeTask): WorkerRoute | undefined };

export type ActionGrantPort = {
  issue(input: ActionGrantIssueInput, idempotencyKey: string): Promise<string>;
};

export type WorkerOfferPort = {
  offer(job: WorkerJobOffer): Promise<
    | { status: "COMPLETED"; result: Record<string, JsonValue>; evidence: Record<string, JsonValue> }
    | { status: "FAILED"; evidence: Record<string, JsonValue> }
    | { status: "UNKNOWN"; externalOperationId?: string | null; evidence: Record<string, JsonValue> }
  >;
};

export class WorkerExecutionPort implements ExecutionPort {
  private readonly routes: WorkerRouteResolver;
  private readonly grants: ActionGrantPort;
  private readonly workers: WorkerOfferPort;
  private readonly clock: () => number;
  constructor(routes: WorkerRouteResolver, grants: ActionGrantPort, workers: WorkerOfferPort, clock: () => number = Date.now) { this.routes = routes; this.grants = grants; this.workers = workers; this.clock = clock; }
  supports(task: RuntimeTask): boolean { return this.routes.resolve(task) !== undefined; }
  approvalRequest(task: RuntimeTask) {
    const route = this.routes.resolve(task);
    if (!route) return undefined;
    const numericBudget = Object.fromEntries(Object.entries(task.budget).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] >= 0));
    const strings = (value: unknown): string[] => Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
    return {
      requiredScope: {
        actions: [route.action], resources: route.resources, capabilityIds: [route.capabilityId], workers: [route.workerId],
        filesystemRoots: strings(task.sandbox.filesystemRoots), networkDestinations: strings(task.sandbox.networkDestinations), recipients: strings(task.definition.recipients),
        mergeMode: typeof task.definition.mergeMode === "string" ? task.definition.mergeMode : "none",
        deploymentMode: typeof task.definition.deploymentMode === "string" ? task.definition.deploymentMode : "none",
        budget: numericBudget,
      },
      risk: { sideEffectClass: task.sideEffectClass, requiresStepUp: task.sideEffectClass === "NON_IDEMPOTENT_MUTATION" },
    };
  }
  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const route = this.routes.resolve(request.task);
    if (!route) throw new Error("WORKER_ROUTE_UNAVAILABLE");
    const grantInput: ActionGrantIssueInput = {
      audience: `pai-worker:${route.workerId}`,
      taskId: request.task.id,
      attemptId: request.attemptId,
      planDigest: request.planDigest,
      policyVersion: request.policyVersion,
      fencingToken: request.fencingToken,
      actions: [route.action],
      resources: route.resources,
      capabilityIds: [route.capabilityId],
      budget: request.task.budget as Record<string, JsonValue>,
      sandbox: request.task.sandbox as Record<string, JsonValue>,
      hardStopApprovalId: request.approval?.requestId ?? null,
      expiresInSeconds: request.approval ? Math.max(1, Math.min(300, Math.floor((request.approval.expiresAt - this.clock()) / 1000))) : 300,
    };
    if (!["NONE", "READ_ONLY"].includes(request.task.sideEffectClass)) {
      const approved = request.approval?.boundedScope;
      if (!approved || !approved.actions.includes(route.action) || !route.resources.every((resource) => approved.resources.includes(resource)) || !approved.capabilityIds.includes(route.capabilityId) || !approved.workers.includes(route.workerId)) throw new Error("APPROVAL_SCOPE_MISMATCH");
    }
    const actionGrant = await this.grants.issue(grantInput, `grant:${request.attemptId}:${request.fencingToken}`);
    const outcome = await this.workers.offer({
      workerId: route.workerId,
      capabilityId: route.capabilityId,
      capabilityDescriptorHash: route.capabilityDescriptorHash,
      attemptId: request.attemptId,
      taskId: request.task.id,
      planDigest: request.planDigest,
      policyVersion: request.policyVersion,
      fencingToken: request.fencingToken,
      leaseId: request.leaseId,
      requiredAction: route.action,
      resources: route.resources,
      budget: grantInput.budget,
      sandbox: grantInput.sandbox,
      hardStopApprovalId: grantInput.hardStopApprovalId,
      actionGrant,
      input: request.task.definition as Record<string, JsonValue>,
    });
    if (outcome.status === "COMPLETED") return { status: "SUCCEEDED", result: outcome.result, evidence: outcome.evidence };
    if (outcome.status === "FAILED") throw new Error("WORKER_JOB_FAILED");
    return { status: "UNCERTAIN", provider: `worker:${route.workerId}`, operationKind: route.action, externalOperationId: outcome.externalOperationId ?? null, expectedResource: { taskId: request.task.id, attemptId: request.attemptId }, lastObservedState: "UNKNOWN", reconciliationStrategy: "worker-result-query" };
  }
  async verify(request: ExecutionRequest & { result: Record<string, unknown> }): Promise<{ ok: boolean; evidence: Record<string, unknown> }> {
    const result = request.result.result as { attemptId?: unknown; fencingToken?: unknown } | undefined;
    return { ok: result?.attemptId === request.attemptId && result.fencingToken === request.fencingToken, evidence: { attemptBound: result?.attemptId === request.attemptId, fenceBound: result?.fencingToken === request.fencingToken } };
  }
}

export class WorkloadActionGrantHttpClient implements ActionGrantPort {
  private readonly baseUrl: string;
  private readonly workloadId: string;
  private readonly signProof: (payload: Buffer) => Buffer | Promise<Buffer>;
  private readonly clock: () => number;
  private readonly fetcher: typeof fetch;
  constructor(options: { baseUrl: string; workloadId: string; signProof(payload: Buffer): Buffer | Promise<Buffer>; clock?: () => number; fetcher?: typeof fetch }) {
    this.baseUrl = options.baseUrl.replace(/\/$/, ""); this.workloadId = options.workloadId; this.signProof = options.signProof; this.clock = options.clock ?? Date.now; this.fetcher = options.fetcher ?? fetch;
  }
  async issue(input: ActionGrantIssueInput, idempotencyKey: string): Promise<string> {
    const timestamp = this.clock();
    const nonce = randomBytes(24).toString("base64url");
    const proof = { timestamp, nonce, idempotencyKey, method: "POST" as const, path: "/api/v1/workloads/action-grants" as const };
    const signature = (await this.signProof(Buffer.from(workloadRequestSigningPayload(proof, input), "utf8"))).toString("base64url");
    const response = await this.fetcher(`${this.baseUrl}${proof.path}`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": idempotencyKey, "x-pai-workload-id": this.workloadId, "x-pai-workload-timestamp": String(timestamp), "x-pai-workload-nonce": nonce, "x-pai-workload-signature": signature }, body: canonicalJson(input as unknown as JsonValue) });
    if (!response.ok) throw new Error(response.status >= 500 ? "ACTION_GRANT_AUTHORITY_UNAVAILABLE" : "ACTION_GRANT_REJECTED");
    const body = await response.json() as { token?: unknown };
    if (typeof body.token !== "string" || body.token.length === 0) throw new Error("ACTION_GRANT_RESPONSE_INVALID");
    return body.token;
  }
}
