import React, { useCallback, useEffect, useMemo, useState } from "react";

type Item = Record<string, any>;
const h = React.createElement;
const nav = [
  ["/", "工作總覽"],
  ["/tasks", "任務"],
  ["/workers", "執行裝置"],
  ["/models", "模型"],
  ["/systems", "系統"],
  ["/settings", "設定"],
] as const;
const statusLabels: Record<string, string> = { QUEUED: "等待執行", ASSIGNED: "已派送", RUNNING: "執行中", SUCCEEDED: "已完成", FAILED: "失敗", CANCELLED: "已取消", ONLINE: "線上", OFFLINE: "離線", DISABLED: "已停用", READY: "可用", UNAVAILABLE: "目前無法使用", DEGRADED: "降級", UNKNOWN: "未知", LOADED: "已載入", AVAILABLE: "可取得", PENDING: "等待中", RETRY_WAIT: "等待重試", IN_FLIGHT: "投遞中", DELIVERED: "已交付", ATTENTION: "需要處理", RELEASED: "已釋放", RELEASING: "釋放中", RESERVED: "已預留" };

function display(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function time(value: unknown): string {
  return value ? new Date(String(value)).toLocaleString("zh-TW") : "—";
}

function statusClass(value: unknown): string {
  const normalized = display(value).toLowerCase();
  if (["healthy", "online", "succeeded", "ready", "ok"].includes(normalized)) return "good";
  if (["offline", "failed", "cancelled", "disabled", "degraded"].includes(normalized)) return "bad";
  return "warn";
}

function Status({ value }: { value: unknown }) {
  const raw = display(value); return h("span", { className: `status-pill ${statusClass(value)}`, title: raw }, statusLabels[raw] ?? "未知狀態");
}

async function request(path: string, init: RequestInit = {}): Promise<Item> {
  const response = await fetch(path, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => ({})) as Item;
  if (!response.ok) throw new Error(display(body.error?.message ?? body.error?.code ?? `HTTP ${response.status}`));
  return body;
}

function useRefresh(): [number, () => void] {
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((current) => current + 1), []);
  return [version, refresh];
}

function Layout({ children, path, refresh }: { children: React.ReactNode; path: string; refresh(): void }) {
  useEffect(() => {
    const source = new EventSource("/api/v2/events");
    source.onmessage = refresh;
    return () => source.close();
  }, [refresh]);
  return h(
    React.Fragment,
    null,
    h(
      "header",
      { className: "portal-header" },
      h("a", { className: "brand-link", href: "/" },
        h("span", { className: "brand-mark", "aria-hidden": true }, "P"),
        h("span", null, h("strong", null, "PERSONAL AI"), h("small", null, "CONTROL PLANE v2"))),
      h("nav", { className: "primary-nav", "aria-label": "主要導覽" }, nav.map(([href, label]) =>
        h("a", { key: href, href, "aria-current": path === href || (href !== "/" && path.startsWith(href)) ? "page" : undefined }, label))),
    ),
    h("main", null, children),
    h("footer", null, "Hermes thinks · ContextHub remembers · Control Plane coordinates · Workers execute"),
  );
}

function Card({ title, value, detail }: { title: string; value: unknown; detail?: string }) {
  return h("article", { className: "metric-card" }, h("span", null, title), h("strong", null, display(value)), detail ? h("small", null, detail) : null);
}

function Loading() { return h("p", { className: "notice loading", role: "status" }, "同步 Control Plane 狀態…"); }
function ErrorPanel({ error }: { error: unknown }) { return h("p", { className: "notice error", role: "alert" }, error instanceof Error ? error.message : "讀取失敗"); }

function Details({ item }: { item: Item }) {
  return h("dl", null, Object.entries(item).filter(([, value]) => value !== undefined).flatMap(([key, value]) => [
    h("dt", { key: `${key}-label` }, key),
    h("dd", { key }, display(value)),
  ]));
}

