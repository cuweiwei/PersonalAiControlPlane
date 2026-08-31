import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { App, mutate } from "../apps/control-web/src/app.ts";

test("Control Web renders owner read projections with semantic navigation and evidence boundary", () => {
  const markup = renderToStaticMarkup(React.createElement(App, { initialPath: "/workers" }));
  const document = readFileSync(new URL("../apps/control-web/index.html", import.meta.url), "utf8");
  assert.match(document, /<html lang="zh-Hant">/);
  assert.match(markup, /Control Plane/);
  assert.match(markup, /<nav aria-label="主要導覽" class="primary-nav">/);
  assert.match(markup, /aria-current="page"[^>]*>Workers/);
  assert.match(markup, /<main id="main" tabindex="-1">/);
  assert.match(markup, /Health 不等於 management/);
  for (const label of ["首頁", "Goals", "Approvals", "Schedules", "Workers", "Compute", "Conversations", "Connectors", "Credentials", "Policies", "Audit", "System", "Systems", "Infrastructure", "Memory"]) assert.match(markup, new RegExp(`>${label}<`));
  assert.match(markup, /role="status"/);
});

test("Worker tab exposes enrollment, status, provider, and lifecycle controls", () => {
  const markup = renderToStaticMarkup(React.createElement(App, { initialPath: "/workers" }));
  assert.match(markup, /新增 Worker/);
  assert.match(markup, /pai-worker start --repo-id/);
  assert.match(markup, /自動完成 proof/);
  assert.match(markup, /Portal 不接收私鑰/);
  assert.match(markup, /Enrollment requests/);
  assert.match(markup, /LLM \/ Provider/);
});

test("Control Web exposes one portal entry while preserving service authority boundaries", () => {
  const home = renderToStaticMarkup(React.createElement(App, { initialPath: "/home" }));
  const systems = renderToStaticMarkup(React.createElement(App, { initialPath: "/systems" }));
  const infrastructure = renderToStaticMarkup(React.createElement(App, { initialPath: "/infrastructure" }));
  const memory = renderToStaticMarkup(React.createElement(App, { initialPath: "/memory" }));
  assert.match(home, /你的 Personal AI 首頁/);
  assert.match(home, /ONE OWNER · ONE PRIVATE ENTRY/);
  assert.match(systems, /INDEPENDENT SERVICES · ONE PORTAL/);
  assert.match(systems, /Hermes 維持獨立入口/);
  assert.match(infrastructure, /AIHOMEPLATFORM AUTHORITY/);
  assert.match(infrastructure, /owner-safe read integration/);
  assert.match(memory, /CONTEXTHUB SEMANTIC AUTHORITY/);
  assert.match(memory, /Memory authority remains ContextHub/);
});

test("Control Web exposes durable goal, schedule, and step-up policy management forms", () => {
  const goals = renderToStaticMarkup(React.createElement(App, { initialPath: "/goals" }));
  const schedules = renderToStaticMarkup(React.createElement(App, { initialPath: "/schedules" }));
  const policies = renderToStaticMarkup(React.createElement(App, { initialPath: "/policies" }));
  assert.match(goals, /新增 durable goal/);
  assert.match(goals, /提交 Goal/);
  assert.match(schedules, /建立 Schedule/);
  assert.match(policies, /Passkey 驗證並建立 revision/);
});

test("Control Web mutations bootstrap a session-bound CSRF token and send an idempotency key", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    if (url === "/api/v1/auth/csrf") return new Response(JSON.stringify({ csrfToken: "csrf-test" }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await mutate("/api/v1/goals/goal-1/cancel", { method: "POST" });
    assert.equal(requests[0].url, "/api/v1/auth/csrf");
    assert.equal(requests[1].url, "/api/v1/goals/goal-1/cancel");
    const headers = requests[1].init?.headers as Record<string, string>;
    assert.equal(headers["x-pai-csrf-token"], "csrf-test");
    assert.match(headers["idempotency-key"], /^[0-9a-f-]{36}$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Control Web stylesheet includes visible focus, narrow-screen cards, and reduced-motion handling", () => {
  const css = readFileSync(new URL("../apps/control-web/src/styles.css", import.meta.url), "utf8");
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media \(max-width: 700px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /\.danger/);
  assert.doesNotMatch(css, /outline:\s*none/);
});

test("production Compose runs one container while preserving the AIHomePlatform edge aliases", () => {
  const compose = readFileSync(new URL("../compose.prod.yml", import.meta.url), "utf8");
  const services = compose.slice(compose.indexOf("services:"), compose.indexOf("\nnetworks:"));
  assert.deepEqual([...services.matchAll(/^  ([a-z][a-z0-9-]+):$/gm)].map((match) => match[1]), ["pai-control-plane"]);
  assert.equal([...services.matchAll(/^    image:/gm)].length, 1);
  assert.match(services, /apps\/control-plane\/src\/index\.ts/);
  assert.match(compose, /name: ai-home-platform_edge/);
  for (const alias of ["pai-edge-control-web", "pai-edge-identity", "pai-edge-orchestrator"]) assert.match(compose, new RegExp(`- ${alias}`));
  assert.match(compose, /PAI_CANONICAL_ORIGIN: https:\/\/gnest\.taila77e5f\.ts\.net(?:\r?\n)/);
  assert.doesNotMatch(compose, /127\.0\.0\.1:9084:9084/);
  assert.match(compose, /127\.0\.0\.1:9083:8080/);
  assert.match(compose, /127\.0\.0\.1:9085:9085/);
});
