import assert from "node:assert/strict";
import test from "node:test";
import { OrchestratorDatabase } from "../apps/orchestrator/src/db.ts";
import { CapabilityProposalService, ProactiveService } from "../apps/orchestrator/src/proactive.ts";
import { ScheduleService } from "../apps/orchestrator/src/schedule-service.ts";

function goalSeed(db: OrchestratorDatabase, now: number) { db.run("INSERT INTO goals(id, owner_id, source_json, intent, scope_json, constraints_json, memory_requirement, status, state_version, policy_version, created_at, updated_at) VALUES ('g', 'o', '{}', 'x', '[]', '{}', 'none', 'ACTIVE', 0, 1, ?, ?)", now, now); }

test("proactive triggers dedupe before goal creation and proposal gates cannot self-grant", () => {
  const now = 1_700_000_000_000;
  const db = new OrchestratorDatabase(":memory:");
  const service = new ProactiveService(db, () => now);
  let submissions = 0;
  const first = service.observe({ source: "worker-health", domain: "compute", observedAt: new Date(now).toISOString(), evidenceRefs: ["e1"], recommendedMode: "INVESTIGATE" }, () => { submissions += 1; return "goal-1"; });
  const second = service.observe({ source: "worker-health", domain: "compute", observedAt: new Date(now).toISOString(), evidenceRefs: ["e1"], recommendedMode: "INVESTIGATE" }, () => { submissions += 1; return "goal-2"; });
  assert.equal(first.triggerId, second.triggerId);
  assert.equal(submissions, 1);
  const proposalService = new CapabilityProposalService(db, () => now);
  const proposal = proposalService.propose({ targetRepository: "repo", contract: {}, permissions: {}, estimate: {}, risk: {}, tests: {}, release: {} });
  assert.throws(() => proposalService.advance(proposal.id, "GRANTED"), /approval/);
  assert.equal(proposalService.approveDevelopment(proposal.id, "owner").status, "DEVELOPMENT_APPROVED");
  assert.equal(proposalService.advance(proposal.id, "IMPLEMENTED").status, "IMPLEMENTED");
  assert.throws(() => proposalService.advance(proposal.id, "GRANTED"), /gate order/);
  db.close();
});

test("schedules use timezone validation, stable firing keys, and pause gate", () => {
  const now = 1_700_000_000_000;
  const db = new OrchestratorDatabase(":memory:");
  goalSeed(db, now);
  const service = new ScheduleService(db, () => now);
  const schedule = service.create({ name: "health", timezone: "Asia/Taipei", recurrence: { kind: "interval", everyMs: 60_000, templateRevision: 1 }, nextRunAt: now + 1, misfirePolicy: "RUN_ONCE", goalTemplate: { intent: "check" } });
  let count = 0;
  const fired = service.evaluateDue((template, key) => { count += 1; assert.equal(template.intent, "check"); assert.match(key, /^sha256:/); return "g"; }, now + 2);
  assert.deepEqual(fired, ["g"]);
  assert.equal(service.evaluateDue(() => "goal-duplicate", now + 2).length, 0);
  assert.equal(count, 1);
  assert.equal(service.pause(schedule.id).status, "PAUSED");
  assert.throws(() => service.create({ name: "bad", timezone: "Not/AZone", recurrence: { kind: "interval", everyMs: 1000, templateRevision: 1 }, nextRunAt: now + 1, misfirePolicy: "SKIP", goalTemplate: {} }), /invalid/);
  db.close();
});