function Home({ refreshVersion }: { refreshVersion: number }) {
  const [data, setData] = useState<Item | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let alive = true;
    request("/api/v2/dashboard")
      .then((dashboard) => alive && setData(dashboard))
      .catch((reason) => alive && setError(reason));
    return () => { alive = false; };
  }, [refreshVersion]);
  if (!data) return error ? h(React.Fragment, null, h(ErrorPanel, { error }), h("button", { type: "button", onClick: () => setError(null) }, "重新載入")) : h(Loading);
  const systems = data.systems?.items ?? []; const recent = data.recentTasks?.items ?? []; const latest = data.latestResults?.items ?? []; const summary = data.summary24h ?? {};
  return h(React.Fragment, null,
    h("section", { className: "portal-hero" },
      h("div", null,
        h("p", { className: "eyebrow" }, "執行控制台 / v2"),
        h("h1", null, "Hermes 的工作，Worker 的算力"),
        h("p", null, "Control Plane 管理任務、Worker、資源與成果回傳；Hermes 負責思考與規劃。")),
      h("div", { className: "hero-actions" }, h("a", { className: "button-link", href: "/tasks" }, "查看任務"), h("a", { className: "button-link secondary", href: "/workers/new" }, "新增執行裝置"))),
    h("section", { className: "metric-grid" },
      h(Card, { title: "Hermes", value: systems.find((item: Item) => item.id === "hermes")?.status ?? "UNKNOWN" }),
      h(Card, { title: "ContextHub", value: systems.find((item: Item) => item.id === "contexthub")?.status ?? "UNKNOWN" }),
      h(Card, { title: "正在執行", value: data.running?.items ?? 0, detail: "目前所有期間" }),
      h(Card, { title: "24 小時完成", value: summary.countsByStatus?.SUCCEEDED ?? 0, detail: "最近 24 小時建立的正式任務" })),
    h("section", { className: "card-grid" },
      h(Card, { title: "等待中", value: summary.countsByStatus?.QUEUED ?? 0, detail: "最近 24 小時" }),
      h(Card, { title: "失敗", value: summary.countsByStatus?.FAILED ?? 0, detail: "最近 24 小時" }),
      h(Card, { title: "待處理事項", value: data.attention?.items?.length ?? 0 })),
    h("section", { className: "card" }, h("div", { className: "section-heading" }, h("div", null, h("p", { className: "eyebrow" }, "需要你處理"), h("h2", null, data.attention?.items?.length ? "有工作需要查看" : "目前沒有需要處理的工作")), h("a", { className: "button-link secondary", href: "/tasks?status=FAILED" }, "查看失敗任務")), data.attention?.items?.slice(0, 5).map((item: Item) => h("p", { key: item.taskId }, h("a", { href: `/tasks/${item.taskId}` }, item.taskId), " · ", item.primaryReason))),
    h("section", { className: "section-heading" }, h("div", null, h("p", { className: "eyebrow" }, "最近活動"), h("h2", null, "最近任務")), h("a", { className: "button-link secondary", href: "/tasks" }, "全部任務")),
    h("div", { className: "card-grid" }, [...recent, ...latest].filter((task: Item, index, all) => all.findIndex((other: Item) => other.id === task.id) === index).slice(0, 6).map((task: Item) =>
      h("article", { className: "card", key: task.id },
        h("div", { className: "card-title-row" }, h("a", { href: `/tasks/${task.id}` }, task.title), h(Status, { value: task.status })),
        h("p", null, `${display(task.taskType)} · ${display(task.execution?.workerId ?? "自動選擇")} · ${time(task.createdAt)}`)))),
  );
}

function TaskDetail({ id, refreshVersion }: { id: string; refreshVersion: number }) {
  const [item, setItem] = useState<Item | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { request(`/api/v2/tasks/${encodeURIComponent(id)}`).then(setItem).catch(setError); }, [id, refreshVersion]);
  if (error) return h(ErrorPanel, { error });
  if (!item) return h(Loading);
  const action = async (suffix: string) => {
    setBusy(true);
    try { const retry = suffix === "retry"; await request(`/api/v2/tasks/${encodeURIComponent(id)}/${suffix}`, { method: "POST", ...(retry ? { headers: { "idempotency-key": `ui-retry-${id}-${item.revision}`, "if-match": `task-${item.revision}` }, body: JSON.stringify({ expected_run_id: item.currentRunId, expected_task_revision: item.revision }) } : {}) }); setItem(await request(`/api/v2/tasks/${encodeURIComponent(id)}`)); }
    catch (reason) { setError(reason); }
    finally { setBusy(false); }
  };
  return h(React.Fragment, null,
    h("div", { className: "section-heading" }, h("div", null, h("p", { className: "eyebrow" }, "任務詳情"), h("h1", null, item.title)), h(Status, { value: item.status })),
    h("div", { className: "actions" }, ["QUEUED", "ASSIGNED", "RUNNING"].includes(item.status) ? h("button", { type: "button", disabled: busy, onClick: () => void action("cancel") }, "取消任務") : null, item.status === "FAILED" ? h("button", { type: "button", disabled: busy, onClick: () => void action("retry") }, "重新執行") : null),
    h("section", { className: "detail-card card" }, h("h2", null, "摘要"), h(Details, { item: { taskType: item.taskType, source: item.source, correlationId: item.correlationId, worker: item.resolvedExecution?.workerId ?? item.execution?.workerId ?? "自動選擇", runtime: item.resolvedExecution?.runtime ?? "—", model: item.resolvedExecution?.model ?? item.execution?.model, workspace: item.resolvedExecution?.workspaceId ?? item.execution?.workspaceId ?? "—", run: item.currentRunId, priority: item.priority, attemptCount: item.attemptCount, createdAt: time(item.createdAt), instruction: item.instruction, result: item.result, failure: item.failure } })),
    h("section", { className: "card" }, h("h2", null, "執行輪次與成果"), h("div", { className: "card-grid" }, (item.runs ?? []).map((run: Item) => h("article", { className: "card", key: run.id }, h("div", { className: "card-title-row" }, h("strong", null, `第 ${run.runNumber} 輪`), h(Status, { value: run.status })), h("p", null, `${run.trigger} · ${run.attemptsUsed}/${run.maxAttempts} 次 · ${time(run.createdAt)}`), run.result ? h("pre", null, display(run.result)) : null))), (item.artifacts ?? []).map((artifact: Item) => h("p", { key: artifact.id }, h(Status, { value: artifact.availability }), " ", artifact.filename, " · ", h("a", { href: `/api/v2/artifacts/${artifact.id}/preview` }, "預覽"), " · ", h("a", { href: `/api/v2/artifacts/${artifact.id}/download` }, "下載"))), item.delivery?.length ? h("div", { className: "notice" }, item.delivery.map((delivery: Item) => h("p", { key: delivery.eventId }, `Hermes：${statusLabels[delivery.state] ?? delivery.state} · ${delivery.lastError ?? ""}`, ["RETRY_WAIT", "ATTENTION"].includes(delivery.state) ? h("button", { type: "button", onClick: () => void request(`/api/v2/tasks/${id}/delivery/retry`, { method: "POST", headers: { "idempotency-key": `ui-delivery-${delivery.eventId}` }, body: JSON.stringify({ event_id: delivery.eventId }) }).then(() => setItem({ ...item })) }, "重新投遞") : null))) : null),
    h("section", { className: "card" }, h("h2", null, "事件時間線"), h("div", { className: "timeline" }, (item.events ?? []).map((event: Item) => h("article", { key: event.eventId }, h(Status, { value: event.type }), h("span", null, time(event.createdAt)), h("p", null, display(event.payload))))), h("details", null, h("summary", null, "技術詳細資料"), h("pre", null, JSON.stringify({ revision: item.revision, execution: item.execution, dispatch: item.dispatch }, null, 2)))),
  );
}

