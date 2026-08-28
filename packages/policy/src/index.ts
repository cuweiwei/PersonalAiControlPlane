export type AutonomyLevel = "NOTIFY" | "INVESTIGATE" | "REPAIR_WITH_APPROVAL" | "AUTONOMOUS_WITHIN_GRANT";

export type PolicyInput = {
  policyVersion: number;
  evidenceValid: boolean;
  action: string;
  capabilityGranted: boolean;
  autonomy: AutonomyLevel;
  budgetWithinGrant: boolean;
  hardStopApprovalPresent: boolean;
};

export type PolicyDecision = {
  outcome: "ALLOW" | "REQUIRE_APPROVAL" | "CHECKPOINT" | "DENY";
  policyVersion: number;
  matchedRuleIds: string[];
  safeReasons: string[];
  requiresStepUp: boolean;
};

const hardStopActions = new Set([
  "money.move",
  "purchase",
  "credential.modify",
  "security.modify",
  "privilege.escalate",
  "destructive.delete",
  "security-boundary.expand",
  "external.communication.high-risk",
]);

/** Pure fail-closed v1 policy evaluator. It receives no secret values and performs no I/O. */
export function evaluatePolicy(input: PolicyInput): PolicyDecision {
  if (!Number.isInteger(input.policyVersion) || input.policyVersion < 1) {
    return { outcome: "DENY", policyVersion: input.policyVersion, matchedRuleIds: ["policy.version.invalid"], safeReasons: ["policy version is invalid"], requiresStepUp: false };
  }
  if (!input.evidenceValid) {
    return { outcome: "CHECKPOINT", policyVersion: input.policyVersion, matchedRuleIds: ["evidence.stale"], safeReasons: ["required evidence is missing or stale"], requiresStepUp: false };
  }
  if (input.action === "privilege.escalate") {
    return { outcome: "DENY", policyVersion: input.policyVersion, matchedRuleIds: ["hard-stop.privilege-escalation"], safeReasons: ["privilege escalation is never autonomous"], requiresStepUp: true };
  }
  if (hardStopActions.has(input.action) && !input.hardStopApprovalPresent) {
    return { outcome: "REQUIRE_APPROVAL", policyVersion: input.policyVersion, matchedRuleIds: [`hard-stop.${input.action}`], safeReasons: ["explicit approval is required for this action"], requiresStepUp: true };
  }
  if (!input.capabilityGranted) {
    return { outcome: "DENY", policyVersion: input.policyVersion, matchedRuleIds: ["capability.not-granted"], safeReasons: ["discovery does not imply authorization"], requiresStepUp: false };
  }
  if (!input.budgetWithinGrant) {
    return { outcome: "CHECKPOINT", policyVersion: input.policyVersion, matchedRuleIds: ["grant.budget-exceeded"], safeReasons: ["execution exceeds the bounded grant"], requiresStepUp: false };
  }
  if (input.autonomy === "NOTIFY") {
    return { outcome: "DENY", policyVersion: input.policyVersion, matchedRuleIds: ["autonomy.notify-only"], safeReasons: ["notify-only policy does not permit execution"], requiresStepUp: false };
  }
  if (input.autonomy === "REPAIR_WITH_APPROVAL" && input.action !== "read.only" && !input.hardStopApprovalPresent) {
    return { outcome: "REQUIRE_APPROVAL", policyVersion: input.policyVersion, matchedRuleIds: ["autonomy.repair-approval"], safeReasons: ["repair requires approval at this autonomy level"], requiresStepUp: false };
  }
  return { outcome: "ALLOW", policyVersion: input.policyVersion, matchedRuleIds: ["policy.allow"], safeReasons: [], requiresStepUp: false };
}
