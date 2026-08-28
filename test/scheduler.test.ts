import assert from "node:assert/strict";
import test from "node:test";
import { boundedExponentialBackoff, containsGrant, dispositionForFailure, evaluateTaskEligibility, selectRoute, selectTask } from "../packages/scheduler/src/index.ts";

test("scheduler filters safety eligibility before ordering by deadline and priority", () => {
  assert.deepEqual(evaluateTaskEligibility({ id: "x", state: "READY", activePlan: true, dependenciesComplete: true, cancellationRequested: false, policyAllowed: false, credentialsHealthy: true, quotaReservable: true, workerAvailable: true, readyAt: 1 }), { eligible: false, reasons: ["policy-denied"] });
  const selected = selectTask([
    { id: "late", state: "READY", activePlan: true, dependenciesComplete: true, cancellationRequested: false, policyAllowed: true, credentialsHealthy: true, quotaReservable: true, workerAvailable: true, readyAt: 1, deadlineAt: 200, ownerPriority: "URGENT", resumeAffinity: false },
    { id: "early", state: "READY", activePlan: true, dependenciesComplete: true, cancellationRequested: false, policyAllowed: true, credentialsHealthy: true, quotaReservable: true, workerAvailable: true, readyAt: 2, deadlineAt: 100, ownerPriority: "LOW", resumeAffinity: false },
  ]);
  assert.equal(selected?.id, "early");
});

test("route selection rejects quality failures and ranks only eligible routes", () => {
  const result = selectRoute([
    { id: "bad-quality", providerId: "p1", qualityEligible: false, capabilityCompatible: true, workerHealthy: true, credentialHealthy: true, quotaReservable: true, dataLocalityRank: 0, costRank: 0, latencyMs: 1, energyRank: 0, workerLoad: 0 },
    { id: "remote", providerId: "p2", qualityEligible: true, capabilityCompatible: true, workerHealthy: true, credentialHealthy: true, quotaReservable: true, dataLocalityRank: 1, costRank: 0, latencyMs: 1, energyRank: 0, workerLoad: 0 },
    { id: "local", providerId: "p3", qualityEligible: true, capabilityCompatible: true, workerHealthy: true, credentialHealthy: true, quotaReservable: true, dataLocalityRank: 0, costRank: 2, latencyMs: 5, energyRank: 0, workerLoad: 0 },
  ]);
  assert.equal(result.selected?.id, "local");
  assert.deepEqual(result.rejected, [{ id: "bad-quality", reasons: ["quality-floor"] }]);
});

test("failure classes and backoff preserve uncertainty", () => {
  assert.equal(dispositionForFailure("UNCERTAIN_SIDE_EFFECT"), "RECONCILE");
  assert.equal(dispositionForFailure("AUTH"), "WAITING_AUTH");
  assert.equal(boundedExponentialBackoff(3, 1000, 10_000, () => 0), 4000);
  assert.equal(boundedExponentialBackoff(20, 1000, 10_000, () => 1), 10_000);
});

test("replan containment rejects broader dimensions and stale grants", () => {
  const grant = { goalId: "g", ownerId: "o", actions: ["read"], capabilityIds: ["cap"], workers: ["w"], filesystemRoots: ["/repo"], networkDestinations: ["none"], recipients: ["owner"], mergeMode: "none", deploymentMode: "none", budget: { tokens: 100 }, policyVersion: 1, expiresAt: 2000 };
  assert.equal(containsGrant({ ...grant, actions: ["read"], expiresAt: 1500 }, grant, 1000), true);
  assert.equal(containsGrant({ ...grant, actions: ["write"], expiresAt: 1500 }, grant, 1000), false);
  assert.equal(containsGrant({ ...grant, expiresAt: 2000 }, grant, 2000), false);
});