function Tasks({ refreshVersion }: { refreshVersion: number }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const initialQuery = typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search);
  const [filter, setFilter] = useState(initialQuery.get("status") ?? ""); const [search, setSearch] = useState(initialQuery.get("search") ?? ""); const [cursor, setCursor] = useState<string | null>(initialQuery.get("cursor")); const [page, setPage] = useState<Item | null>(null);
  useEffect(() => { const params = new URLSearchParams(); params.set("purpose", "USER"); params.set("limit", "50"); if (filter) params.set("status", filter); if (search) params.set("search", search); if (cursor) params.set("cursor", cursor); window.history.replaceState({}, "", `/tasks?${params}`); setItems(null); request(`/api/v2/tasks?${params}`).then((value) => { setItems(value.items ?? []); setPage(value.page ?? null); }).catch(setError); }, [filter, search, cursor, refreshVersion]);
  if (!items) return error ? h(ErrorPanel, { error }) : h(Loading);
  return h(React.Fragment, null,
    h("div", { className: "section-heading" }, h("div", null, h("p", { className: "eyebrow" }, "任務管理"), h("h1", null, "任務")), h("select", { value: filter, onChange: (event: React.ChangeEvent<HTMLSelectElement>) => { setFilter(event.target.value); setCursor(null); } }, h("option", { value: "" }, "全部狀態"), ["QUEUED", "ASSIGNED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"].map((value) => h("option", { key: value, value }, statusLabels[value])))),
    h("div", { className: "worker-toolbar" }, h("label", null, "搜尋任務", h("input", { value: search, onChange: (event: React.ChangeEvent<HTMLInputElement>) => { setSearch(event.target.value); setCursor(null); }, placeholder: "名稱、ID、來源或實際執行目標", "aria-label": "搜尋任務" })), h("button", { className: "secondary", type: "button", onClick: () => { setFilter(""); setSearch(""); setCursor(null); } }, "清除條件")),
    items.length === 0 ? h("p", { className: "notice" }, search || filter ? "目前條件沒有符合的任務。" : "尚未建立正式任務。") : null,
    h("div", { className: "table-wrap" }, h("table", null,
      h("thead", null, h("tr", null, ["任務", "狀態", "類型", "實際 Worker / 模型", "優先級", "建立時間"].map((header) => h("th", { key: header }, header)))),
      h("tbody", null, items.map((item) => h("tr", { key: item.id }, h("td", null, h("a", { href: `/tasks/${item.id}` }, item.title), h("small", null, item.id)), h("td", null, h(Status, { value: item.status })), h("td", null, item.taskType), h("td", null, `${display(item.execution?.workerId ?? "auto")} / ${display(item.execution?.model?.name ?? "any")}`), h("td", null, item.priority), h("td", null, time(item.createdAt))))))),
    h("div", { className: "actions" }, h("button", { className: "secondary", type: "button", disabled: !page?.nextCursor, onClick: () => setCursor(page?.nextCursor ?? null) }, "下一頁"), page?.hasMore ? h("small", null, "還有更多任務") : h("small", null, `${items.length} 筆`)),
  );
}

