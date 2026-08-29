import React, { useCallback, useEffect, useMemo, useState } from "react";

type Item = Record<string, unknown>;
type ResourceState = "loading" | "ready" | "error";
type View = { key: string; label: string; endpoint: string; empty: string };

const views: View[] = [
  { key: "goals", label: "Goals", endpoint: "/api/v1/goals", empty: "目前沒有 durable goals。" },
  { key: "approvals", label: "Approvals", endpoint: "/api/v1/approvals", empty: "目前沒有 approval requests。" },
  { key: "schedules", label: "Schedules", endpoint: "/api/v1/schedules", empty: "目前沒有 schedules。" },
  { key: "workers", label: "Workers", endpoint: "/api/v1/workers", empty: "目前沒有已註冊 workers。" },
  { key: "compute", label: "Compute", endpoint: "/api/v1/compute/providers", empty: "目前沒有已驗證 compute providers。" },
  { key: "conversations", label: "Conversations", endpoint: "/api/v1/conversations", empty: "目前沒有 archived conversations。" },
  { key: "connectors", label: "Connectors", endpoint: "/api/v1/connectors", empty: "目前沒有 connector evidence。" },
  { key: "credentials", label: "Credentials", endpoint: "/api/v1/credentials", empty: "目前沒有 credential handles。" },
  { key: "policies", label: "Policies", endpoint: "/api/v1/policies", empty: "目前沒有 policy revisions。" },
  { key: "audit", label: "Audit", endpoint: "/api/v1/audit", empty: "目前沒有 audit events。" },
  { key: "system", label: "System", endpoint: "/api/v1/system", empty: "目前沒有 system projection。" },
];

const h = React.createElement;

function text(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function base64Url(value: ArrayBuffer | ArrayBufferView): string {
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  let output = "";
  for (const byte of bytes) output += String.fromCharCode(byte);
  return btoa(output).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bytes(value: unknown): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value !== "string" || value.length === 0) throw new Error("WebAuthn options are invalid");
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function authenticationJson(credential: PublicKeyCredential): Record<string, unknown> {
  const response = credential.response as AuthenticatorAssertionResponse;
  const rawId = base64Url(credential.rawId);
  return { id: rawId, rawId, type: credential.type, response: { clientDataJSON: base64Url(response.clientDataJSON), authenticatorData: base64Url(response.authenticatorData), signature: base64Url(response.signature), userHandle: response.userHandle ? base64Url(response.userHandle) : null }, clientExtensionResults: credential.getClientExtensionResults() };
}

async function jsonRequest(path: string, init: RequestInit = {}): Promise<Item> {
  const response = await fetch(path, { ...init, credentials: "same-origin", headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) } });
  const body = await response.json().catch(() => ({})) as Item;
  if (!response.ok) {
    const error = body.error as Item | undefined;
    throw new Error(text(error?.message ?? `Request failed (${response.status})`));
  }
  return body;
}

async function csrfToken(): Promise<string> {
  const body = await jsonRequest("/api/v1/auth/csrf");
  if (typeof body.csrfToken !== "string") throw new Error("Identity Gateway did not issue a CSRF token");
  return body.csrfToken;
}

export async function stepUp(): Promise<void> {
  const csrf = await csrfToken();
  const start = await jsonRequest("/api/v1/auth/step-up/options", { method: "POST", headers: { "x-pai-csrf-token": csrf } });
  const options = start.options as PublicKeyCredentialRequestOptions & { challenge: unknown; allowCredentials?: Array<PublicKeyCredentialDescriptor & { id: unknown }> };
  const credential = await navigator.credentials.get({ publicKey: { ...options, challenge: bytes(options.challenge), allowCredentials: options.allowCredentials?.map((item) => ({ ...item, id: bytes(item.id) })) } }) as PublicKeyCredential | null;
  if (!credential) throw new Error("Passkey step-up was cancelled");
  await jsonRequest("/api/v1/auth/step-up/finish", { method: "POST", headers: { "x-pai-csrf-token": csrf }, body: JSON.stringify({ challengeId: start.challengeId, response: authenticationJson(credential) }) });
}

