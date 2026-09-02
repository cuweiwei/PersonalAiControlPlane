import React, { useCallback, useEffect, useMemo, useState } from "react";

type Item = Record<string, any>;
const h = React.createElement;
const nav = [
  ["/", "Dashboard"],
  ["/tasks", "Tasks"],
  ["/workers", "Workers"],
  ["/models", "Models"],
  ["/systems", "Systems"],
  ["/settings", "Settings"],
] as const;

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
  return h("span", { className: `status-pill ${statusClass(value)}` }, display(value));
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
    Promise.all([request("/api/v2/tasks"), request("/api/v2/workers"), request("/api/v2/models"), request("/api/v2/systems")])
      .then(([tasks, workers, models, systems]) => alive && setData({ tasks: tasks.items ?? [], workers: workers.items ?? [], models: models.items ?? [], systems: systems.items ?? [] }))
      .catch((reason) => alive && setError(reason));
    return () => { alive = false; };
  }, [refreshVersion]);
  if (!data) return error ? h(ErrorPanel, { error }) : h(Loading);
  const count = (items: Item[], status: string) => items.filter((item) => item.status === status).length;
  return h(React.Fragment, null,
    h("section", { className: "portal-hero" },
      h("div", null,
        h("p", { className: "eyebrow" }, "EXECUTION CONTROL / v2"),
        h("h1", null, "Hermes 的工作，Worker 的算力"),
        h("p", null, "PersonalAiControlPlane 只管理 Task、Worker、資源與結果回傳，不代替 Hermes 思考或規劃。")),
      h("div", { className: "hero-actions" }, h("a", { className: "button-link", href: "/tasks" }, "查看 Tasks"), h("a", { className: "button-link secondary", href: "/workers" }, "管理 Workers"))),
    h("section", { className: "metric-grid" },
      h(Card, { title: "Hermes", value: data.systems.find((item: Item) => item.id === "hermes")?.status ?? "UNKNOWN" }),
      h(Card, { title: "ContextHub", value: data.systems.find((item: Item) => item.id === "contexthub")?.status ?? "UNKNOWN" }),
      h(Card, { title: "Online Workers", value: data.workers.filter((item: Item) => (item.connection?.state ?? item.status) === "ONLINE").length }),
      h(Card, { title: "Available Models", value: data.models.length })),
    h("section", { className: "card-grid" },
      h(Card, { title: "Queued Tasks", value: count(data.tasks, "QUEUED") }),
      h(Card, { title: "Running Tasks", value: count(data.tasks, "RUNNING") }),
      h(Card, { title: "Succeeded Tasks", value: count(data.tasks, "SUCCEEDED") }),
      h(Card, { title: "Failed Tasks", value: count(data.tasks, "FAILED") })),
    h("section", { className: "section-heading" }, h("div", null, h("p", { className: "eyebrow" }, "RECENT ACTIVITY"), h("h2", null, "最近 Tasks")), h("a", { className: "button-link secondary", href: "/tasks" }, "全部 Tasks")),
    h("div", { className: "card-grid" }, data.tasks.slice(0, 6).map((task: Item) =>
      h("article", { className: "card", key: task.id },
        h("div", { className: "card-title-row" }, h("a", { href: `/tasks/${task.id}` }, task.title), h(Status, { value: task.status })),
        h("p", null, `${display(task.taskType)} · ${time(task.createdAt)}`)))),
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
    try { await request(`/api/v2/tasks/${encodeURIComponent(id)}/${suffix}`, { method: "POST" }); setItem(await request(`/api/v2/tasks/${encodeURIComponent(id)}`)); }
    catch (reason) { setError(reason); }
    finally { setBusy(false); }
  };
  return h(React.Fragment, null,
    h("div", { className: "section-heading" }, h("div", null, h("p", { className: "eyebrow" }, "TASK DETAIL"), h("h1", null, item.title)), h(Status, { value: item.status })),
    h("div", { className: "actions" }, ["QUEUED", "ASSIGNED", "RUNNING"].includes(item.status) ? h("button", { type: "button", disabled: busy, onClick: () => void action("cancel") }, "Cancel") : null, item.status === "FAILED" ? h("button", { type: "button", disabled: busy, onClick: () => void action("retry") }, "Retry") : null),
    h("section", { className: "detail-card card" }, h(Details, { item: { taskType: item.taskType, source: item.source, correlationId: item.correlationId, worker: item.execution?.workerId ?? "auto", model: item.execution?.model, priority: item.priority, attemptCount: item.attemptCount, createdAt: time(item.createdAt), instruction: item.instruction, context: item.context, result: item.result, failure: item.failure } })),
    h("section", { className: "card" }, h("h2", null, "Timeline"), h("div", { className: "timeline" }, (item.events ?? []).map((event: Item) => h("article", { key: event.eventId }, h(Status, { value: event.type }), h("span", null, time(event.createdAt)), h("p", null, display(event.payload)))))),
  );
}