function Workers({ refreshVersion }: { refreshVersion: number }) {
  const [data, setData] = useState<Item | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  useEffect(() => { Promise.all([request("/api/v2/workers"), request("/api/v2/workers/registrations")]).then(([workers, registrations]) => setData({ workers: workers.items ?? [], registrations: registrations.items ?? [] })).catch(setError); }, [refreshVersion]);
  if (!data) return error ? h(ErrorPanel, { error }) : h(Loading);
  const reload = async () => setData({ workers: (await request("/api/v2/workers")).items ?? [], registrations: (await request("/api/v2/workers/registrations")).items ?? [] });
  const run = async (path: string, method = "POST", body?: unknown) => { try { await request(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); await reload(); } catch (reason) { setError(reason); } };
  const workers = data.workers.filter((item: Item) => {
    const needle = search.trim().toLowerCase();
    const matches = !needle || [item.name, item.hostname, item.id, item.platform].some((value) => String(value ?? "").toLowerCase().includes(needle));
    const state = item.connection?.state;
    return matches && (filter === "all" || (filter === "online" && state === "ONLINE") || (filter === "attention" && ["STALE", "NO_HEARTBEAT"].includes(state)) || (filter === "drained" && ["DRAINING", "DRAINED"].includes(item.dispatch?.state)));
  });
  const allWorkers = data.workers as Item[];
  const pending = data.registrations.filter((item: Item) => item.status === "PENDING");
  const unresolved = data.registrations.filter((item: Item) => item.status !== "PENDING" && !item.workerId);
  return h(React.Fragment, null,
    h("div", { className: "section-heading" }, h("div", null, h("p", { className: "eyebrow" }, "執行裝置管理"), h("h1", null, "執行裝置")), h("div", null, h("p", null, `${allWorkers.length} 台已註冊 · ${allWorkers.filter((item) => item.connection?.state === "ONLINE").length} 台線上`), h("a", { className: "button-link", href: "/workers/new" }, "新增執行裝置"))),
    h("div", { className: "metric-grid" }, h(Card, { title: "Online", value: allWorkers.filter((item) => item.connection?.state === "ONLINE").length }), h(Card, { title: "Needs attention", value: allWorkers.filter((item) => ["STALE", "NO_HEARTBEAT"].includes(item.connection?.state)).length }), h(Card, { title: "Drained", value: allWorkers.filter((item) => ["DRAINING", "DRAINED"].includes(item.dispatch?.state)).length }), h(Card, { title: "Pending enrollment", value: pending.length })),
    h("div", { className: "worker-toolbar" }, h("input", { value: search, onChange: (event: React.ChangeEvent<HTMLInputElement>) => setSearch(event.target.value), placeholder: "搜尋名稱、主機或 Worker ID", "aria-label": "搜尋 Worker" }), h("select", { value: filter, onChange: (event: React.ChangeEvent<HTMLSelectElement>) => setFilter(event.target.value), "aria-label": "Worker 篩選" }, h("option", { value: "all" }, "全部"), h("option", { value: "online" }, "Online"), h("option", { value: "attention" }, "Needs attention"), h("option", { value: "drained" }, "Drained"))),
    pending.length ? h("section", { className: "card pending" }, h("h2", null, "待核准 Enrollment"), pending.map((item: Item) => h("article", { className: "registration", key: item.id }, h("strong", null, item.name), h(Status, { value: item.phase ?? item.status }), h("p", null, `${item.platform} · ${item.hostname ?? ""} · expires ${time(item.expiresAt)}`), h("div", { className: "actions" }, h("button", { type: "button", onClick: () => void run(`/api/v2/workers/registrations/${item.id}/approve`) }, "Approve"), h("button", { className: "danger", type: "button", onClick: () => window.confirm("刪除此 enrollment request？") && void run(`/api/v2/workers/registrations/${item.id}`, "DELETE") }, "Delete"))))) : null,
    unresolved.length ? h("section", { className: "card pending" }, h("h2", null, "未完成 / 已過期 Enrollment"), unresolved.map((item: Item) => h("article", { className: "registration", key: item.id }, h("strong", null, item.name), h(Status, { value: item.phase ?? item.status }), h("p", null, `${item.platform} · ${item.hostname ?? ""} · ${item.workerId ? `worker ${item.workerId}` : "尚未建立 Worker"}`), item.removable ? h("button", { className: "danger", type: "button", onClick: () => window.confirm("永久清除此 enrollment request？") && void run(`/api/v2/workers/registrations/${item.id}`, "DELETE") }, "Delete") : null))) : null,
    h("div", { className: "card-grid" }, workers.map((item: Item) => h("article", { className: "card", key: item.id },
      h("div", { className: "card-title-row" }, h("h2", null, h("a", { href: `/workers/${item.id}` }, item.name)), h(Status, { value: item.connection?.state ?? item.status })),
      h("p", null, `${item.platform} · ${item.hostname ?? "—"} · ${item.connection?.reason ?? (item.heartbeatAgeSeconds === null ? "尚無 heartbeat" : `heartbeat ${item.heartbeatAgeSeconds}s ago`)}`),
      h("p", null, `派工 ${item.dispatch?.state ?? item.drainState}${item.dispatch?.reason ? ` · ${item.dispatch.reason}` : ""}`),
      h("p", null, `活動 ${item.activity?.activeAttempts ?? item.runningTasks ?? 0}/${item.activity?.maxConcurrency ?? item.maxConcurrency ?? 1} · capability ${(item.capabilities ?? []).map((capability: Item) => capability.capability).join(", ") || "—"}`),
      h("p", null, `Models: ${(item.models ?? []).map((model: Item) => model.model).join(", ") || "—"}`),
      h("div", { className: "actions" }, item.enabled ? h("button", { type: "button", onClick: () => void run(`/api/v2/workers/${item.id}/disable`) }, "Disable") : h("button", { type: "button", onClick: () => void run(`/api/v2/workers/${item.id}/enable`) }, "Enable"), item.drain ? h("button", { type: "button", onClick: () => void run(`/api/v2/workers/${item.id}/resume`) }, "Resume") : h("button", { type: "button", onClick: () => void run(`/api/v2/workers/${item.id}/drain`) }, "Drain"), h("button", { type: "button", disabled: !item.availableActions?.wake, title: item.availableActions?.wakeReason ?? undefined }, "Wake"), h("button", { type: "button", onClick: () => { const name = window.prompt("Worker 顯示名稱", item.name); if (name) void run(`/api/v2/workers/${item.id}`, "PATCH", { name }); } }, "Rename"), h("button", { className: "danger", type: "button", disabled: item.availableActions?.remove === false, title: item.availableActions?.remove === false ? "仍有活動中的工作" : undefined, onClick: () => window.confirm("永久移除 Worker 並撤銷 credential？") && void run(`/api/v2/workers/${item.id}`, "DELETE") }, "Remove")),
    )))
  );
}

