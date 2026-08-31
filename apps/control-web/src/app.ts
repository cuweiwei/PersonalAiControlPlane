import React, { useCallback, useEffect, useMemo, useState } from "react";

type Item = Record<string, unknown>;
type ResourceState = "loading" | "ready" | "error";
type View = { key: string; label: string; endpoint: string; empty: string };
type PortalRoute =
  | { kind: "home" }
  | { kind: "systems" }
  | { kind: "memory" }
  | { kind: "resource"; view: View; id?: string };

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

function route(path: string): PortalRoute {
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0 || parts[0] === "home") return { kind: "home" };
  if (parts[0] === "systems") return { kind: "systems" };
  if (parts[0] === "memory") return { kind: "memory" };
  const view = views.find((candidate) => candidate.key === parts[0]) ?? views[0];
  return { kind: "resource", view, id: parts[1] };
}

function nested(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Item)[key];
  }
  return current;
}

function items(value: unknown, key = "items"): Item[] {
  if (!value || typeof value !== "object") return [];
  const list = (value as Item)[key];
  return Array.isArray(list) ? list.filter((item): item is Item => Boolean(item) && typeof item === "object") : [];
}

function stateClass(value: unknown): string {
  const normalized = text(value).toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return ["healthy", "ready", "ok", "managed", "live-verified"].includes(normalized) ? "good" : ["unhealthy", "error", "failed", "blocked"].includes(normalized) ? "bad" : "warn";
}

function StatusPill({ value }: { value: unknown }) {
  return h("span", { className: `status-pill ${stateClass(value)}` }, text(value));
}

function timestamp(value: unknown): string {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? new Date(numeric).toLocaleString("zh-TW") : text(value);
}

function workerConnectionState(item: Item): string {
  if (text(item.trustState) === "REVOKED") return "REVOKED";
  const staleAt = Number(item.staleAt);
  if (Number.isFinite(staleAt) && staleAt > 0 && staleAt <= Date.now()) return "STALE";
  if (item.lastHeartbeatAt === null || item.lastHeartbeatAt === undefined || !Number.isFinite(Number(item.lastHeartbeatAt))) return "NO_HEARTBEAT";
  return "ONLINE";
}

function WorkerSummary({ item, providers = [] }: { item: Item; providers?: Item[] }) {
  const capabilities = Array.isArray(item.capabilities) ? item.capabilities as Item[] : [];
  const workerProviders = providers.filter((provider) => text(provider.workerId) === text(item.id));
  return h(React.Fragment, null,
    h("div", { className: "worker-status-grid" },
      h("div", null, h("span", null, "連線"), h(StatusPill, { value: workerConnectionState(item) })),
      h("div", null, h("span", null, "信任"), h(StatusPill, { value: item.trustState })),
      h("div", null, h("span", null, "派工"), h(StatusPill, { value: item.drainState })),
      h("div", null, h("span", null, "Heartbeat"), h("strong", null, timestamp(item.lastHeartbeatAt)))),
    h("p", { className: "worker-capabilities" }, h("strong", null, "Capabilities："), capabilities.length ? capabilities.map((capability) => `${text(capability.kind)} · ${text(capability.grantState)}`).join("、") : "尚未發現能力"),
    h("p", { className: "worker-providers" }, h("strong", null, "LLM / Provider："), workerProviders.length ? workerProviders.map((provider) => `${text(provider.class)}${nested(provider, "descriptor", "modelId") ? ` · ${text(nested(provider, "descriptor", "modelId"))}` : ""} · ${text(provider.status)}`).join("、") : "尚未驗證 provider；可能是 tool-only worker"));
}

function IntegrationNotice({ title, detail }: { title: string; detail: string }) {
  return h("aside", { className: "integration-notice" }, h("strong", null, title), h("p", null, detail));
}

function LoadingPanel({ message }: { message: string }) {
  return h("p", { className: "notice loading", role: "status" }, message);
}

function itemTitle(item: Item): string {
  return text(item.intent ?? item.title ?? item.name ?? item.alias ?? item.connector ?? item.action ?? item.id ?? item.status);
}

