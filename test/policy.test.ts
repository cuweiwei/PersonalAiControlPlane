import assert from "node:assert/strict";
import test from "node:test";
import { evaluatePolicy } from "../packages/policy/src/index.ts";

const base = {
  policyVersion: 1,
  evidenceValid: true,
  action: "read.only",
  capabilityGranted: true,
  autonomy: "AUTONOMOUS_WITHIN_GRANT" as const,
  budgetWithinGrant: true,
  hardStopApprovalPresent: false,
};

test("policy allows only an eligible bounded action", () => {
  assert.equal(evaluatePolicy(base).outcome, "ALLOW");
  assert.equal(evaluatePolicy({ ...base, capabilityGranted: false }).outcome, "DENY");
  assert.equal(evaluatePolicy({ ...base, budgetWithinGrant: false }).outcome, "CHECKPOINT");
});

test("hard stops fail closed and require step-up", () => {
  const purchase = evaluatePolicy({ ...base, action: "purchase" });
  assert.equal(purchase.outcome, "REQUIRE_APPROVAL");
  assert.equal(purchase.requiresStepUp, true);
  const privilege = evaluatePolicy({ ...base, action: "privilege.escalate", hardStopApprovalPresent: true });
  assert.equal(privilege.outcome, "DENY");
});

test("stale evidence checkpoints before capability evaluation", () => {
  const decision = evaluatePolicy({ ...base, evidenceValid: false, capabilityGranted: false });
  assert.equal(decision.outcome, "CHECKPOINT");
  assert.deepEqual(decision.matchedRuleIds, ["evidence.stale"]);
});