function WorkerDetail({ id, refreshVersion }: { id: string; refreshVersion: number }) {
  const [item, setItem] = useState<Item | null>(null); const [error, setError] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { request(`/api/v2/workers/${encodeURIComponent(id)}`).then(setItem).catch(setError); }, [id, refreshVersion]);
  if (error) return h(ErrorPanel, { error }); if (!item) return h(Loading);
  const run = async (path: string) => { setBusy(true); try { await request(path, { method: "POST" }); setItem(await request(`/api/v2/workers/${encodeURIComponent(id)}`)); } catch (reason) { setError(reason); } finally { setBusy(false); } };
  const savePreferences = async (mode: string) => { setBusy(true); try { const version = Number(item.preferences?.version ?? 0); await request(`/api/v2/workers/${encodeURIComponent(id)}/preferences`, { method: "PATCH", headers: { "if-match": `worker-preferences-${version}`, "idempotency-key": `ui-preferences-${id}-${Date.now()}` }, body: JSON.stringify({ mode }) }); setItem(await request(`/api/v2/workers/${encodeURIComponent(id)}`)); } catch (reason) { setError(reason); } finally { setBusy(false); } };
  const capabilityRows = (item.capabilities ?? []).map((capability: Item) => h("tr", { key: capability.id },
    h("td", null, capability.capability),
    h("td", null, capability.runtime ?? "—"),
    h("td", null, capability.grantStatus),
    h("td", null, h(Status, { value: capability.status })),
    h("td", null, h("code", null, capability.descriptorHash ?? "—")),
    h("td", null, capability.grantStatus === "REQUIRES_REVIEW" ? h("button", { type: "button", disabled: busy, onClick: () => void run(`/api/v2/workers/${id}/capabilities/${capability.id}/grant`) }, "Grant") : h("button", { type: "button", disabled: busy || capability.grantStatus === "REVOKED", onClick: () => void run(`/api/v2/workers/${id}/capabilities/${capability.id}/revoke`) }, "Revoke"))));
  const capabilityTable = (item.capabilities ?? []).length === 0 ? h("p", null, "尚未回報 capability") : h("div", { className: "table-wrap" }, h("table", null,
    h("thead", null, h("tr", null, ["Capability", "Runtime", "Grant", "Health", "Descriptor", "Action"].map((header) => h("th", { key: header }, header)))),
    h("tbody", null, capabilityRows)));
  return h(React.Fragment, null,
    h("div", { className: "section-heading" }, h("div", null, h("p", { className: "eyebrow" }, "WORKER DETAIL"), h("h1", null, item.name)), h(Status, { value: item.connection?.state ?? item.status })),
    h("p", null, `${item.platform} · ${item.hostname ?? "—"} · ${item.id}`),
    h("div", { className: "detail-grid" }, h("section", { className: "card" }, h("h2", null, "Connection"), h(Details, { item: item.connection })), h("section", { className: "card" }, h("h2", null, "Dispatch / Activity"), h(Details, { item: { ...item.dispatch, ...item.activity } })), h("section", { className: "card" }, h("h2", null, "Credential / Diagnostics"), h(Details, { item: { ...item.credential, ...item.diagnostics } }))),
    h("section", { className: "card" }, h("h2", null, "Capabilities"), capabilityTable),
    h("section", { className: "card" }, h("h2", null, "接案設定"), h(Details, { item: item.preferences }), h("div", { className: "actions" }, h("button", { type: "button", disabled: busy, onClick: () => void savePreferences("NORMAL") }, "正常接案"), h("button", { type: "button", disabled: busy, onClick: () => void savePreferences("IDLE_ONLY") }, "僅閒置時接案")), h("p", null, "暫停接案不會中止已接受的工作。")),
    h("section", { className: "card" }, h("h2", null, "專案與模型"), h(Details, { item: { workspaces: item.workspaces, models: item.models } })),
    h("section", { className: "card" }, h("h2", null, "Providers"), h(Details, { item: { providers: item.providers } })),
    h("div", { className: "actions" }, item.drain ? h("button", { type: "button", disabled: busy, onClick: () => void run(`/api/v2/workers/${id}/resume`) }, "Resume") : h("button", { type: "button", disabled: busy, onClick: () => void run(`/api/v2/workers/${id}/drain`) }, "Drain")),
    h("p", null, h("a", { href: "/workers" }, "← 回到 Workers")));
}