function DetailFields({ item }: { item: Item }) {
  return h("dl", null, Object.entries(item).filter(([, value]) => value !== undefined).flatMap(([key, value]) => [h("dt", { key: `${key}:label` }, key), h("dd", { key }, text(value))]));
}

function WorkerActionButtons({ item, onRefresh }: { item: Item; onRefresh(): void }) {
  const id = text(item.id);
  const capabilities = Array.isArray(item.capabilities) ? item.capabilities as Item[] : [];
  const active = text(item.trustState) !== "REVOKED";
  const run = async (label: string, path: string, method: "POST" | "DELETE", body?: Item, stepUpRequired = false) => {
    if (["刪除", "撤銷"].includes(label) && !window.confirm(`${label}會撤銷 worker 並保留歷史證據，確定繼續？`)) return;
    try { await mutate(path, { method, body, stepUpRequired }); onRefresh(); } catch (error) { reportError(error); }
  };
  if (!active) return h("p", { className: "worker-revoked" }, "Worker 已撤銷，歷史 evidence 已保留。", h(StatusPill, { value: item.trustState }));
  return h("div", { className: "actions worker-actions" },
    text(item.drainState) === "DRAINED" ? null : h("button", { type: "button", onClick: () => void run("Drain", `/api/v1/workers/${encodeURIComponent(id)}/drain`, "POST") }, "Drain"),
    h("button", { type: "button", onClick: () => void run("Wake", `/api/v1/workers/${encodeURIComponent(id)}/wake`, "POST") }, "Wake"),
    h("button", { type: "button", className: "danger", onClick: () => void run("刪除", `/api/v1/workers/${encodeURIComponent(id)}`, "DELETE", undefined, true) }, "Passkey 刪除 Worker"),
    capabilities.filter((capability) => text(capability.grantState) !== "GRANTED").map((capability) => h("button", { type: "button", key: text(capability.id), onClick: () => void run("Grant", `/api/v1/workers/${encodeURIComponent(id)}/capabilities/${encodeURIComponent(text(capability.id))}/grant`, "POST", { descriptorHash: capability.descriptorHash as string }, true) }, `Passkey grant ${text(capability.kind)}`)));
}

function ItemCard({ item, view, onRefresh, workerProviders = [] }: { item: Item; view: View; onRefresh(): void; workerProviders?: Item[] }) {
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
  return h("article", { className: "card" }, h("h3", null, detail ? h("a", { href: `/${view.key}/${id}` }, itemTitle(item)) : itemTitle(item)), view.key === "workers" ? h(WorkerSummary, { item, providers: workerProviders }) : h(DetailFields, { item }), buttons.length ? h("div", { className: "actions" }, buttons) : null, view.key === "workers" ? h(WorkerActionButtons, { item, onRefresh }) : null);
}

function WorkerComposer({ onRefresh }: { onRefresh(): void }) {
  return h("section", { className: "worker-management", "aria-labelledby": "worker-add-title" },
    h("div", { className: "section-heading compact" }, h("div", null, h("p", { className: "eyebrow" }, "WORKER ENROLLMENT"), h("h3", { id: "worker-add-title" }, "新增 Worker"))),
    h("p", { className: "worker-help" }, "請先在要執行 Codex 的 macOS 或 Windows 裝置安裝並啟動 Worker。Worker 會自行產生 key pair 並建立 enrollment request；Portal 不接收私鑰或手動貼上的 public key。"),
    h("pre", { className: "command-block" }, "pai-worker start --repo-id <logical-id> --repo-path <git-repository>"),
    h("p", { className: "worker-help" }, "確認畫面上的 fingerprint 後，使用 Passkey 按下核准；Worker 會自動完成 proof、取得 credential 並連線。此頁每 5 秒會自動同步待確認 request。若需要手動 recovery，仍可使用 pai-worker enroll / enroll-finalize。Worker 卡片只在 heartbeat、LLM / Provider 與 capability evidence 到齊後顯示可用狀態。"),
    h("button", { type: "button", onClick: onRefresh }, "重新整理 enrollment requests"));
}

