import assert from "node:assert/strict";
import test from "node:test";
import { attentionCommandBody, attentionListPath, classifyAttentionCommandResponse, relatedWorkForAttention } from "../apps/control-web/src/attention/attention-page.ts";

test("Attention page sends bounded list queries and fixed command payloads", () => {
  assert.equal(attentionListPath("OPEN", "HIGH"), "/api/v2/attention?limit=100&state=OPEN&severity=HIGH");
  assert.deepEqual(attentionCommandBody("READ", 4), { kind: "READ", expected_revision: 4 });
  assert.deepEqual(attentionCommandBody("SNOOZE", 4, 1_800_000_000_000), { kind: "SNOOZE", expected_revision: 4, payload: { snooze_until: 1_800_000_000_000 } });
  assert.deepEqual(attentionCommandBody("UNSNOOZE", 5), { kind: "UNSNOOZE", expected_revision: 5 });
});

test("Attention page creates only fixed encoded internal work links", () => {
  assert.deepEqual(relatedWorkForAttention("TASK", "task/a b"), { href: "/tasks/task%2Fa%20b", label: "查看任務" });
  assert.deepEqual(relatedWorkForAttention("MISSION", "mission-1"), { href: "/missions/mission-1", label: "查看 Mission" });
  assert.deepEqual(relatedWorkForAttention("GOAL", "goal-1"), { href: "/goals", label: "查看目標列表" });
  assert.deepEqual(relatedWorkForAttention("SKILL", "skill-1"), { href: "/skills", label: "查看技能列表" });
  assert.deepEqual(relatedWorkForAttention("ROUTINE_BINDING", "routine-1"), { href: "/routines", label: "查看例行工作列表" });
  assert.equal(relatedWorkForAttention("EXTERNAL", "https://evil.example/path"), null);
  assert.equal(relatedWorkForAttention("TASK", ""), null);
});

test("Attention page accepts only an APPLIED result as command success", () => {
  assert.equal(classifyAttentionCommandResponse(200, { state: "APPLIED" }), "APPLIED");
  assert.equal(classifyAttentionCommandResponse(200, { state: "REJECTED", error: "REVISION_CONFLICT" }), "REJECTED");
  assert.equal(classifyAttentionCommandResponse(409, { state: "APPLIED" }), "REJECTED");
  assert.equal(classifyAttentionCommandResponse(200, {}), "UNKNOWN");
  assert.equal(classifyAttentionCommandResponse(503, { error: { code: "UNAVAILABLE" } }), "UNKNOWN");
});