function WorkerOnboarding() {
  const [platformChoice, setPlatformChoice] = useState("darwin"); const [capabilities, setCapabilities] = useState<string[]>(["llm.inference"]); const [item, setItem] = useState<Item | null>(null); const [error, setError] = useState<unknown>(null);
  const create = async (event: React.FormEvent) => { event.preventDefault(); try { const result = await request("/api/v2/worker-onboarding", { method: "POST", body: JSON.stringify({ platform: platformChoice, selected_capabilities: capabilities }) }); setItem(result); } catch (reason) { setError(reason); } };
  if (error) return h(React.Fragment, null, h(ErrorPanel, { error }), h("button", { type: "button", onClick: () => setError(null) }, "重新開始"));
  if (item) return h(React.Fragment, null, h("p", { className: "eyebrow" }, "新增執行裝置"), h("h1", null, "安裝導引"), h("section", { className: "card" }, h("h2", null, `導引 ID：${item.id}`), h("p", null, `目前步驟：${item.inferredStep}`), h("p", null, "請在本機完成安裝；完成依據以 Worker 回報為準。"), h("a", { className: "button-link", href: `/api/v2/worker-installer?platform=${platformChoice}&onboarding_id=${item.id}`, target: "_blank", rel: "noreferrer" }, "取得安裝資訊"), h("p", null, h("a", { href: `/api/v2/worker-onboarding/${item.id}` }, "重新整理導引狀態（API）"))), h("p", null, h("a", { href: "/workers" }, "← 回到執行裝置")));
  return h(React.Fragment, null, h("p", { className: "eyebrow" }, "新增執行裝置"), h("h1", null, "Worker 安裝導引"), h("p", null, "只選擇這台裝置需要的能力；未選擇的 executor 不會被要求設定。"), h("form", { className: "editor", onSubmit: create }, h("label", null, "平台", h("select", { value: platformChoice, onChange: (event: React.ChangeEvent<HTMLSelectElement>) => setPlatformChoice(event.target.value) }, h("option", { value: "darwin" }, "macOS"), h("option", { value: "win32" }, "Windows"), h("option", { value: "linux" }, "Linux"))), h("label", null, "能力", h("span", null, h("input", { type: "checkbox", checked: capabilities.includes("llm.inference"), onChange: (event: React.ChangeEvent<HTMLInputElement>) => setCapabilities(event.target.checked ? ["llm.inference"] : []) }), " 本機模型推論"), h("span", null, h("input", { type: "checkbox", checked: capabilities.includes("codex"), onChange: (event: React.ChangeEvent<HTMLInputElement>) => setCapabilities((current) => event.target.checked ? [...new Set([...current, "codex"])] : current.filter((value) => value !== "codex")) }), " Codex 專案工作")), h("button", { type: "submit" }, "建立安裝導引")));
}

