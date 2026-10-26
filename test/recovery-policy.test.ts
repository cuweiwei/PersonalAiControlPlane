import assert from "node:assert/strict";
import test from "node:test";
import { evaluateResumeEligibility, resolveEffectiveAutoResumePolicy, type ResumeEligibilitySnapshot } from "../apps/control-plane/src/recovery/resume-policy.ts";

const eligibleSnapshot = (): ResumeEligibilitySnapshot => ({
  global: { defaultEnabled: true, emergencyStop: false, version: 4 },
  worker: { autoResumeOverride: null, enabled: true, drain: false, paused: false, preferencesVersion: 2 },
  task: { resumePolicy: "INHERIT_WORKER", condition: "WAITING_RESET" },
  quota: { fiveHourReady: true, weeklyReady: true, freshnessOk: true },
  runtime: { authReady: true, hostOnline: true, sessionSupported: true, ownershipExclusive: true, fenceValid: true, sideEffectsReconciled: true, attemptsAvailable: true },
});

test("effective auto-resume policy applies worker override, global default, then emergency stop", () => {
  assert.deepEqual(resolveEffectiveAutoResumePolicy({ globalDefaultEnabled: true, emergencyStop: false, workerOverride: null }), { override: null, globalDefault: true, emergencyStop: false, effective: true, source: "GLOBAL_DEFAULT" });
  assert.equal(resolveEffectiveAutoResumePolicy({ globalDefaultEnabled: true, emergencyStop: false, workerOverride: false }).effective, false);
  assert.equal(resolveEffectiveAutoResumePolicy({ globalDefaultEnabled: false, emergencyStop: false, workerOverride: true }).effective, true);
  const stopped = resolveEffectiveAutoResumePolicy({ globalDefaultEnabled: true, emergencyStop: true, workerOverride: true });
  assert.equal(stopped.effective, false);
  assert.equal(stopped.source, "EMERGENCY_STOP");
});

test("resume eligibility requires policy, fresh five-hour and weekly quota, runtime, ownership and fencing", () => {
  assert.deepEqual(evaluateResumeEligibility(eligibleSnapshot()), { eligible: true, reason: "ELIGIBLE", policyVersion: 6 });
  const cases: Array<[Partial<ResumeEligibilitySnapshot>, string]> = [
    [{ global: { defaultEnabled: true, emergencyStop: true, version: 4 } }, "GLOBAL_STOP"],
    [{ worker: { ...eligibleSnapshot().worker, enabled: false } }, "WORKER_UNAVAILABLE"],
    [{ worker: { ...eligibleSnapshot().worker, drain: true } }, "WORKER_UNAVAILABLE"],
    [{ worker: { ...eligibleSnapshot().worker, paused: true } }, "WORKER_UNAVAILABLE"],
    [{ task: { resumePolicy: "MANUAL_ONLY", condition: "WAITING_RESET" } }, "TASK_MANUAL_ONLY"],
    [{ worker: { ...eligibleSnapshot().worker, autoResumeOverride: false } }, "WORKER_POLICY_OFF"],
    [{ global: { defaultEnabled: false, emergencyStop: false, version: 4 } }, "GLOBAL_POLICY_OFF"],
    [{ quota: { fiveHourReady: true, weeklyReady: false, freshnessOk: true } }, "QUOTA_NOT_READY"],
    [{ quota: { fiveHourReady: true, weeklyReady: true, freshnessOk: false, nextCheckAt: 123 } }, "QUOTA_NOT_READY"],
    [{ runtime: { ...eligibleSnapshot().runtime, authReady: false } }, "AUTH_UNAVAILABLE"],
    [{ runtime: { ...eligibleSnapshot().runtime, hostOnline: false } }, "HOST_UNAVAILABLE"],
    [{ runtime: { ...eligibleSnapshot().runtime, sessionSupported: false } }, "SESSION_UNSUPPORTED"],
    [{ runtime: { ...eligibleSnapshot().runtime, ownershipExclusive: false } }, "OWNERSHIP_CONFLICT"],
    [{ runtime: { ...eligibleSnapshot().runtime, fenceValid: false } }, "WORKSPACE_FENCED"],
    [{ runtime: { ...eligibleSnapshot().runtime, sideEffectsReconciled: false } }, "EFFECT_UNKNOWN"],
    [{ runtime: { ...eligibleSnapshot().runtime, attemptsAvailable: false } }, "RETRY_LIMIT"],
    [{ task: { resumePolicy: "INHERIT_WORKER", condition: "WAITING_OWNER_REVIEW" } }, "REVIEW_GATE"],
    [{ task: { resumePolicy: "INHERIT_WORKER", condition: "NEEDS_OWNER_ACTION" } }, "OWNER_ACTION_REQUIRED"],
    [{ task: { resumePolicy: "INHERIT_WORKER", condition: "ACTIVE" } }, "TASK_NOT_RESUMABLE"],
  ];
  for (const [change, reason] of cases) {
    const result = evaluateResumeEligibility({ ...eligibleSnapshot(), ...change } as ResumeEligibilitySnapshot);
    assert.equal(result.eligible, false, reason);
    assert.equal(result.reason, reason);
  }
});

test("quota reset timestamp is surfaced as a probe time, not treated as proof of readiness", () => {
  const result = evaluateResumeEligibility({ ...eligibleSnapshot(), quota: { fiveHourReady: false, weeklyReady: true, freshnessOk: true, nextCheckAt: 9876 } });
  assert.deepEqual(result, { eligible: false, reason: "QUOTA_NOT_READY", policyVersion: 6, nextCheckAt: 9876 });
});
