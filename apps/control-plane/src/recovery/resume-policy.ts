export type EffectiveAutoResumePolicy = {
  override: boolean | null;
  globalDefault: boolean;
  emergencyStop: boolean;
  effective: boolean;
  source: "GLOBAL_DEFAULT" | "WORKER_OVERRIDE" | "EMERGENCY_STOP";
};

export function resolveEffectiveAutoResumePolicy(input: {
  globalDefaultEnabled: boolean;
  emergencyStop: boolean;
  workerOverride: boolean | null;
}): EffectiveAutoResumePolicy {
  const source = input.emergencyStop ? "EMERGENCY_STOP" : input.workerOverride === null ? "GLOBAL_DEFAULT" : "WORKER_OVERRIDE";
  const configured = input.workerOverride ?? input.globalDefaultEnabled;
  return {
    override: input.workerOverride,
    globalDefault: input.globalDefaultEnabled,
    emergencyStop: input.emergencyStop,
    effective: !input.emergencyStop && configured,
    source,
  };
}

export type ResumeEligibilityReason =
  | "ELIGIBLE" | "GLOBAL_STOP" | "WORKER_POLICY_OFF" | "GLOBAL_POLICY_OFF"
  | "WORKER_UNAVAILABLE" | "TASK_MANUAL_ONLY" | "QUOTA_NOT_READY"
  | "AUTH_UNAVAILABLE" | "HOST_UNAVAILABLE" | "SESSION_UNSUPPORTED"
  | "OWNERSHIP_CONFLICT" | "WORKSPACE_FENCED" | "EFFECT_UNKNOWN"
  | "RETRY_LIMIT" | "REVIEW_GATE" | "TASK_NOT_RESUMABLE" | "OWNER_ACTION_REQUIRED";

export type ResumeEligibility = {
  eligible: boolean;
  reason: ResumeEligibilityReason;
  policyVersion: number;
  nextCheckAt?: number;
};

export type ResumeEligibilitySnapshot = {
  global: { defaultEnabled: boolean; emergencyStop: boolean; version: number };
  worker: { autoResumeOverride: boolean | null; enabled: boolean; drain: boolean; paused: boolean; preferencesVersion: number };
  task: { resumePolicy: "INHERIT_WORKER" | "MANUAL_ONLY"; condition: string };
  quota: { fiveHourReady: boolean; weeklyReady: boolean; freshnessOk: boolean; nextCheckAt?: number };
  runtime: {
    authReady: boolean;
    hostOnline: boolean;
    sessionSupported: boolean;
    ownershipExclusive: boolean;
    fenceValid: boolean;
    sideEffectsReconciled: boolean;
    attemptsAvailable: boolean;
  };
};

/**
 * A configured ON is only permission to consider a resume. Every runtime,
 * quota, ownership, workspace, and side-effect gate must also be affirmative.
 */
export function evaluateResumeEligibility(snapshot: ResumeEligibilitySnapshot): ResumeEligibility {
  const policyVersion = snapshot.global.version + snapshot.worker.preferencesVersion;
  const deny = (reason: ResumeEligibilityReason, nextCheckAt?: number): ResumeEligibility => ({
    eligible: false,
    reason,
    policyVersion,
    ...(nextCheckAt === undefined ? {} : { nextCheckAt }),
  });

  if (snapshot.global.emergencyStop) return deny("GLOBAL_STOP");
  if (!snapshot.worker.enabled || snapshot.worker.drain || snapshot.worker.paused) return deny("WORKER_UNAVAILABLE");
  if (snapshot.task.resumePolicy === "MANUAL_ONLY") return deny("TASK_MANUAL_ONLY");
  if (snapshot.worker.autoResumeOverride === false) return deny("WORKER_POLICY_OFF");
  if (snapshot.worker.autoResumeOverride !== true && !snapshot.global.defaultEnabled) return deny("GLOBAL_POLICY_OFF");
  if (!snapshot.quota.fiveHourReady || !snapshot.quota.weeklyReady || !snapshot.quota.freshnessOk) return deny("QUOTA_NOT_READY", snapshot.quota.nextCheckAt);
  if (!snapshot.runtime.authReady) return deny("AUTH_UNAVAILABLE");
  if (!snapshot.runtime.hostOnline) return deny("HOST_UNAVAILABLE");
  if (!snapshot.runtime.sessionSupported) return deny("SESSION_UNSUPPORTED");
  if (!snapshot.runtime.ownershipExclusive) return deny("OWNERSHIP_CONFLICT");
  if (!snapshot.runtime.fenceValid) return deny("WORKSPACE_FENCED");
  if (!snapshot.runtime.sideEffectsReconciled) return deny("EFFECT_UNKNOWN");
  if (!snapshot.runtime.attemptsAvailable) return deny("RETRY_LIMIT");
  if (snapshot.task.condition === "NEEDS_OWNER_ACTION") return deny("OWNER_ACTION_REQUIRED");
  if (["WAITING_OWNER_REVIEW", "ACCEPTED", "CANCELLED", "SUCCEEDED"].includes(snapshot.task.condition)) return deny("REVIEW_GATE");
  if (!["BLOCKED_QUOTA", "WAITING_RESET", "DISABLED_BY_POLICY", "RESUME_ELIGIBLE", "BLOCKED_AUTH", "RECONCILIATION_REQUIRED"].includes(snapshot.task.condition)) return deny("TASK_NOT_RESUMABLE");
  return { eligible: true, reason: "ELIGIBLE", policyVersion };
}