function Models({ refreshVersion }: { refreshVersion: number }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<unknown>(null); const [search, setSearch] = useState(""); const [selected, setSelected] = useState<string[]>([]); const [message, setMessage] = useState(""); const [testInput, setTestInput] = useState(""); const [preferences, setPreferences] = useState<Item[]>([]);
  const load = () => { const params = new URLSearchParams(); if (search) params.set("search", search); params.set("dispatchable", "false"); Promise.all([request(`/api/v2/models?${params}`), request("/api/v2/model-preferences")]).then(([models, prefs]) => { setItems(models.items ?? []); setPreferences(prefs.items ?? []); setError(null); }).catch(setError); };
  useEffect(() => { void load(); }, [refreshVersion, search]);
  if (!items) return error ? h(React.Fragment, null, h(ErrorPanel, { error }), h("button", { type: "button", onClick: load }, "重新載入")) : h(Loading);
  const toggle = (key: string) => setSelected((current) => current.includes(key) ? current.filter((value) => value !== key) : current.length >= 8 ? current : [...current, key]);
  const runTest = async () => { const input = testInput.trim() || window.prompt("輸入同一段測試文字")?.trim(); if (!input || selected.length === 0) return; try { const targets = selected.map((key) => items.find((item) => item.instanceKey === key)).filter((item): item is Item => Boolean(item)).map((item) => ({ worker_id: item.workerId, runtime: item.runtime, model_id: item.model })); const created = await request("/api/v2/model-tests", { method: "POST", headers: { "idempotency-key": `ui-model-test-${Date.now()}` }, body: JSON.stringify({ template_id: "short-summary-v1", template_version: 1, input_text: input, targets }) }); setMessage(`試跑已建立：${created.id}`); setTestInput(""); } catch (reason) { setMessage(reason instanceof Error ? reason.message : "試跑建立失敗"); } };
  return h(React.Fragment, null, h("p", { className: "eyebrow" }, "模型清單"), h("h1", null, "模型"), h("div", { className: "worker-toolbar" }, h("label", null, "搜尋模型", h("input", { value: search, onChange: (event: React.ChangeEvent<HTMLInputElement>) => setSearch(event.target.value), placeholder: "Worker、runtime 或模型名稱" })), h("label", null, "比較輸入", h("input", { value: testInput, onChange: (event: React.ChangeEvent<HTMLInputElement>) => setTestInput(event.target.value), placeholder: "最多選 8 個實例" })), h("button", { type: "button", onClick: () => void runTest(), disabled: selected.length === 0 }, `開始試跑 (${selected.length}/8)`)), message ? h("p", { className: "notice", role: "status" }, message) : null,
    items.length === 0 ? h("p", { className: "notice" }, "尚未發現模型，或目前篩選沒有結果。") : h("div", { className: "table-wrap" }, h("table", null, h("thead", null, h("tr", null, ["比較", "Worker", "Runtime", "模型實例", "服務", "載入", "可接案", "最後確認"].map((header) => h("th", { key: header }, header)))), h("tbody", null, items.map((item) => { const loaded = item.loaded === true ? "LOADED" : item.loaded === false ? "AVAILABLE" : "UNKNOWN"; return h("tr", { key: item.instanceKey }, h("td", null, h("input", { type: "checkbox", checked: selected.includes(item.instanceKey), onChange: () => toggle(item.instanceKey), disabled: !item.present || selected.length >= 8 && !selected.includes(item.instanceKey), "aria-label": `選取 ${item.model}` })), h("td", null, item.worker), h("td", null, item.runtime), h("td", null, h("code", null, item.displayName ?? item.model), h("small", null, item.instanceKey)), h("td", null, h(Status, { value: item.status })), h("td", null, h(Status, { value: loaded })), h("td", null, h(Status, { value: item.dispatchable ? "READY" : "UNAVAILABLE" })), h("td", null, time(item.lastSeenAt))); })))),
    h("section", { className: "card" }, h("h2", null, "用途偏好"), preferences.length ? preferences.map((preference) => h("p", { key: preference.id }, h("strong", null, preference.name), ` · ${preference.targets?.length ?? 0} 個 target · fallback ${preference.allowFallback ? "開啟" : "關閉"}`)) : h("p", null, "尚未保存模型用途偏好。")));
}

function Systems({ refreshVersion }: { refreshVersion: number }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<unknown>(null); useEffect(() => { request("/api/v2/systems").then((value) => { setItems(value.items ?? []); setError(null); }).catch(setError); }, [refreshVersion]);
  if (!items) return error ? h(React.Fragment, null, h(ErrorPanel, { error }), h("button", { type: "button", onClick: () => setError(null) }, "重新載入")) : h(Loading);
  return h(React.Fragment, null, h("p", { className: "eyebrow" }, "系統健康"), h("h1", null, "系統"), h("div", { className: "card-grid" }, items.map((item) => h("article", { className: "card", key: item.id }, h("div", { className: "card-title-row" }, h("h2", null, item.name), h(Status, { value: item.status })), h("p", null, `${display(item.type)} · ${display(item.baseUrl)}${display(item.healthPath)}`), h("p", null, `最後確認 ${time(item.checkedAt)} · ${display(item.latencyMs)} ms`), item.entryUrl ? h("a", { className: "button-link secondary", href: item.entryUrl, target: "_blank", rel: "noreferrer" }, `開啟 ${item.name}`) : h("p", { className: "notice" }, "尚未設定可由瀏覽器開啟的入口。")))));
}

