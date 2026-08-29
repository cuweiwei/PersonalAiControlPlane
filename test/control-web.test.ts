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
  assert.match(markup, /<nav aria-label="主要導覽">/);
  assert.match(markup, /aria-current="page"[^>]*>Workers/);
  assert.match(markup, /<main id="main" tabindex="-1">/);
  assert.match(markup, /Health 不等於 management/);
  for (const label of ["Goals", "Approvals", "Schedules", "Workers", "Compute", "Conversations", "Connectors", "Credentials", "Policies", "Audit", "System", "Infrastructure", "Memory"]) assert.match(markup, new RegExp(`>${label}<`));
  assert.match(markup, /role="status"/);
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