export async function mutate(path: string, options: { method: "POST" | "PATCH" | "DELETE"; body?: Item; stepUpRequired?: boolean }): Promise<Item> {
  if (options.stepUpRequired) await stepUp();
  const csrf = await csrfToken();
  return jsonRequest(path, { method: options.method, headers: { "x-pai-csrf-token": csrf, "idempotency-key": crypto.randomUUID() }, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
}

function reportError(error: unknown): void {
  window.alert(error instanceof Error ? error.message : "操作失敗");
}

function route(path: string): { view: View; id?: string } {
  const parts = path.split("/").filter(Boolean);
  const view = views.find((candidate) => candidate.key === parts[0]) ?? views[0];
  return { view, id: parts[1] };
}

function itemTitle(item: Item): string {
  return text(item.intent ?? item.title ?? item.name ?? item.alias ?? item.connector ?? item.action ?? item.id ?? item.status);
}

function DetailFields({ item }: { item: Item }) {
  return h("dl", null, Object.entries(item).filter(([, value]) => value !== undefined).flatMap(([key, value]) => [h("dt", { key: `${key}:label` }, key), h("dd", { key }, text(value))]));
}

function ItemCard({ item, view, onRefresh }: { item: Item; view: View; onRefresh(): void }) {
  const id = text(item.id ?? item.goalId ?? item.connector);
  const detail = ["goals", "approvals", "schedules", "workers", "conversations"].includes(view.key) && item.id;
  const action = async (label: string, path: string, method: "POST" | "PATCH" | "DELETE", body?: Item, sensitive = false) => {
    if ((label === "刪除" || label === "撤銷") && !window.confirm(`${label}是安全敏感操作，確定繼續？`)) return;
    try { await mutate(path, { method, body, stepUpRequired: sensitive }); onRefresh(); } catch (error) { reportError(error); }
  };
  const buttons: React.ReactNode[] = [];
  if (view.key === "schedules") {
    buttons.push(h("button", { type: "button", key: "pause", onClick: () => void action("暫停", `/api/v1/schedules/${id}/pause`, "POST") }, "暫停"));
    buttons.push(h("button", { type: "button", key: "run", onClick: () => void action("立即執行", `/api/v1/schedules/${id}/run`, "POST") }, "立即執行"));
    buttons.push(h("button", { type: "button", key: "delay", onClick: () => void action("延後", `/api/v1/schedules/${id}`, "PATCH", { expectedStateVersion: Number(item.stateVersion), nextRunAt: Date.now() + 60 * 60_000 }) }, "延後 1 小時"));
  }
  if (view.key === "connectors") {
    buttons.push(h("button", { type: "button", key: "run", onClick: () => void action("同步", `/api/v1/connectors/${encodeURIComponent(text(item.connector))}/run`, "POST") }, "同步"));
    buttons.push(h("button", { type: "button", key: "reauthorize", onClick: () => void action("重新授權", `/api/v1/connectors/${encodeURIComponent(text(item.connector))}/reauthorize`, "POST") }, "重新授權"));
  }
  return h("article", { className: "card" }, h("h3", null, detail ? h("a", { href: `/${view.key}/${id}` }, itemTitle(item)) : itemTitle(item)), h(DetailFields, { item }), buttons.length ? h("div", { className: "actions" }, buttons) : null);
}

function GoalComposer({ onRefresh }: { onRefresh(): void }) {
  const [intent, setIntent] = useState("");
  return h("form", { className: "editor", onSubmit: (event: React.FormEvent) => { event.preventDefault(); void mutate("/api/v1/goals", { method: "POST", body: { intent, source: { kind: "web" }, memoryRequirement: "preferred" } }).then(() => { setIntent(""); onRefresh(); }).catch(reportError); } }, h("label", null, "新增 durable goal", h("textarea", { value: intent, required: true, onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => setIntent(event.target.value) })), h("button", { type: "submit" }, "提交 Goal"));
}

function ScheduleComposer({ onRefresh }: { onRefresh(): void }) {
  const [name, setName] = useState(""); const [intent, setIntent] = useState(""); const [everyMinutes, setEveryMinutes] = useState(60);
  return h("form", { className: "editor", onSubmit: (event: React.FormEvent) => { event.preventDefault(); void mutate("/api/v1/schedules", { method: "POST", body: { name, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, recurrence: { kind: "interval", everyMs: everyMinutes * 60_000, templateRevision: 1 }, nextRunAt: Date.now() + everyMinutes * 60_000, misfirePolicy: "SKIP", goalTemplate: { intent, source: { kind: "schedule" }, memoryRequirement: "preferred" } } }).then(() => { setName(""); setIntent(""); onRefresh(); }).catch(reportError); } }, h("label", null, "名稱", h("input", { value: name, required: true, onChange: (event: React.ChangeEvent<HTMLInputElement>) => setName(event.target.value) })), h("label", null, "Goal intent", h("textarea", { value: intent, required: true, onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => setIntent(event.target.value) })), h("label", null, "間隔（分鐘）", h("input", { type: "number", min: 1, value: everyMinutes, onChange: (event: React.ChangeEvent<HTMLInputElement>) => setEveryMinutes(Number(event.target.value)) })), h("button", { type: "submit" }, "建立 Schedule"));
}

function PolicyEditor({ onRefresh }: { onRefresh(): void }) {
  const [value, setValue] = useState('{\n  "autonomy": {},\n  "hardStops": []\n}');
  return h("form", { className: "editor", onSubmit: (event: React.FormEvent) => { event.preventDefault(); let policy: Item; try { policy = JSON.parse(value); } catch { window.alert("Policy 必須是有效 JSON"); return; } void mutate("/api/v1/policies", { method: "PATCH", body: policy, stepUpRequired: true }).then(onRefresh).catch(reportError); } }, h("label", null, "新增 immutable policy revision", h("textarea", { value, rows: 8, onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => setValue(event.target.value) })), h("button", { type: "submit" }, "Passkey 驗證並建立 revision"));
}

function ApprovalEditor({ item, onRefresh }: { item: Item; onRefresh(): void }) {
  const [bounds, setBounds] = useState(JSON.stringify(item.requiredScope ?? {}, null, 2));
  const id = text(item.id);
  const decide = (decision: "APPROVE" | "REJECT") => {
    let approvedBounds: Item = {};
    if (decision === "APPROVE") { try { approvedBounds = JSON.parse(bounds); } catch { window.alert("Approved bounds 必須是有效 JSON"); return; } }
    void mutate(`/api/v1/approvals/${id}/decision`, { method: "POST", body: decision === "APPROVE" ? { decision, approvedBounds } : { decision }, stepUpRequired: decision === "APPROVE" }).then(onRefresh).catch(reportError);
  };
  return h("form", { className: "editor", onSubmit: (event: React.FormEvent) => { event.preventDefault(); decide("APPROVE"); } }, h("label", null, "Approved bounds（只能縮窄）", h("textarea", { rows: 12, value: bounds, onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => setBounds(event.target.value) })), h("div", { className: "actions" }, h("button", { type: "submit" }, "Passkey 核准 bounds"), h("button", { type: "button", className: "danger", onClick: () => decide("REJECT") }, "拒絕")));
}

function DetailActions({ view, item, onRefresh }: { view: View; item: Item; onRefresh(): void }) {
  const id = text(item.id);
  const run = async (label: string, path: string, method: "POST" | "DELETE", body?: Item, sensitive = false) => {
    if (["取消", "刪除", "撤銷"].includes(label) && !window.confirm(`${label}會改變 durable state，確定繼續？`)) return;
    try { await mutate(path, { method, body, stepUpRequired: sensitive }); onRefresh(); } catch (error) { reportError(error); }
  };
  if (view.key === "goals") return h("div", { className: "actions" }, h("button", { type: "button", onClick: () => void run("取消", `/api/v1/goals/${id}/cancel`, "POST") }, "取消 Goal"), h("button", { type: "button", onClick: () => void run("重試", `/api/v1/goals/${id}/retry`, "POST") }, "重試可恢復工作"));
  if (view.key === "approvals" && item.status === "OPEN") return h(ApprovalEditor, { item, onRefresh });
  if (view.key === "schedules") return h("div", { className: "actions" }, h("button", { type: "button", onClick: () => void run("暫停", `/api/v1/schedules/${id}/pause`, "POST") }, "暫停"), h("button", { type: "button", onClick: () => void run("立即執行", `/api/v1/schedules/${id}/run`, "POST") }, "立即執行"));
  if (view.key === "workers") {
    const capabilities = Array.isArray(item.capabilities) ? item.capabilities as Item[] : [];
    return h(React.Fragment, null, h("div", { className: "actions" }, h("button", { type: "button", onClick: () => void run("Drain", `/api/v1/workers/${id}/drain`, "POST") }, "Drain"), h("button", { type: "button", onClick: () => void run("Wake", `/api/v1/workers/${id}/wake`, "POST") }, "Wake（需 adapter）"), h("button", { type: "button", className: "danger", onClick: () => void run("撤銷", `/api/v1/workers/${id}/revoke`, "POST", undefined, true) }, "Passkey 撤銷 Worker")), capabilities.map((capability) => h("button", { type: "button", key: text(capability.id), onClick: () => void run("Grant", `/api/v1/workers/${id}/capabilities/${text(capability.id)}/grant`, "POST", { descriptorHash: capability.descriptorHash as string }, true) }, `Passkey grant ${text(capability.kind)}`)));
  }
  if (view.key === "conversations") return h("div", { className: "actions" }, h("button", { type: "button", onClick: () => void run("匯出", `/api/v1/conversations/${id}/export`, "POST") }, "建立匯出 Job"), h("button", { type: "button", className: "danger", onClick: () => void run("刪除", `/api/v1/conversations/${id}`, "DELETE", { reason: "owner portal deletion", blockFuture: true }, true) }, "Passkey 刪除與 purge"));
  return null;
}

function detailRequests(view: View, id: string): Promise<Item> {
  if (view.key === "goals") return Promise.all([jsonRequest(`/api/v1/goals/${id}`), jsonRequest(`/api/v1/goals/${id}/plans`), jsonRequest(`/api/v1/goals/${id}/tasks`), jsonRequest(`/api/v1/goals/${id}/events`)]).then(([goal, plans, tasks, events]) => ({ ...goal, plans: plans.items, tasks: tasks.items, events: events.items }));
  return jsonRequest(`${view.endpoint}/${encodeURIComponent(id)}`);
}

function ResourceView({ view, id }: { view: View; id?: string }) {
  const [items, setItems] = useState<Item[]>([]); const [detail, setDetail] = useState<Item | null>(null); const [state, setState] = useState<ResourceState>("loading"); const [message, setMessage] = useState("正在讀取 authority projection…");
  const refresh = useCallback(async () => {
    setState("loading"); setMessage("正在讀取 authority projection…");
    try {
      if (id) { const value = await detailRequests(view, id); setDetail(value); setItems([]); }
      else { const body = view.key === "compute" ? await Promise.all([jsonRequest(view.endpoint), jsonRequest("/api/v1/compute/routes")]).then(([providers, routes]) => ({ items: [...(providers.items as Item[] ?? []), { id: "effective-routes", ...routes }] })) : await jsonRequest(view.endpoint); const next = Array.isArray(body.items) ? body.items.filter((item): item is Item => Boolean(item) && typeof item === "object") : view.key === "system" ? [body] : []; setItems(next); setDetail(null); }
      setState("ready"); setMessage("已從目前 authority 重建；SSE/polling 不取代 REST truth。");
    } catch (error) { setState("error"); setMessage(error instanceof Error ? error.message : "讀取失敗"); }
  }, [id, view]);
  useEffect(() => { void refresh(); }, [refresh]);
  const editor = !id && view.key === "goals" ? h(GoalComposer, { onRefresh: refresh }) : !id && view.key === "schedules" ? h(ScheduleComposer, { onRefresh: refresh }) : !id && view.key === "policies" ? h(PolicyEditor, { onRefresh: refresh }) : null;
  return h("section", { "aria-labelledby": "view-title" }, h("div", { className: "section-heading" }, h("div", null, h("p", { className: "eyebrow" }, "OWNER-SAFE AUTHORITY PROJECTION"), h("h2", { id: "view-title" }, `${view.label}${id ? " detail" : ""}`)), h("button", { type: "button", onClick: () => void refresh(), disabled: state === "loading" }, state === "loading" ? "同步中…" : "重新整理")), h("p", { className: `notice ${state}`, role: state === "error" ? "alert" : "status", "aria-live": "polite" }, message), editor, state === "ready" && !id && items.length === 0 ? h("p", { className: "empty" }, view.empty) : null, detail ? h("article", { className: "card detail-card" }, h("h3", null, itemTitle(detail)), h(DetailFields, { item: detail }), h(DetailActions, { view, item: detail, onRefresh: refresh })) : h("div", { className: "card-grid" }, items.map((item, index) => h(ItemCard, { item, view, onRefresh: refresh, key: text(item.id ?? item.goalId ?? index) }))));
}

export function App({ initialPath = typeof window === "undefined" ? "/goals" : window.location.pathname }: { initialPath?: string }) {
  const current = useMemo(() => route(initialPath), [initialPath]);
  return h(React.Fragment, null, h("a", { className: "skip-link", href: "#main" }, "跳到主要內容"), h("header", null, h("div", { className: "brand" }, h("p", { className: "eyebrow" }, "PERSONAL AI"), h("h1", null, "Control Plane"), h("p", null, "Durable work、approval 與 authority evidence。")), h("nav", { "aria-label": "主要導覽" }, views.map((view) => h("a", { key: view.key, href: `/${view.key}`, "aria-current": view.key === current.view.key ? "page" : undefined }, view.label)), h("a", { href: "/infrastructure/" }, "Infrastructure"), h("a", { href: "/memory/" }, "Memory"))), h("main", { id: "main", tabIndex: -1 }, h(ResourceView, current), h("aside", { className: "boundary", "aria-label": "Evidence boundary" }, h("strong", null, "Evidence boundary"), h("p", null, "Health 不等於 management；tombstone 不等於實體 purge；deployment request 不等於 live verification。外部 adapter 不可用時會明確失敗，不會假成功。"))), h("footer", null, "Personal AI Control Plane · private owner route"));
}