function Settings({ refreshVersion }: { refreshVersion: number }) {
  const [values, setValues] = useState<Item | null>(null);
  const [fields, setFields] = useState<Item[]>([]); const [draft, setDraft] = useState<Item | null>(null); const [etag, setEtag] = useState(""); const [message, setMessage] = useState(""); const [dirty, setDirty] = useState(false);
  const load = () => fetch("/api/v2/settings/effective", { headers: { accept: "application/json" } }).then(async (response) => { const value = await response.json() as Item; if (!response.ok) throw new Error(value.error?.message ?? "讀取設定失敗"); setValues(value.values); setDraft(value.values); setFields(value.fields ?? []); setEtag(response.headers.get("etag") ?? ""); setDirty(false); }).catch(setMessage);
  useEffect(() => { if (!dirty) void load(); }, [refreshVersion, dirty]);
  if (!values || !draft) return message ? h(React.Fragment, null, h(ErrorPanel, { error: message }), h("button", { type: "button", onClick: () => { setMessage(""); void load(); } }, "重新載入")) : h(Loading);
  const save = async (event: React.FormEvent) => { event.preventDefault(); const changed = Object.fromEntries(Object.entries(draft).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(values[key]))); if (!Object.keys(changed).length) { setMessage("沒有變更。"); setDirty(false); return; } try { const response = await fetch("/api/v2/settings", { method: "PATCH", headers: { accept: "application/json", "content-type": "application/json", ...(etag ? { "if-match": etag } : {}) }, body: JSON.stringify(changed) }); const result = await response.json() as Item; if (!response.ok) throw new Error(result.error?.message ?? `HTTP ${response.status}`); setValues(result.values ?? result); setDraft(result.values ?? result); setEtag(response.headers.get("etag") ?? etag); setDirty(false); setMessage("設定已保存；Worker 套用狀態請查看執行裝置。"); } catch (error) { setMessage(error instanceof Error ? error.message : "保存失敗；草稿已保留。 "); } };
  return h(React.Fragment, null, h("p", { className: "eyebrow" }, "執行環境設定"), h("h1", null, "設定"), h("p", null, "只送出有變更的欄位；環境變數鎖定的欄位不能在此修改。"), dirty ? h("p", { className: "notice", role: "status" }, "目前有未保存草稿；背景同步已暫停。") : null, h("form", { className: "editor", onSubmit: save }, fields.map((field) => { const value = draft[field.key]; const locked = field.editable === false; return h("label", { key: field.key }, `${field.label}${field.unit ? `（${field.unit}）` : ""}`, h("small", null, `${field.description} · 來源：${field.source} · 套用：${field.applyScope}`), h("input", { type: field.type === "boolean" ? "checkbox" : field.type === "integer" ? "number" : "text", disabled: locked, checked: field.type === "boolean" ? Boolean(value) : undefined, value: field.type !== "boolean" ? value ?? "" : undefined, min: field.min ?? undefined, max: field.max ?? undefined, onChange: (event: React.ChangeEvent<HTMLInputElement>) => { setDirty(true); setDraft({ ...draft, [field.key]: field.type === "boolean" ? event.target.checked : field.type === "integer" ? Number(event.target.value) : event.target.value }); } })); }), h("button", { type: "submit" }, "保存設定"), message ? h("p", { className: "notice", role: "status" }, message) : null));
}

function currentPath(): string { return typeof window === "undefined" ? "/" : window.location.pathname; }

export function App({ initialPath = currentPath() }: { initialPath?: string }) {
  const [path, setPath] = useState(initialPath);
  const [refreshVersion, refresh] = useRefresh();
  useEffect(() => {
    const onPopState = () => setPath(currentPath());
    const onClick = (event: MouseEvent) => {
      const target = (event.target as HTMLElement).closest("a");
      if (target?.origin === window.location.origin && target.getAttribute("target") !== "_blank") {
        event.preventDefault();
        window.history.pushState({}, "", target.href);
        setPath(currentPath());
      }
    };
    window.addEventListener("popstate", onPopState);
    document.addEventListener("click", onClick);
    return () => { window.removeEventListener("popstate", onPopState); document.removeEventListener("click", onClick); };
  }, []);
  const content = useMemo(() => {
    const parts = path.split("/").filter(Boolean);
    if (parts[0] === "tasks" && parts[1]) return h(TaskDetail, { id: parts[1], refreshVersion });
    if (parts[0] === "tasks") return h(Tasks, { refreshVersion });
    if (parts[0] === "workers" && parts[1] === "new") return h(WorkerOnboarding);
    if (parts[0] === "workers" && parts[1]) return h(WorkerDetail, { id: parts[1], refreshVersion });
    if (parts[0] === "workers") return h(Workers, { refreshVersion });
    if (parts[0] === "models") return h(Models, { refreshVersion });
    if (parts[0] === "systems") return h(Systems, { refreshVersion });
    if (parts[0] === "settings") return h(Settings, { refreshVersion });
    return h(Home, { refreshVersion });
  }, [path, refreshVersion]);
  return h(Layout, { path, refresh, children: content });
}
