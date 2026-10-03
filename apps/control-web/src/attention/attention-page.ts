import React, { useEffect, useRef, useState } from "react";

type Item = Record<string, any>;
type RelatedWork = { href: string; label: string };
type PendingCommand = { key: string; body: Item; label: string };

const h = React.createElement;
const stateLabels: Record<string, string> = { OPEN: "待處理", SNOOZED: "已暫緩", RESOLVED: "已完成", SUPERSEDED: "已被新事件取代" };
const severityLabels: Record<string, string> = { LOW: "低", NORMAL: "一般", HIGH: "高", CRITICAL: "緊急" };
const reasonLabels: Record<string, string> = { MILESTONE_WAITING: "里程碑等待中" };

export function attentionListPath(state: string, severity: string): string {
  const params = new URLSearchParams({ limit: "100" });
  if (state) params.set("state", state);
  if (severity) params.set("severity", severity);
  return `/api/v2/attention?${params.toString()}`;
}

export function relatedWorkForAttention(subjectKind: unknown, subjectId: unknown): RelatedWork | null {
  if (typeof subjectKind !== "string" || typeof subjectId !== "string" || !subjectId) return null;
  const id = encodeURIComponent(subjectId);
  switch (subjectKind) {
    case "TASK": return { href: `/tasks/${id}`, label: "查看任務" };
    case "MISSION": return { href: `/missions/${id}`, label: "查看 Mission" };
    case "GOAL": return { href: "/goals", label: "查看目標列表" };
    case "SKILL": return { href: "/skills", label: "查看技能列表" };
    case "ROUTINE_BINDING": return { href: "/routines", label: "查看例行工作列表" };
    default: return null;
  }
}