function EnrollmentRequestCard({ item, onRefresh }: { item: Item; onRefresh(): void }) {
  const summary = item.deviceSummary && typeof item.deviceSummary === "object" ? item.deviceSummary as Item : {};
  const approve = () => {
    if (!window.confirm("請確認畫面上的 fingerprint 與 worker 裝置一致，再進行 Passkey 核准。")) return;
    void mutate(`/api/v1/workers/enrollment-requests/${encodeURIComponent(text(item.id))}/approve`, { method: "POST", body: { fingerprint: text(item.fingerprint) }, stepUpRequired: true }).then(onRefresh).catch(reportError);
  };
  const cancel = () => {
    if (!window.confirm("取消後此 enrollment request 將不能再核准，確定繼續？")) return;
    void mutate(`/api/v1/workers/enrollment-requests/${encodeURIComponent(text(item.id))}`, { method: "DELETE", stepUpRequired: true }).then(onRefresh).catch(reportError);
  };
  return h("article", { className: "card enrollment-card" },
    h("div", { className: "card-title-row" }, h("div", null, h("h3", null, text(summary.name ?? item.id)), h("p", { className: "service-id" }, text(summary.platform))), h(StatusPill, { value: item.status })),
    h("dl", null, h("dt", null, "Fingerprint"), h("dd", null, text(item.fingerprint)), h("dt", null, "Expires"), h("dd", null, timestamp(item.expiresAt))),
    item.status === "PENDING" ? h("div", { className: "actions" }, h("button", { type: "button", onClick: approve }, "Passkey 核准此 Worker"), h("button", { type: "button", className: "danger", onClick: cancel }, "取消 request")) : item.status === "APPROVED" ? h("p", { className: "worker-help" }, "已核准，等待 worker proof；尚未成為可派工 worker。") : null);
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
    return h(WorkerActionButtons, { item, onRefresh });
  }
  if (view.key === "conversations") return h("div", { className: "actions" }, h("button", { type: "button", onClick: () => void run("匯出", `/api/v1/conversations/${id}/export`, "POST") }, "建立匯出 Job"), h("button", { type: "button", className: "danger", onClick: () => void run("刪除", `/api/v1/conversations/${id}`, "DELETE", { reason: "owner portal deletion", blockFuture: true }, true) }, "Passkey 刪除與 purge"));
  return null;
}

function detailRequests(view: View, id: string): Promise<Item> {
  if (view.key === "goals") return Promise.all([jsonRequest(`/api/v1/goals/${id}`), jsonRequest(`/api/v1/goals/${id}/plans`), jsonRequest(`/api/v1/goals/${id}/tasks`), jsonRequest(`/api/v1/goals/${id}/events`)]).then(([goal, plans, tasks, events]) => ({ ...goal, plans: plans.items, tasks: tasks.items, events: events.items }));
  if (view.key === "workers") return Promise.all([jsonRequest(`${view.endpoint}/${encodeURIComponent(id)}`), jsonRequest("/api/v1/compute/providers")]).then(([worker, providers]) => ({ ...worker, providers: items(providers).filter((provider) => text(provider.workerId) === id) }));
  return jsonRequest(`${view.endpoint}/${encodeURIComponent(id)}`);
}

