export type OwnerPriority = "URGENT" | "HIGH" | "NORMAL" | "LOW";

export type TaskEligibilityInput = {
  id: string;
  state: "READY" | string;
  activePlan: boolean;
  dependenciesComplete: boolean;
  cancellationRequested: boolean;
  policyAllowed: boolean;
  credentialsHealthy: boolean;
  quotaReservable: boolean;
  workerAvailable: boolean;
  readyAt: number;
};

export type EligibilityResult = { eligible: true } | { eligible: false; reasons: string[] };

export function evaluateTaskEligibility(input: TaskEligibilityInput): EligibilityResult {
  const reasons: string[] = [];
  if (input.state !== "READY") reasons.push("state-not-ready");
  if (!input.activePlan) reasons.push("stale-plan");
  if (!input.dependenciesComplete) reasons.push("dependencies-incomplete");
  if (input.cancellationRequested) reasons.push("cancellation-requested");
  if (!input.policyAllowed) reasons.push("policy-denied");
  if (!input.credentialsHealthy) reasons.push("credential-unhealthy");
  if (!input.quotaReservable) reasons.push("quota-unavailable");
  if (!input.workerAvailable) reasons.push("worker-unavailable");
  return reasons.length === 0 ? { eligible: true } : { eligible: false, reasons };
}

export type TaskSelectionCandidate = TaskEligibilityInput & {
  deadlineAt: number | null;
  ownerPriority: OwnerPriority;
  resumeAffinity: boolean;
};

const priorityRank: Record<OwnerPriority, number> = { URGENT: 0, HIGH: 1, NORMAL: 2, LOW: 3 };

export function selectTask(candidates: readonly TaskSelectionCandidate[]): TaskSelectionCandidate | undefined {
  return candidates
    .filter((candidate) => evaluateTaskEligibility(candidate).eligible)
    .sort((left, right) => {
      if (left.deadlineAt === null && right.deadlineAt !== null) return 1;
      if (left.deadlineAt !== null && right.deadlineAt === null) return -1;
      if (left.deadlineAt !== null && right.deadlineAt !== null && left.deadlineAt !== right.deadlineAt) return left.deadlineAt - right.deadlineAt;
      if (priorityRank[left.ownerPriority] !== priorityRank[right.ownerPriority]) return priorityRank[left.ownerPriority] - priorityRank[right.ownerPriority];
      if (left.resumeAffinity !== right.resumeAffinity) return left.resumeAffinity ? -1 : 1;
      if (left.readyAt !== right.readyAt) return left.readyAt - right.readyAt;
      return left.id.localeCompare(right.id);
    })[0];
}

export type RouteCandidate = {
  id: string;
  providerId: string;
  qualityEligible: boolean;
  capabilityCompatible: boolean;
  workerHealthy: boolean;
  credentialHealthy: boolean;
  quotaReservable: boolean;
  dataLocalityRank: number;
  costRank: number;
  latencyMs: number;
  energyRank: number;
  workerLoad: number;
};

export type RouteSelection = { selected?: RouteCandidate; rejected: Array<{ id: string; reasons: string[] }> };

export function selectRoute(routes: readonly RouteCandidate[]): RouteSelection {
  const rejected: Array<{ id: string; reasons: string[] }> = [];
  const eligible: RouteCandidate[] = [];
  for (const route of routes) {
    const reasons: string[] = [];
    if (!route.qualityEligible) reasons.push("quality-floor");
    if (!route.capabilityCompatible) reasons.push("capability-mismatch");
    if (!route.workerHealthy) reasons.push("worker-unhealthy");
    if (!route.credentialHealthy) reasons.push("credential-unhealthy");
    if (!route.quotaReservable) reasons.push("quota-unavailable");
    if (reasons.length > 0) rejected.push({ id: route.id, reasons });
    else eligible.push(route);
  }
  eligible.sort((left, right) => left.dataLocalityRank - right.dataLocalityRank || left.costRank - right.costRank || left.latencyMs - right.latencyMs || left.energyRank - right.energyRank || left.workerLoad - right.workerLoad || left.id.localeCompare(right.id));
  return { selected: eligible[0], rejected };
}

export type FailureClass = "TRANSIENT" | "PERMANENT" | "AUTH" | "QUOTA" | "POLICY" | "CONFLICT" | "UNCERTAIN_SIDE_EFFECT";

export type RetryDisposition = "RETRY" | "FAILED" | "WAITING_AUTH" | "WAITING_QUOTA" | "CHECKPOINT_POLICY" | "RECONCILE";

export function dispositionForFailure(errorClass: FailureClass): RetryDisposition {
  return ({
    TRANSIENT: "RETRY",
    PERMANENT: "FAILED",
    AUTH: "WAITING_AUTH",
    QUOTA: "WAITING_QUOTA",
    POLICY: "CHECKPOINT_POLICY",
    CONFLICT: "RECONCILE",
    UNCERTAIN_SIDE_EFFECT: "RECONCILE",
  } as Record<FailureClass, RetryDisposition>)[errorClass];
}

export function boundedExponentialBackoff(attempt: number, baseMs = 1_000, maxMs = 120_000, random = Math.random): number {
  if (!Number.isInteger(attempt) || attempt < 1 || !Number.isFinite(baseMs) || baseMs < 0 || !Number.isFinite(maxMs) || maxMs < baseMs) throw new Error("backoff bounds are invalid");
  const exponential = Math.min(maxMs, baseMs * (2 ** (attempt - 1)));
  const jitter = Math.min(1, Math.max(0, random())) * Math.min(baseMs, exponential * 0.25);
  return Math.min(maxMs, Math.floor(exponential + jitter));
}

export type GrantBounds = {
  goalId: string;
  ownerId: string;
  actions: readonly string[];
  capabilityIds: readonly string[];
  workers: readonly string[];
  filesystemRoots: readonly string[];
  networkDestinations: readonly string[];
  recipients: readonly string[];
  mergeMode: string;
  deploymentMode: string;
  budget: Record<string, number>;
  policyVersion: number;
  expiresAt: number;
};

export type ReplanBounds = Omit<GrantBounds, "expiresAt"> & { expiresAt: number };

function subset(left: readonly string[], right: readonly string[]): boolean {
  const allowed = new Set(right);
  return left.every((item) => allowed.has(item));
}

function numericBudgetWithin(left: Record<string, number>, right: Record<string, number>): boolean {
  return Object.entries(left).every(([key, value]) => Number.isFinite(value) && Number.isFinite(right[key]) && value <= right[key]);
}

/** Unknown or incomparable dimensions are represented as false by the caller; no broadening is inferred. */
export function containsGrant(replan: ReplanBounds, grant: GrantBounds, now = Date.now()): boolean {
  return replan.goalId === grant.goalId && replan.ownerId === grant.ownerId &&
    subset(replan.actions, grant.actions) && subset(replan.capabilityIds, grant.capabilityIds) &&
    subset(replan.workers, grant.workers) && subset(replan.filesystemRoots, grant.filesystemRoots) &&
    subset(replan.networkDestinations, grant.networkDestinations) && subset(replan.recipients, grant.recipients) &&
    replan.mergeMode === grant.mergeMode && replan.deploymentMode === grant.deploymentMode &&
    numericBudgetWithin(replan.budget, grant.budget) && replan.policyVersion === grant.policyVersion && replan.expiresAt <= grant.expiresAt &&
    replan.expiresAt > now;
}