export function formatAttentionTime(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function classifyAttentionCommandResponse(status: number, body: Item): "APPLIED" | "REJECTED" | "UNKNOWN" {
  if (status === 409 || body?.state === "REJECTED" || (status >= 400 && status < 500)) return "REJECTED";
  if (status >= 200 && status < 300 && body?.state === "APPLIED") return "APPLIED";
  return "UNKNOWN";
}

export function attentionCommandBody(kind: "READ" | "SNOOZE" | "UNSNOOZE", revision: number, snoozeUntil?: number): Item {
  return kind === "SNOOZE"
    ? { kind, expected_revision: revision, payload: { snooze_until: snoozeUntil } }
    : { kind, expected_revision: revision };
}

function attentionTitle(reasonCode: unknown): string {
  if (typeof reasonCode !== "string" || !reasonCode) return "需要查看";
  return reasonLabels[reasonCode] ?? "需要查看";
}

function describeError(value: unknown): string {
  return value instanceof Error ? value.message : "讀取失敗";
}

function freshIdempotencyKey(): string {
  return `ui-attention-${globalThis.crypto.randomUUID()}`;
}

function useVisibleRefresh(setRefresh: React.Dispatch<React.SetStateAction<number>>): void {
  useEffect(() => {
    let timer: number | undefined;
    const stop = () => {
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
    };
    const start = () => {
      stop();
      if (document.visibilityState === "visible") timer = window.setInterval(() => setRefresh((value) => value + 1), 30_000);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") stop();
      else {
        setRefresh((value) => value + 1);
        start();
      }
    };
    start();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [setRefresh]);
}

export function AttentionPage({ attentionId, refreshVersion }: { attentionId?: string; refreshVersion: number }) {
  const [refresh, setRefresh] = useState(0);
  useVisibleRefresh(setRefresh);
  return attentionId
    ? h(AttentionDetail, { id: attentionId, refreshVersion, refresh, setRefresh, key: attentionId })
    : h(AttentionList, { refreshVersion, refresh, setRefresh });
}

function AttentionList({ refreshVersion, refresh, setRefresh }: { refreshVersion: number; refresh: number; setRefresh: React.Dispatch<React.SetStateAction<number>> }) {
  const [state, setState] = useState("OPEN");
  const [severity, setSeverity] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [data, setData] = useState<{ path: string; items: Item[]; observedAt: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const path = attentionListPath(state, severity);

  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    fetch(path, { headers: { accept: "application/json" }, signal: controller.signal })
      .then(async (response) => {
        const value = await response.json() as Item;
        if (!response.ok) throw new Error(value.error?.message ?? value.error?.code ?? `HTTP ${response.status}`);
        if (alive) {
          setData({ path, items: value.items ?? [], observedAt: value.observedAt ?? "" });
          setError(null);
        }
      })
      .catch((reason) => { if (alive && !(reason instanceof DOMException && reason.name === "AbortError")) setError(reason); });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [path, refreshVersion, refresh]);

  const loaded = data?.path === path ? data : null;
  const query = search.trim().toLocaleLowerCase();
  const visibleItems = (loaded?.items ?? []).filter((item) => {
    if (unreadOnly && item.isUnread !== true) return false;
    if (!query) return true;
    return `${item.reasonCode ?? ""} ${item.subjectId ?? ""}`.toLocaleLowerCase().includes(query);
  });
  const retry = () => {
    setError(null);
    setRefresh((value) => value + 1);
  };

  return h(React.Fragment, null,
    h("div", { className: "section-heading" }, h("div", null,
      h("p", { className: "eyebrow" }, "PERSONAL AGENT WORK"),
      h("h1", null, "待處理中心"),
      h("p", null, "查看已持久化的原因與證據，再回到相關工作處理。已讀只記錄閱讀進度，暫緩只改變列表顯示。")),
      h("button", { type: "button", className: "secondary", onClick: retry }, "重新整理")),
    h("div", { className: "attention-toolbar", role: "search" },
      h("label", null, "狀態", h("select", { value: state, onChange: (event: React.ChangeEvent<HTMLSelectElement>) => setState(event.target.value), "aria-label": "Attention 狀態" },
        h("option", { value: "OPEN" }, "待處理"), h("option", { value: "SNOOZED" }, "已暫緩"), h("option", { value: "RESOLVED" }, "已完成"), h("option", { value: "SUPERSEDED" }, "已被取代"))),
      h("label", null, "嚴重度", h("select", { value: severity, onChange: (event: React.ChangeEvent<HTMLSelectElement>) => setSeverity(event.target.value), "aria-label": "Attention 嚴重度" },
        h("option", { value: "" }, "全部"), h("option", { value: "CRITICAL" }, "緊急"), h("option", { value: "HIGH" }, "高"), h("option", { value: "NORMAL" }, "一般"), h("option", { value: "LOW" }, "低"))),
      h("label", { className: "attention-search" }, "搜尋已載入結果", h("input", { type: "search", value: search, onChange: (event: React.ChangeEvent<HTMLInputElement>) => setSearch(event.target.value), placeholder: "原因代碼或 subject ID", "aria-label": "搜尋已載入的 Attention" })),
      h("label", { className: "attention-checkbox" }, h("input", { type: "checkbox", checked: unreadOnly, onChange: (event: React.ChangeEvent<HTMLInputElement>) => setUnreadOnly(event.target.checked) }), "只看未讀")),
    h("p", { className: "attention-count", role: "status" }, loaded ? `目前顯示 ${visibleItems.length} 筆（最多 100）；未讀 ${visibleItems.filter((item) => item.isUnread === true).length} 筆。${loaded.observedAt ? ` 觀察時間：${formatAttentionTime(loaded.observedAt)}` : ""}` : "最多載入 100 筆。搜尋範圍只包含目前載入的結果。"),
    error ? h("div", { className: "notice error", role: "alert" }, h("span", null, describeError(error)), h("button", { type: "button", className: "secondary", onClick: retry }, "重試")) : null,
    !loaded ? error ? null : h("p", { className: "notice loading", role: "status" }, "讀取待處理事項…") : visibleItems.length === 0
      ? h("p", { className: "notice" }, loaded.items.length === 0 ? "目前沒有符合條件的已持久化事項。" : "目前沒有符合搜尋或未讀篩選的項目。")
      : h("div", { className: "attention-list" }, visibleItems.map((item) => {
        const effectiveState = String(item.effectiveState ?? item.state ?? "UNKNOWN");
        const severityLabel = severityLabels[String(item.severity)] ?? String(item.severity ?? "未知");
        return h("article", { className: "card attention-item", key: item.id },
          h("div", { className: "attention-item-heading" },
            h("div", null, h("h2", null, h("a", { href: `/attention/${encodeURIComponent(String(item.id))}` }, attentionTitle(item.reasonCode))), h("code", null, String(item.reasonCode ?? "UNKNOWN"))),
            h("span", { className: `attention-severity severity-${String(item.severity ?? "normal").toLowerCase()}` }, severityLabel)),
          h("p", { className: "attention-subject" }, `${item.subjectKind ?? "未知來源"} · ${item.subjectId ?? "—"}`),
          h("div", { className: "attention-item-meta" },
            h("span", null, `狀態：${stateLabels[effectiveState] ?? effectiveState}`),
            h("span", null, item.isUnread ? "未讀" : "已讀"),
            h("span", null, `更新：${formatAttentionTime(item.updatedAt)}`),
            effectiveState === "SNOOZED" ? h("span", null, `暫緩至：${formatAttentionTime(item.snoozeUntil)}`) : null),
          h("a", { className: "button-link secondary", href: `/attention/${encodeURIComponent(String(item.id))}` }, "查看原因與證據"));
      })));
}

function AttentionDetail({ id, refreshVersion, refresh, setRefresh }: { id: string; refreshVersion: number; refresh: number; setRefresh: React.Dispatch<React.SetStateAction<number>> }) {
  const [data, setData] = useState<{ path: string; item: Item; capability: Item; observedAt: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState<PendingCommand | null>(null);
  const pendingRef = useRef<PendingCommand | null>(null);
  const [busy, setBusy] = useState(false);
  const mountedRef = useRef(true);
  const commandGenerationRef = useRef(0);
  const commandAbortRef = useRef<AbortController | null>(null);
  const path = `/api/v2/attention/${encodeURIComponent(id)}`;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      commandGenerationRef.current += 1;
      commandAbortRef.current?.abort();
      commandAbortRef.current = null;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    Promise.all([
      fetch(path, { headers: { accept: "application/json" }, signal: controller.signal }).then(async (response) => {
        const value = await response.json() as Item;
        if (!response.ok) throw new Error(value.error?.message ?? value.error?.code ?? `HTTP ${response.status}`);
        return value;
      }),
      fetch("/api/v2/agent-work/capabilities", { headers: { accept: "application/json" }, signal: controller.signal }).then(async (response) => {
        const value = await response.json() as Item;
        if (!response.ok) throw new Error(value.error?.message ?? value.error?.code ?? `HTTP ${response.status}`);
        return value;
      }),
    ]).then(([item, capabilities]) => {
      if (alive) {
        setData({ path, item, capability: capabilities.attention ?? {}, observedAt: item.observedAt ?? "" });
        setError(null);
      }
    }).catch((reason) => { if (alive && !(reason instanceof DOMException && reason.name === "AbortError")) setError(reason); });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [path, refreshVersion, refresh]);

  const loaded = data?.path === path ? data : null;
  const item: Item = loaded?.item ?? {};
  const capabilityAvailable = loaded?.capability?.available === true;

  const sendPending = async (operation: PendingCommand) => {
    const generation = ++commandGenerationRef.current;
    const controller = new AbortController();
    commandAbortRef.current = controller;
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 15_000);
    const isCurrent = () => mountedRef.current && generation === commandGenerationRef.current;
    setBusy(true);
    setMessage("操作送出中…");
    try {
      const response = await fetch(`${path}/commands`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", "idempotency-key": operation.key },
        body: JSON.stringify(operation.body),
        signal: controller.signal,
      });
      if (!isCurrent()) return;
      let result: Item;
      try { result = await response.json() as Item; }
      catch { throw new Error("伺服器回應無法確認；請重試同一操作。 "); }
      if (!isCurrent()) return;
      const outcome = classifyAttentionCommandResponse(response.status, result);
      if (outcome === "APPLIED") {
        pendingRef.current = null;
        setPending(null);
        setMessage(`${operation.label}已確認套用。`);
        setRefresh((value) => value + 1);
      } else if (outcome === "REJECTED") {
        pendingRef.current = null;
        setPending(null);
        const reason = result.error?.message ?? result.error?.code ?? result.error ?? (response.status === 409 ? "資料已變更或狀態不允許此操作" : `HTTP ${response.status}`);
        setMessage(`操作未套用：${String(reason)}。已重新讀取最新資料，請確認後再操作。`);
        setRefresh((value) => value + 1);
      } else {
        setMessage("伺服器結果尚未確認；此項目已鎖住，請以相同操作重試。");
      }
    } catch (reason) {
      if (!isCurrent()) return;
      setMessage(timedOut
        ? "15 秒內沒有收到確認；操作結果尚未確認，此項目已鎖住，請以相同操作重試。"
        : `${describeError(reason)}；此項目已鎖住，請以相同操作重試。`);
    } finally {
      window.clearTimeout(timeout);
      if (commandAbortRef.current === controller) commandAbortRef.current = null;
      if (isCurrent()) setBusy(false);
    }
  };

  const begin = (kind: "READ" | "SNOOZE" | "UNSNOOZE", snoozeUntil?: number) => {
    if (!loaded || !capabilityAvailable || pendingRef.current) return;
    const body = attentionCommandBody(kind, loaded.item.revision, snoozeUntil);
    const operation = { key: freshIdempotencyKey(), body, label: kind === "READ" ? "已讀" : kind === "SNOOZE" ? "暫緩" : "恢復顯示" };
    pendingRef.current = operation;
    setPending(operation);
    setError(null);
    void sendPending(operation);
  };

  const retry = () => {
    if (pendingRef.current && !busy) void sendPending(pendingRef.current);
  };

  const retryLoad = () => {
    setError(null);
    setRefresh((value) => value + 1);
  };

  if (!loaded) return h(React.Fragment, null,
    h("p", null, h("a", { className: "button-link secondary", href: "/attention" }, "回到待處理列表")),
    error ? h("div", { className: "notice error", role: "alert" }, h("span", null, describeError(error)), h("button", { type: "button", className: "secondary", onClick: retryLoad }, "重試")) : h("p", { className: "notice loading", role: "status" }, "讀取原因與證據…"));

  const related = relatedWorkForAttention(item.subjectKind, item.subjectId);
  const effectiveState = String(item.effectiveState ?? item.state ?? "UNKNOWN");
  const snoozeAllowed = ["OPEN", "SNOOZED"].includes(String(item.state));
  const snoozeUntil = (hours: number) => Date.now() + hours * 60 * 60 * 1000;
  const evidence = (() => { try { return JSON.stringify(item.evidence ?? null, null, 2); } catch { return "無法顯示證據"; } })();

  return h(React.Fragment, null,
    h("p", null, h("a", { className: "button-link secondary", href: "/attention" }, "← 待處理列表")),
    h("div", { className: "section-heading" }, h("div", null,
      h("p", { className: "eyebrow" }, "ATTENTION DETAIL"),
      h("h1", null, attentionTitle(item.reasonCode)),
      h("p", null, "標記已讀只記錄閱讀進度；暫緩只改變列表顯示，不代表問題已解決。")),
      h("span", { className: `attention-severity severity-${String(item.severity ?? "normal").toLowerCase()}` }, severityLabels[String(item.severity)] ?? String(item.severity ?? "未知"))),
    error ? h("div", { className: "notice error", role: "alert" }, h("span", null, describeError(error)), h("button", { type: "button", className: "secondary", onClick: retryLoad }, "重試讀取")) : null,
    loaded.capability.available !== true ? h("p", { className: "notice", role: "status" }, `目前不能更改此事項：${loaded.capability.reason ?? "能力尚未啟用"}。仍可檢視已保存的原因與證據。`) : null,
    h("section", { className: "detail-grid attention-detail-grid" },
      h("article", { className: "card" }, h("h2", null, "原因與狀態"),
        h("dl", null,
          h("dt", null, "原因"), h("dd", null, attentionTitle(item.reasonCode)),
          h("dt", null, "原因代碼"), h("dd", null, h("code", null, String(item.reasonCode ?? "UNKNOWN"))),
          h("dt", null, "來源"), h("dd", null, String(item.subjectKind ?? "未知來源")),
          h("dt", null, "Subject ID"), h("dd", null, String(item.subjectId ?? "—")),
          h("dt", null, "狀態"), h("dd", null, stateLabels[effectiveState] ?? effectiveState),
          h("dt", null, "嚴重度"), h("dd", null, severityLabels[String(item.severity)] ?? String(item.severity ?? "未知")),
          h("dt", null, "未讀"), h("dd", null, item.isUnread ? "是" : "否"),
          h("dt", null, "更新時間"), h("dd", null, formatAttentionTime(item.updatedAt)),
          h("dt", null, "期限"), h("dd", null, formatAttentionTime(item.deadlineAt)),
          h("dt", null, "暫緩期限"), h("dd", null, formatAttentionTime(item.snoozeUntil)),
          h("dt", null, "觀察時間"), h("dd", null, formatAttentionTime(loaded.observedAt)))),
      h("article", { className: "card" }, h("h2", null, "證據"),
        item.evidence === null || item.evidence === undefined ? h("p", null, "目前沒有結構化證據。") : h("pre", { className: "attention-evidence" }, evidence))),
    h("section", { className: "card attention-actions-card" }, h("h2", null, "下一步"),
      h("p", null, "打開詳情不會自動標記已讀。"),
      h("div", { className: "actions" },
        h("button", { type: "button", disabled: !capabilityAvailable || Boolean(pending) || !item.isUnread, onClick: () => begin("READ") }, item.isUnread ? "標記已讀" : "已讀"),
        snoozeAllowed ? h("button", { type: "button", disabled: !capabilityAvailable || Boolean(pending), onClick: () => begin("SNOOZE", snoozeUntil(1)) }, "暫緩 1 小時") : null,
        snoozeAllowed ? h("button", { type: "button", disabled: !capabilityAvailable || Boolean(pending), onClick: () => begin("SNOOZE", snoozeUntil(24)) }, "暫緩 24 小時") : null,
        item.state === "SNOOZED" ? h("button", { type: "button", disabled: !capabilityAvailable || Boolean(pending), onClick: () => begin("UNSNOOZE") }, "恢復顯示") : null,
        related ? h("a", { className: "button-link secondary", href: related.href }, related.label) : null),
      pending && !busy ? h("button", { type: "button", className: "secondary", onClick: retry }, `重試同一操作：${pending.label}`) : null,
      pending && busy ? h("p", { className: "notice loading", role: "status" }, `${pending.label}操作確認中…`) : null,
      message ? h("p", { className: "notice", role: "status" }, message) : null,
      !related ? h("p", { className: "attention-unknown-source" }, `未提供可用的工作頁連結；來源 ID：${String(item.subjectId ?? "—")}`) : null));
}