function ResourceView({ view, id }: { view: View; id?: string }) {
  const [resourceItems, setResourceItems] = useState<Item[]>([]); const [detail, setDetail] = useState<Item | null>(null); const [enrollmentRequests, setEnrollmentRequests] = useState<Item[]>([]); const [workerProviders, setWorkerProviders] = useState<Item[]>([]); const [state, setState] = useState<ResourceState>("loading"); const [message, setMessage] = useState("正在讀取 authority projection…");
  const refresh = useCallback(async () => {
    setState("loading"); setMessage("正在讀取 authority projection…");
    try {
      if (id) { const value = await detailRequests(view, id); setDetail(value); setResourceItems([]); setEnrollmentRequests([]); setWorkerProviders(items(value.providers)); }
      else if (view.key === "workers") { const [body, requests, providers] = await Promise.all([jsonRequest(view.endpoint), jsonRequest("/api/v1/workers/enrollment-requests"), jsonRequest("/api/v1/compute/providers")]); setResourceItems(items(body)); setEnrollmentRequests(items(requests)); setWorkerProviders(items(providers)); setDetail(null); }
      else { const body = view.key === "compute" ? await Promise.all([jsonRequest(view.endpoint), jsonRequest("/api/v1/compute/routes")]).then(([providers, routes]) => ({ items: [...(providers.items as Item[] ?? []), { id: "effective-routes", ...routes }] })) : await jsonRequest(view.endpoint); const next = Array.isArray(body.items) ? body.items.filter((item): item is Item => Boolean(item) && typeof item === "object") : view.key === "system" ? [body] : []; setResourceItems(next); setEnrollmentRequests([]); setWorkerProviders([]); setDetail(null); }
      setState("ready"); setMessage("已從目前 authority 重建；SSE/polling 不取代 REST truth。");
    } catch (error) { setState("error"); setMessage(error instanceof Error ? error.message : "讀取失敗"); }
  }, [id, view]);
  useEffect(() => {
    void refresh();
    if (view.key !== "workers" || id) return;
    const timer = setInterval(() => void refresh(), 5_000);
    return () => clearInterval(timer);
  }, [id, refresh, view.key]);
  const editor = !id && view.key === "goals" ? h(GoalComposer, { onRefresh: refresh }) : !id && view.key === "schedules" ? h(ScheduleComposer, { onRefresh: refresh }) : !id && view.key === "policies" ? h(PolicyEditor, { onRefresh: refresh }) : !id && view.key === "workers" ? h(WorkerComposer, { onRefresh: refresh }) : null;
  const enrollmentPanel = !id && view.key === "workers" ? h("section", { "aria-labelledby": "enrollment-title" }, h("div", { className: "section-heading compact" }, h("div", null, h("p", { className: "eyebrow" }, "PENDING TRUST"), h("h3", { id: "enrollment-title" }, "Enrollment requests"))), enrollmentRequests.length ? h("div", { className: "card-grid" }, enrollmentRequests.map((item) => h(EnrollmentRequestCard, { item, onRefresh: refresh, key: text(item.id) }))) : h("p", { className: "empty" }, "目前沒有 enrollment requests。")) : null;
  return h("section", { "aria-labelledby": "view-title" }, h("div", { className: "section-heading" }, h("div", null, h("p", { className: "eyebrow" }, "OWNER-SAFE AUTHORITY PROJECTION"), h("h2", { id: "view-title" }, `${view.label}${id ? " detail" : ""}`)), h("button", { type: "button", onClick: () => void refresh(), disabled: state === "loading" }, state === "loading" ? "同步中…" : "重新整理")), h("p", { className: `notice ${state}`, role: state === "error" ? "alert" : "status", "aria-live": "polite" }, message), editor, enrollmentPanel, state === "ready" && !id && resourceItems.length === 0 ? h("p", { className: "empty" }, view.empty) : null, detail ? h("article", { className: "card detail-card" }, h("h3", null, itemTitle(detail)), view.key === "workers" ? h(WorkerSummary, { item: detail, providers: items(detail.providers) }) : h(DetailFields, { item: detail }), h(DetailActions, { view, item: detail, onRefresh: refresh })) : h("div", { className: "card-grid" }, resourceItems.map((item, index) => h(ItemCard, { item, view, onRefresh: refresh, workerProviders, key: text(item.id ?? item.goalId ?? index) }))));
}

