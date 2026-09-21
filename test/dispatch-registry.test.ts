import assert from "node:assert/strict";
import test from "node:test";
import { ControlPlaneDatabase } from "../apps/control-plane/src/db/database.ts";
import { DispatchRuleRegistry } from "../apps/control-plane/src/dispatch/rule-registry.ts";

test("registry lists immutable latest revision while release stays pinned", () => {
  const db = new ControlPlaneDatabase(":memory:");
  try {
    const registry = new DispatchRuleRegistry(db);
    const base = registry.get("service-health-check", 1)!;
    registry.createCandidate({ ...base, revision: 2 }, "owner");
    const listed = registry.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].revision, 2);
    assert.equal(listed[0].state, "CANDIDATE");
    assert.equal(registry.rulesForRelease(registry.activeRelease()!.id)[0].revision, 1);
  } finally { db.close(); }
});

test("multiple releases created at the same timestamp retain unique identities", () => {
  const db = new ControlPlaneDatabase(":memory:");
  try {
    const registry = new DispatchRuleRegistry(db);
    const active = registry.activeRelease()!;
    const first = registry.createRelease({ ...active.manifest, policyRevision: 2 }, "owner");
    const second = registry.createRelease({ ...active.manifest, policyRevision: 3 }, "owner");
    assert.notEqual(first.id, second.id);
  } finally { db.close(); }
});

test("candidate rules cannot name an unimplemented renderer or missing service extractor", () => {
  const db = new ControlPlaneDatabase(":memory:");
  try {
    const registry = new DispatchRuleRegistry(db);
    const base = registry.get("service-health-check", 1)!;
    assert.throws(() => registry.createCandidate({ ...base, revision: 2, response: { templateId: "unavailable", resultSchemaVersion: 1 } }, "owner"), /INVALID_DISPATCH_RULE_RESPONSE/);
    assert.throws(() => registry.createCandidate({ ...base, revision: 2, slots: {} }, "owner"), /INVALID_DISPATCH_RULE_SLOT/);
    assert.equal(registry.list()[0].revision, 1);
  } finally { db.close(); }
});

test("a learned rule cannot promote itself using an arbitrary evidence reference", () => {
  const db = new ControlPlaneDatabase(":memory:");
  try {
    const registry = new DispatchRuleRegistry(db);
    const base = registry.get("service-health-check", 1)!;
    registry.createCandidate({ ...base, ruleId: "learned-health", provenance: { origin: "learned", evidenceRefs: ["unverified-observation"] } }, "hermes");
    registry.transition("learned-health", 1, "SHADOW", 1, "owner", "REVIEW");
    const releaseBefore = registry.activeRelease();
    assert.throws(() => registry.transition("learned-health", 1, "ACTIVE", 2, "owner", "MODEL_SAYS_SAFE", "fabricated-evaluation"), /DISPATCH_PROMOTION_EVALUATION_UNAVAILABLE/);
    assert.equal(registry.state("learned-health", 1)?.state, "SHADOW");
    assert.deepEqual(registry.activeRelease(), releaseBefore);
  } finally { db.close(); }
});

test("bounded patterns cannot silently drop text after a second slot placeholder", () => {
  const db = new ControlPlaneDatabase(":memory:");
  try {
    const registry = new DispatchRuleRegistry(db);
    const base = registry.get("service-health-check", 1)!;
    assert.throws(() => registry.createCandidate({ ...base, revision: 2, match: { exact: ["{service} status {service} delete"] } }, "owner"), /INVALID_DISPATCH_RULE_PATTERN/);
    assert.throws(() => registry.createCandidate({ ...base, revision: 2, match: { exact: ["{unknown} status"] } }, "owner"), /INVALID_DISPATCH_RULE_PATTERN/);
  } finally { db.close(); }
});

test("disabling an old revision does not remove its active replacement", () => {
  const db = new ControlPlaneDatabase(":memory:");
  try {
    const registry = new DispatchRuleRegistry(db);
    const base = registry.get("service-health-check", 1)!;
    registry.createCandidate({ ...base, revision: 2, match: { exact: ["{service} online"] } }, "owner");
    registry.transition(base.ruleId, 2, "SHADOW", 1, "owner", "CURATED_REVIEW");
    registry.transition(base.ruleId, 2, "ACTIVE", 2, "owner", "CURATED_REVIEW");
    registry.transition(base.ruleId, 1, "DISABLED", 1, "owner", "OLD_REVISION");
    const rules = registry.rulesForRelease(registry.activeRelease()!.id);
    assert.equal(rules.length, 1);
    assert.equal(rules[0].revision, 2);
  } finally { db.close(); }
});
