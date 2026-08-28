import assert from "node:assert/strict";
import test from "node:test";
import { ApprovalService, type ApprovalBounds } from "../apps/orchestrator/src/approval-service.ts";
import { OrchestratorDatabase } from "../apps/orchestrator/src/db.ts";

const scope: ApprovalBounds = { actions: ["read"], resources: ["repo"], capabilityIds: ["cap"], workers: ["worker"], filesystemRoots: ["/repo"], networkDestinations: ["none"], recipients: ["owner"], mergeMode: "none", deploymentMode: "none", budget: { tokens: 100 } };

test("approval request is immutable until a single approve/reject decision", () => {
  const db = new OrchestratorDatabase(":memory:");
  const now = 1_700_000_000_000;
  const approval = new ApprovalService(db, () => now);
  db.run("INSERT INTO goals(id, owner_id, source_json, intent, scope_json, constraints_json, memory_requirement, status, state_version, policy_version, created_at, updated_at) VALUES ('g', 'o', '{}', 'x', '[]', '{}', 'none', 'ACTIVE', 0, 1, ?, ?)", now, now);
  const request = approval.createRequest({ goalId: "g", planDigest: "sha256:p", policyVersion: 1, requiredScope: scope, expiresAt: now + 60_000, correlationId: "c" });
  const grant = approval.approve(request.id, "owner", now, "signed-grant", scope);
  assert.equal(grant.requestId, request.id);
  assert.equal(approval.getRequest(request.id)?.status, "APPROVED");
  assert.throws(() => approval.approve(request.id, "owner", now, "signed-grant-2", scope), /not open/);
  db.close();
});

test("expired and rejected approvals cannot produce grants", () => {
  const db = new OrchestratorDatabase(":memory:");
  let now = 1_700_000_000_000;
  const approval = new ApprovalService(db, () => now);
  db.run("INSERT INTO goals(id, owner_id, source_json, intent, scope_json, constraints_json, memory_requirement, status, state_version, policy_version, created_at, updated_at) VALUES ('g', 'o', '{}', 'x', '[]', '{}', 'none', 'ACTIVE', 0, 1, ?, ?)", now, now);
  const request = approval.createRequest({ goalId: "g", planDigest: "sha256:p", policyVersion: 1, requiredScope: scope, expiresAt: now + 10 });
  now += 20;
  assert.equal(approval.expireOpen(), 1);
  assert.throws(() => approval.approve(request.id, "owner", now, "signed", scope), /not open/);
  const rejected = approval.createRequest({ goalId: "g", planDigest: "sha256:p2", policyVersion: 1, requiredScope: scope, expiresAt: now + 10 });
  assert.equal(approval.reject(rejected.id, "owner").status, "REJECTED");
  db.close();
});
