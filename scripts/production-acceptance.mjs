#!/usr/bin/env node
/**
 * Fail-closed production acceptance probe for the Virtual Office slice.
 * It checks only observable HTTP contracts; it never claims Worker/provider
 * execution unless the operator supplies an explicit mission id and requires
 * completion.
 */

const origin = (process.env.PAI_ACCEPTANCE_ORIGIN ?? "http://127.0.0.1:8080").replace(/\/$/, "");
const requireOffice = process.env.PAI_ACCEPTANCE_REQUIRE_OFFICE === "true";
const requireWorker = process.env.PAI_ACCEPTANCE_REQUIRE_WORKER === "true";
const requireHermes = process.env.PAI_ACCEPTANCE_REQUIRE_HERMES === "true";
const hermesOrigin = (process.env.PAI_ACCEPTANCE_HERMES_ORIGIN ?? "").replace(/\/$/, "");
const missionId = process.env.PAI_ACCEPTANCE_MISSION_ID;
const requireCompletion = process.env.PAI_ACCEPTANCE_REQUIRE_COMPLETION === "true";
const evidence = [];

async function probe(name, path, predicate) {
  try {
    const response = await fetch(`${origin}${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) });
    const body = await response.json().catch(() => ({}));
    const ok = response.ok && (!predicate || predicate(body));
    evidence.push({ name, state: ok ? "PASS" : "FAIL", status: response.status, detail: ok ? undefined : body.error?.code ?? body.status ?? "contract mismatch" });
    return { response, body, ok };
  } catch (error) {
    evidence.push({ name, state: "FAIL", detail: error instanceof Error ? error.message : "request failed" });
    return { ok: false, body: {} };
  }
}

await probe("control-plane health", "/healthz", (body) => body.status === "ok");
await probe("control-plane readiness", "/readyz", (body) => body.status === "ok");
const acceptance = await probe("acceptance projection", "/api/v2/acceptance", (body) => body.service === "personal-ai-control-plane" && body.ready === true && body.office?.id === "office-1" && body.coordinator?.recoveryMode === false && Number(body.coordinator?.unknownExecutions ?? 0) === 0 && Number(body.coordinator?.unknownAttempts ?? 0) === 0 && Number(body.coordinator?.unknownSlots ?? 0) === 0);
const office = await probe("office projection", "/api/v2/offices/office-1", (body) => body.id === "office-1" && body.workflowHealth?.schemaReady === true);

if (requireOffice) {
  const ok = office.body.workflowHealth?.officeEnabled === true;
  evidence.push({ name: "office enabled", state: ok ? "PASS" : "FAIL", detail: ok ? undefined : "office_enabled is false" });
}
if (requireHermes) {
  const ok = office.body.workflowHealth?.state === "READY" && office.body.workflowHealth?.hermesAdapterConfigured === true;
  evidence.push({ name: "Hermes adapter configured", state: ok ? "PASS" : "FAIL", detail: ok ? undefined : "Hermes adapter is not READY" });
  if (!hermesOrigin) {
    evidence.push({ name: "Hermes adapter capabilities", state: "FAIL", detail: "PAI_ACCEPTANCE_HERMES_ORIGIN is required when Hermes acceptance is enabled" });
  } else {
    const adapter = await probe("Hermes adapter capabilities", `${hermesOrigin}/api/internal/office/capabilities`, (body) => body.service === "hermes-office-adapter" && body.protocol_version === 1 && body.driver?.available === true && body.driver?.resume_mode === "STEP_CONTEXT" && Number(body.driver?.max_slots ?? 0) >= 1);
    if (!adapter.ok && adapter.body) evidence.at(-1).detail = adapter.body.error ?? "adapter is not ready for a bounded turn";
  }
}
if (requireWorker) {
  const workers = await probe("mission-capable Worker", "/api/v2/workers", (body) => (body.items ?? []).some((item) => item.connection?.state === "ONLINE" && ["mission_execution_v1", "stop_evidence_v1", "workspace_exclusion_v1"].every((feature) => (item.protocolFeatures ?? item.protocol_features ?? []).includes(feature))));
  if (!workers.ok && workers.body?.items) evidence.at(-1).detail = "no online Worker with mission protocol features";
}
if (missionId) {
  const mission = await probe("mission projection", `/api/v2/missions/${encodeURIComponent(missionId)}`, (body) => body.id === missionId && body.run?.id);
  await probe("mission result projection", `/api/v2/missions/${encodeURIComponent(missionId)}/results`, (body) => body.missionId === missionId);
  if (requireCompletion) {
    const ok = mission.body.run?.phase === "COMPLETED";
    evidence.push({ name: "mission completed", state: ok ? "PASS" : "FAIL", detail: ok ? undefined : `phase=${mission.body.run?.phase ?? "UNKNOWN"}` });
  }
}

const failed = evidence.filter((item) => item.state === "FAIL");
console.log(JSON.stringify({ state: failed.length ? "FAIL" : "PASS", origin, evidence, acceptanceProjection: acceptance.body }, null, 2));
if (failed.length) process.exitCode = 1;