function Tasks({ refreshVersion }: { refreshVersion: number }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [filter, setFilter] = useState("");
  useEffect(() => { request(`/api/v2/tasks${filter ? `?status=${filter}` : ""}`).then((value) => setItems(value.items ?? [])).catch(setError); }, [filter, refreshVersion]);
  if (!items) return error ? h(ErrorPanel, { error }) : h(Loading);
  return h(React.Fragment, null,
    h("div", { className: "section-heading" }, h("div", null, h("p", { className: "eyebrow" }, "TASK MANAGER"), h("h1", null, "Tasks")), h("select", { value: filter, onChange: (event: React.ChangeEvent<HTMLSelectElement>) => setFilter(event.target.value) }, h("option", { value: "" }, "全部狀態"), ["QUEUED", "ASSIGNED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"].map((value) => h("option", { key: value, value }, value)))),
    h("div", { className: "table-wrap" }, h("table", null,
      h("thead", null, h("tr", null, ["Task", "Status", "Type", "Worker / Model", "Priority", "Created"].map((header) => h("th", { key: header }, header)))),
      h("tbody", null, items.map((item) => h("tr", { key: item.id }, h("td", null, h("a", { href: `/tasks/${item.id}` }, item.title), h("small", null, item.id)), h("td", null, h(Status, { value: item.status })), h("td", null, item.taskType), h("td", null, `${display(item.execution?.workerId ?? "auto")} / ${display(item.execution?.model?.name ?? "any")}`), h("td", null, item.priority), h("td", null, time(item.createdAt))))))),
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
    h("div", { className: "section-heading" }, h("div", null, h("p", { className: "eyebrow" }, "WORKER REGISTRY"), h("h1", null, "Workers")), h("p", null, `${allWorkers.length} 台已註冊 · ${allWorkers.filter((item) => item.connection?.state === "ONLINE").length} online`)),
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
    h("section", { className: "card" }, h("h2", null, "Providers"), h(Details, { item: { providers: item.providers } })),
    h("div", { className: "actions" }, item.drain ? h("button", { type: "button", disabled: busy, onClick: () => void run(`/api/v2/workers/${id}/resume`) }, "Resume") : h("button", { type: "button", disabled: busy, onClick: () => void run(`/api/v2/workers/${id}/drain`) }, "Drain")),
    h("p", null, h("a", { href: "/workers" }, "← 回到 Workers")));
}

function Models({ refreshVersion }: { refreshVersion: number }) {
  const [items, setItems] = useState<Item[] | null>(null);
  useEffect(() => { request("/api/v2/models").then((value) => setItems(value.items ?? [])); }, [refreshVersion]);
  if (!items) return h(Loading);
  return h(React.Fragment, null, h("p", { className: "eyebrow" }, "MODEL INVENTORY"), h("h1", null, "Models"), h("div", { className: "table-wrap" }, h("table", null, h("thead", null, h("tr", null, ["Worker", "Runtime", "Model", "Status", "Context", "Load"].map((header) => h("th", { key: header }, header)))), h("tbody", null, items.map((item) => h("tr", { key: `${item.workerId}-${item.runtime}-${item.model}` }, h("td", null, item.worker), h("td", null, item.runtime), h("td", null, item.displayName ?? item.model), h("td", null, h(Status, { value: item.status })), h("td", null, item.contextLength ?? "—"), h("td", null, item.workerStatus)))))));
}

function Systems({ refreshVersion }: { refreshVersion: number }) {
  const [items, setItems] = useState<Item[] | null>(null);
  useEffect(() => { request("/api/v2/systems").then((value) => setItems(value.items ?? [])); }, [refreshVersion]);
  if (!items) return h(Loading);
  return h(React.Fragment, null, h("p", { className: "eyebrow" }, "SYSTEM HEALTH"), h("h1", null, "Systems"), h("div", { className: "card-grid" }, items.map((item) => h("article", { className: "card", key: item.id }, h("div", { className: "card-title-row" }, h("h2", null, item.name), h(Status, { value: item.status })), h("p", null, `${display(item.type)} · ${display(item.baseUrl)}${display(item.healthPath)}`), h("p", null, `last check ${time(item.checkedAt)} · ${display(item.latencyMs)} ms`)))));
}

function Settings({ refreshVersion }: { refreshVersion: number }) {
  const [values, setValues] = useState<Item | null>(null);
  const [message, setMessage] = useState("");
  useEffect(() => { request("/api/v2/settings").then(setValues); }, [refreshVersion]);
  if (!values) return h(Loading);
  const save = async (event: React.FormEvent) => { event.preventDefault(); try { await request("/api/v2/settings", { method: "PATCH", body: JSON.stringify(values) }); setMessage("設定已儲存"); } catch (error) { setMessage(error instanceof Error ? error.message : "儲存失敗"); } };
  return h(React.Fragment, null, h("p", { className: "eyebrow" }, "RUNTIME CONFIGURATION"), h("h1", null, "Settings"), h("form", { className: "editor", onSubmit: save }, Object.entries(values).map(([key, value]) => h("label", { key }, key, h("input", { type: typeof value === "boolean" ? "checkbox" : "number", checked: typeof value === "boolean" ? value : undefined, value: typeof value === "number" ? value : undefined, onChange: (event: React.ChangeEvent<HTMLInputElement>) => setValues({ ...values, [key]: typeof value === "boolean" ? event.target.checked : Number(event.target.value) }) }))), h("button", { type: "submit" }, "儲存"), message ? h("p", { className: "notice ready" }, message) : null));
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
    if (parts[0] === "workers" && parts[1]) return h(WorkerDetail, { id: parts[1], refreshVersion });
    if (parts[0] === "workers") return h(Workers, { refreshVersion });
    if (parts[0] === "models") return h(Models, { refreshVersion });
    if (parts[0] === "systems") return h(Systems, { refreshVersion });
    if (parts[0] === "settings") return h(Settings, { refreshVersion });
    return h(Home, { refreshVersion });
  }, [path, refreshVersion]);
  return h(Layout, { path, refresh, children: content });
}