function PortalHome() {
  const [data, setData] = useState<{ system?: Item; memory?: Item }>({});
  const [state, setState] = useState<ResourceState>("loading");
  const refresh = useCallback(async () => {
    setState("loading");
    const [system, memory] = await Promise.allSettled([
      jsonRequest("/api/v1/system"),
      jsonRequest("/api/portal/v1/memory/namespaces"),
    ]);
    setData({
      system: system.status === "fulfilled" ? system.value : undefined,
      memory: memory.status === "fulfilled" ? memory.value : undefined,
    });
    setState("ready");
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const counts = data.system && typeof data.system.counts === "object" ? data.system.counts as Item : {};
  const namespaces = items(data.memory, "namespaces");
  return h("section", { "aria-labelledby": "home-title" },
    h("div", { className: "portal-hero" },
      h("div", null, h("p", { className: "eyebrow" }, "ONE OWNER · ONE PRIVATE ENTRY"), h("h2", { id: "home-title" }, "你的 Personal AI 首頁"), h("p", null, "工作、Memory 與 Personal AI 執行狀態集中在同一個 Passkey Portal；外部系統仍保留自己的資料與部署邊界。")),
      h("div", { className: "hero-actions" }, h("a", { className: "button-link", href: "/goals" }, "建立 Goal"), h("a", { className: "button-link secondary", href: "/systems" }, "系統狀態"))),
    state === "loading" ? h(LoadingPanel, { message: "正在同步各 authority 的只讀總覽…" }) : null,
    h("div", { className: "metric-grid" },
      h("article", null, h("span", null, "Durable Goals"), h("strong", null, text(counts.goals ?? 0)), h("small", null, `${text(counts.openApprovals ?? 0)} 個待核准`)),
      h("article", null, h("span", null, "Memory Spaces"), h("strong", null, namespaces.length || "—"), h("small", null, namespaces.length ? namespaces.map((item) => text(item.namespace)).join(" · ") : "尚待 Identity link")),
      h("article", null, h("span", null, "Workers"), h("strong", null, text(counts.workers ?? 0)), h("small", null, `${text(counts.providers ?? 0)} compute providers`)),
      h("article", null, h("span", null, "Runtime"), h("strong", null, text(nested(data.system, "health", "status") ?? "—")), h("small", null, text(nested(data.system, "health", "runtime") ?? "evidence pending")))),
    h("div", { className: "quick-grid" },
      h("a", { href: "/goals" }, h("span", { className: "quick-icon", "aria-hidden": "true" }, "◎"), h("strong", null, "工作中心"), h("p", null, "Goals、Approvals、Schedules 與執行證據。")),
      h("a", { href: "/memory" }, h("span", { className: "quick-icon", "aria-hidden": "true" }, "◇"), h("strong", null, "Memory"), h("p", null, "直接檢索 ContextHub accepted Memory。")),
      h("a", { href: "/systems" }, h("span", { className: "quick-icon", "aria-hidden": "true" }, "▦"), h("strong", null, "Systems"), h("p", null, "查看 Personal AI 自身狀態與獨立服務入口。"))),
    h(IntegrationNotice, { title: "Authority boundary", detail: "Portal 只呈現各系統的 authority projection；健康狀態不會被當成部署、備份、還原或 provider 驗證成功。" }));
}

function SystemsView() {
  const [system, setSystem] = useState<Item | null>(null);
  const [state, setState] = useState<ResourceState>("loading");
  const [message, setMessage] = useState("正在讀取 Personal AI 狀態…");
  const refresh = useCallback(async () => {
    setState("loading");
    try {
      setSystem(await jsonRequest("/api/v1/system"));
      setState("ready");
      setMessage("Personal AI runtime 狀態已同步；外部服務維持獨立部署與權責。");
    } catch (error) { setState("error"); setMessage(error instanceof Error ? error.message : "Personal AI 狀態讀取失敗"); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const health = nested(system, "health") as Item | undefined;
  const counts = nested(system, "counts") as Item | undefined;
  return h("section", { "aria-labelledby": "systems-title" },
    h("div", { className: "section-heading" }, h("div", null, h("p", { className: "eyebrow" }, "PERSONAL AI RUNTIME"), h("h2", { id: "systems-title" }, "Systems")), h("button", { type: "button", onClick: () => void refresh(), disabled: state === "loading" }, state === "loading" ? "同步中…" : "重新整理")),
    h("p", { className: `notice ${state}`, role: state === "error" ? "alert" : "status" }, message),
    h("div", { className: "service-grid" },
      h("article", { className: "service-card", id: "personal-ai-control-plane" },
        h("div", { className: "card-title-row" }, h("div", null, h("p", { className: "service-id" }, "personal-ai-control-plane"), h("h3", null, "Personal AI Control Plane")), h(StatusPill, { value: health?.status })),
        h("p", null, "Identity、Control Web、Orchestrator 與 Conversation Archive 的本地 authority。"),
        h("div", { className: "service-meta" }, h("span", null, "Database", h(StatusPill, { value: health?.database })), h("span", null, "Audit chain", h(StatusPill, { value: health?.auditChain })), h("span", null, "Goals", h("strong", null, text(counts?.goals ?? 0)))),
        h("a", { className: "button-link secondary", href: "/home" }, "在 Portal 查看")),
      h("article", { className: "service-card", id: "contexthub" },
        h("div", { className: "card-title-row" }, h("div", null, h("p", { className: "service-id" }, "contexthub"), h("h3", null, "ContextHub Memory")), h(StatusPill, { value: "INDEPENDENT" })),
        h("p", null, "Semantic Memory 維持獨立資料庫與部署；Portal 僅透過 safe-method projection 讀取。"),
        h("a", { className: "button-link secondary", href: "/memory" }, "開啟 Memory")),
      h("article", { className: "service-card", id: "hermes-agent" },
        h("div", { className: "card-title-row" }, h("div", null, h("p", { className: "service-id" }, "hermes-agent"), h("h3", null, "Hermes")), h(StatusPill, { value: "INDEPENDENT" })),
        h("p", null, "Hermes 維持獨立 conversational edge、資料、release 與 rollback；此 Portal 不再代理其管理狀態。"))),
    h(IntegrationNotice, { title: "Independent authority boundaries", detail: "Personal AI 不再依賴 AI Home Platform runtime。部署、rollback、backup 與 restore 仍由各 repository 的 operator workflow 和 root-owned deployment gateway 負責；Portal 不持有 Docker 或 NAS 權限。" }));
}

function MemoryView() {
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [namespace, setNamespace] = useState("");
  const [queryText, setQueryText] = useState("");
  const [summary, setSummary] = useState<Item | null>(null);
  const [memories, setMemories] = useState<Item[]>([]);
  const [state, setState] = useState<ResourceState>("loading");
  const [message, setMessage] = useState("正在讀取 ContextHub…");
  const load = useCallback(async (requestedNamespace = namespace, search = queryText) => {
    setState("loading");
    try {
      const namespaceBody = await jsonRequest("/api/portal/v1/memory/namespaces");
      const available = items(namespaceBody, "namespaces").map((item) => text(item.namespace)).filter((item) => item !== "—");
      const selected = requestedNamespace && available.includes(requestedNamespace) ? requestedNamespace : available[0] ?? "";
      setNamespaces(available); setNamespace(selected);
      if (!selected) { setSummary(null); setMemories([]); setState("ready"); setMessage("Personal AI owner 尚未連結任何 ContextHub human namespace。"); return; }
      const params = new URLSearchParams({ namespace: selected, limit: "50" });
      if (search.trim()) params.set("q", search.trim());
      const [dashboard, result] = await Promise.all([
        jsonRequest(`/api/portal/v1/memory/dashboard?namespace=${encodeURIComponent(selected)}`),
        jsonRequest(`/api/portal/v1/memory/memories?${params.toString()}`),
      ]);
      setSummary(dashboard); setMemories(items(result)); setState("ready"); setMessage(`已從 ContextHub ${selected} authority 讀取 accepted Memory。`);
    } catch (error) {
      setState("error"); setSummary(null); setMemories([]);
      setMessage(error instanceof Error ? error.message : "ContextHub 讀取失敗");
    }
  }, [namespace, queryText]);
  useEffect(() => { void load("", ""); }, []);
  return h("section", { "aria-labelledby": "memory-title" },
    h("div", { className: "section-heading" }, h("div", null, h("p", { className: "eyebrow" }, "CONTEXTHUB SEMANTIC AUTHORITY"), h("h2", { id: "memory-title" }, "Memory")), h("button", { type: "button", onClick: () => void load(), disabled: state === "loading" }, state === "loading" ? "同步中…" : "重新整理")),
    h("p", { className: `notice ${state}`, role: state === "error" ? "alert" : "status" }, message),
    h("form", { className: "memory-toolbar", onSubmit: (event: React.FormEvent) => { event.preventDefault(); void load(namespace, queryText); } },
      h("label", null, "Namespace", h("select", { value: namespace, onChange: (event: React.ChangeEvent<HTMLSelectElement>) => { const value = event.target.value; setNamespace(value); void load(value, queryText); } }, namespaces.map((value) => h("option", { value, key: value }, value)))),
      h("label", null, "搜尋 accepted Memory", h("input", { type: "search", value: queryText, placeholder: "輸入關鍵字", onChange: (event: React.ChangeEvent<HTMLInputElement>) => setQueryText(event.target.value) })),
      h("button", { type: "submit", disabled: state === "loading" || !namespace }, "搜尋")),
    summary ? h("div", { className: "metric-grid memory-metrics" },
      h("article", null, h("span", null, "Visible"), h("strong", null, text(summary.visible_total ?? 0)), h("small", null, namespace)),
      h("article", null, h("span", null, "Candidates"), h("strong", null, text(summary.candidates ?? 0)), h("small", null, "等待 review")),
      h("article", null, h("span", null, "Agents"), h("strong", null, Array.isArray(summary.agents) ? summary.agents.length : 0), h("small", null, "linked clients"))) : null,
    h("div", { className: "memory-list" }, memories.map((memory, index) => h("article", { className: "memory-card", key: text(memory.id ?? index) },
      h("div", { className: "card-title-row" }, h("h3", null, text(memory.title ?? memory.type ?? memory.id)), h(StatusPill, { value: memory.trust_state ?? memory.trustState ?? "accepted" })),
      h("p", null, text(memory.content ?? memory.summary ?? memory.value)),
      h("div", { className: "memory-meta" }, h("span", null, text(memory.source ?? memory.source_id)), h("span", null, text(memory.updated_at ?? memory.occurred_at ?? memory.created_at)))))),
    state === "ready" && namespace && memories.length === 0 ? h("p", { className: "empty" }, queryText ? "沒有符合搜尋條件的 accepted Memory。" : "這個 namespace 目前沒有可見 Memory。") : null,
    h(IntegrationNotice, { title: "Memory authority remains ContextHub", detail: "Portal 不會複製 accepted Memory，也不會把 raw conversations 寫進 ContextHub。Successor、review 與 policy mutation 將在簽署授權完成後另行開放。" }));
}

export function App({ initialPath = typeof window === "undefined" ? "/home" : window.location.pathname }: { initialPath?: string }) {
  const current = useMemo(() => route(initialPath), [initialPath]);
  const active = current.kind === "resource" ? current.view.key : current.kind;
  const content = current.kind === "home" ? h(PortalHome) : current.kind === "systems" ? h(SystemsView) : current.kind === "memory" ? h(MemoryView) : h(ResourceView, { view: current.view, id: current.id });
  const primary = [{ key: "home", label: "首頁" }, { key: "goals", label: "Goals" }, { key: "approvals", label: "Approvals" }, { key: "schedules", label: "Schedules" }, { key: "memory", label: "Memory" }, { key: "systems", label: "Systems" }];
  const secondary = views.filter((view) => !["goals", "approvals", "schedules"].includes(view.key));
  return h(React.Fragment, null,
    h("a", { className: "skip-link", href: "#main" }, "跳到主要內容"),
    h("header", { className: "portal-header" },
      h("a", { className: "brand brand-link", href: "/home" }, h("span", { className: "brand-mark", "aria-hidden": "true" }, "P"), h("span", null, h("span", { className: "eyebrow" }, "PERSONAL AI"), h("strong", null, "Control Plane"), h("small", null, "One private owner portal"))),
      h("nav", { "aria-label": "主要導覽", className: "primary-nav" }, primary.map((item) => h("a", { key: item.key, href: `/${item.key}`, "aria-current": item.key === active ? "page" : undefined }, item.label))),
      h("details", { className: "more-nav" }, h("summary", null, "更多"), h("nav", { "aria-label": "次要導覽" }, secondary.map((view) => h("a", { key: view.key, href: `/${view.key}`, "aria-current": view.key === active ? "page" : undefined }, view.label))))),
    h("main", { id: "main", tabIndex: -1 }, content,
      h("aside", { className: "boundary", "aria-label": "Evidence boundary" }, h("strong", null, "Evidence boundary"), h("p", null, "Health 不等於 management；tombstone 不等於實體 purge；deployment request 不等於 live verification。外部 adapter 不可用時會明確失敗，不會假成功。"))),
    h("footer", null, "Personal AI Control Plane · one owner portal · independent authority boundaries"));
}
