import React, { useCallback, useEffect, useRef, useState } from "react";
import type { OfficeActivity, OfficeSceneData, OfficeSceneMember } from "../../../../packages/contracts/src/office-scene.ts";
import type { OfficeSceneController } from "./scene.ts";
import { statePresentation, eventLabels, type OfficeSelection } from "./presentation.ts";
import { demoOffice } from "./demo.ts";
import "./office.css";

const h = React.createElement;
type OfficeResponse = { id: string; name: string; scene: OfficeSceneData; workflowHealth: { officeEnabled: boolean; hermesAdapterConfigured: boolean } };
const bucketNames = { todo: "待辦", active: "進行中", attention: "待處理", completed: "已完成", closed: "已取消" };

function Badge({ activity, stale = false }: { activity: OfficeActivity; stale?: boolean }) {
  const p = statePresentation[stale ? "UNKNOWN" : activity.state];
  return h("span", { className: "vo-badge", style: { "--state-color": p.color } as React.CSSProperties }, h("i", { "aria-hidden": true }), stale ? "資料待同步" : p.label);
}

export function OfficePage({ refreshVersion }: { refreshVersion: number }) {
  const [office, setOffice] = useState<OfficeResponse | null>(null);
  const [error, setError] = useState(""); const [retry, setRetry] = useState(0);
  const [selection, setSelection] = useState<OfficeSelection>("overview");
  const [demo, setDemo] = useState(() => new URLSearchParams(window.location.search).get("preview") === "demo"); const [demoTick, setDemoTick] = useState(0);
  const [sample, setSample] = useState(() => demoOffice());
  const [motion, setMotion] = useState(() => !window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [night, setNight] = useState(false); const [ready, setReady] = useState(false);
  const [inside, setInside] = useState(false);
  const [fallback, setFallback] = useState(false); const [page, setPage] = useState(0);
  const host = useRef<HTMLDivElement>(null); const scene = useRef<OfficeSceneController | null>(null);
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    let alive = true, running = false, pending = false; let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    const load = async () => {
      if (running) { pending = true; return; }
      running = true; controller = new AbortController(); const current = controller;
      const timeout = setTimeout(() => current.abort(), 10000);
      const request = async (url: string) => {
        const response = await fetch(url, { signal: current.signal, headers: { accept: "application/json" }, cache: "no-store" });
        const value = await response.json(); if (!response.ok) throw new Error(value.error?.message ?? value.error?.code ?? `HTTP ${response.status}`); return value;
      };
      try {
        const list = await request("/api/v2/offices"); if (!list.items?.length) throw new Error("尚未建立辦公室");
        const value = await request(`/api/v2/offices/${encodeURIComponent(list.items[0].id)}`) as OfficeResponse;
        if (!value.scene) throw new Error("伺服器尚未提供辦公室即時場景資料");
        if (alive) { setOffice(value); setError(""); }
      } catch (reason) { if (alive) setError(reason instanceof Error && reason.name !== "AbortError" ? reason.message : "同步逾時，等待重新連線"); }
      finally {
        clearTimeout(timeout); running = false;
        if (alive) { clearTimeout(timer); const delay = pending ? 250 : 5000; pending = false; timer = setTimeout(() => { if (!document.hidden) void load(); else timer = setTimeout(() => void load(), 5000); }, delay); }
      }
    };
    refresh.current = () => { if (!document.hidden) void load(); };
    const visibility = () => { if (!document.hidden) void load(); };
    document.addEventListener("visibilitychange", visibility); void load();
    return () => { alive = false; controller?.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", visibility); };
  }, [retry]);
  useEffect(() => { refresh.current(); }, [refreshVersion]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)"); const change = () => setMotion(!media.matches); media.addEventListener("change", change); return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => { if (demo) setSample(demoOffice(demoTick)); }, [demo, demoTick]);
  const data = demo ? sample : office?.scene;
  const stale = !demo && Boolean(error);
  const select = useCallback((key: OfficeSelection | "intake") => {
    if (key === "intake") { if (demo) setSelection("board"); else { window.history.pushState({}, "", "/missions/new"); window.dispatchEvent(new PopStateEvent("popstate")); } return; }
    setSelection(key);
  }, [demo]);
  const onSelect = useRef(select); onSelect.current = select;
  const shouldRender = Boolean(data) && !fallback;
  useEffect(() => {
    if (!shouldRender || !host.current) return;
    let alive = true; setReady(false);
    import("./scene.ts").then(({ createOfficeScene }) => {
      if (!alive || !host.current) return;
      try { scene.current = createOfficeScene(host.current, (key) => onSelect.current(key), () => setFallback(true)); setReady(true); }
      catch { setFallback(true); }
    }).catch(() => { if (alive) setFallback(true); });
    return () => { alive = false; scene.current?.dispose(); scene.current = null; };
  }, [shouldRender]);
  useEffect(() => { if (data) scene.current?.update(data, selection, stale, page); }, [data, selection, stale, page, ready]);
  useEffect(() => { scene.current?.setMotion(motion); }, [motion, ready]);
  useEffect(() => { scene.current?.setNight(night); }, [night, ready]);
  useEffect(() => { scene.current?.setInside(inside); }, [inside, ready]);
  const toggleDemo = () => { setDemo((value) => !value); setSelection("overview"); setPage(0); };
  const members = data?.members ?? [];
  const manager = members.find((m) => m.binding.kind === "HERMES_PROFILE" && /^(manager|orchestrator|hermes)$/i.test(m.seatKey));
  const workers = members.filter((m) => m !== manager);
  const logicalMembers = members.filter((m) => m.kind !== "WORKER");
  const workerSummary = data?.workerSummary ?? { total: 0, online: 0 };
  const pages = Math.max(1, Math.ceil(workers.length / 5));
  useEffect(() => { if (page >= pages) setPage(pages - 1); }, [page, pages]);
  const member = selection.startsWith("member:") ? members.find((m) => m.id === selection.slice(7)) : undefined;
  const person = member ?? (selection === "orchestrator" ? manager : undefined);
  const work = person?.activity ?? (selection === "orchestrator" ? data?.orchestrator : undefined);
  const focusMember = (m: OfficeSceneMember) => { const index = workers.findIndex((w) => w.id === m.id); if (index >= 0) setPage(Math.floor(index / 5)); setSelection(`member:${m.id}`); };
  const time = (value?: string) => value ? new Date(value).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : "—";
  const button = (label: string, action: () => void, props: Record<string, unknown> = {}) => h("button", { type: "button", onClick: action, ...props }, (props.children as React.ReactNode) ?? label);
  const missionItems = data?.missions.filter((m) => selection === "results" ? m.hasResult : selection === "attention" ? m.bucket === "attention" : true) ?? [];
  const stats = data?.board;
  return h("div", { className: `virtual-office${night ? " vo-night" : ""}`, "data-mode": demo ? "demo" : "live" },
    h("header", { className: "vo-header" },
      h("div", { className: "vo-heading" }, h("span", { className: "vo-monogram", "aria-hidden": true }, "V"), h("div", null, h("p", { className: "vo-eyebrow" }, "PERSONAL AI / WORKSPACE"), h("h1", null, "Virtual Office"))),
      h("div", { className: `vo-connection${stale ? " is-stale" : ""}`, role: "status" }, h("i", { "aria-hidden": true }), demo ? "示範場景" : stale ? "同步中斷" : office ? "已連線" : "連線中", h("span", null, demo ? "不會執行任何工作" : office ? `更新於 ${time(data?.observedAt)}` : "正在取得辦公室")),
      h("div", { className: "vo-header-actions" }, button(demo ? "返回真實辦公室" : "體驗示範", toggleDemo, { className: "vo-quiet", "aria-pressed": demo }), demo ? button("＋ 交辦工作", () => setSelection("board"), { className: "vo-primary", disabled: true, title: "示範模式不會建立真實任務" }) : h("a", { className: "vo-primary", href: "/missions/new" }, "＋ 交辦工作"))),
    demo ? h("div", { className: "vo-banner vo-demo-banner", role: "status" }, h("span", null, "示範模式 · 人物、任務與數字皆為示意，不代表真實 Worker 正在工作。"), button("切換示範狀態 →", () => setDemoTick((n) => n + 1))) : null,
    stale ? h("div", { className: "vo-banner vo-error-banner", role: "alert" }, h("span", null, `即時資料暫時無法更新：${error}。已停止人物活動，保留最後快照。`), button("重新連線", () => setRetry((n) => n + 1))) : null,
    !demo && office && !office.workflowHealth.officeEnabled ? h("div", { className: "vo-banner" }, "辦公室尚未啟用，成員不會接收新工作。", h("a", { href: "/settings" }, "查看設定 →")) : null,
    !data ? h("section", { className: "vo-empty", role: "status" }, h("span", { className: "vo-empty-symbol" }, "V"), h("h2", null, error ? "辦公室暫時無法連線" : "正在打開你的辦公室"), h("p", null, error || "準備場景與團隊的最新工作狀態…"), button("先體驗示範辦公室", toggleDemo)) : h(React.Fragment, null,
      h("div", { className: "vo-space-heading" }, h("div", null, h("span", { className: "vo-live-dot" }), h("strong", null, demo ? "團隊工作室" : office?.name), h("span", null, "一個空間，看見整個團隊。")), h("span", { className: "vo-space-count" }, `${logicalMembers.length} 位角色 · ${workerSummary.online}/${workerSummary.total} 台 Worker 線上 · ${stats!.active} 件進行中`)),
      h("div", { className: "vo-workspace" },
        h("section", { className: "vo-stage", "aria-label": "沉浸式辦公室" },
          fallback ? h("div", { className: "vo-fallback" }, h("h2", null, "使用簡潔辦公室檢視"), h("p", null, "3D 檢視已關閉。你仍可查看成員、交辦與成果；裝置不支援 WebGL 時也會使用這個檢視。"), h("div", { className: "vo-fallback-members" }, members.map((m) => button(`${m.displayName} · ${statePresentation[stale ? "UNKNOWN" : m.activity.state].label}`, () => focusMember(m), { key: m.id }))), button("開啟 3D 場景", () => setFallback(false))) : h("div", { className: "vo-render-host", ref: host }, !ready ? h("div", { className: "vo-scene-loading", role: "status" }, "正在佈置工作室…") : null),
          h("div", { className: "vo-scene-caption", "aria-hidden": true }, h("span", null, "THE STUDIO"), h("small", null, `${inside ? "室內視角" : "全景視角"} · ${night ? "晚間光線" : "日間光線"}`)),
          h("div", { className: "vo-scene-tools", "aria-label": "場景控制" },
            button("−", () => scene.current?.zoom(-.2), { "aria-label": "縮小場景", disabled: fallback }), button("＋", () => scene.current?.zoom(.2), { "aria-label": "放大場景", disabled: fallback }),
            button("全景", () => { setInside(false); scene.current?.reset(); }, { "aria-label": "重設全景視角", disabled: fallback }),
            button(inside ? "俯瞰" : "室內", () => setInside(!inside), { "aria-label": "切換室內視角", "aria-pressed": inside, disabled: fallback }),
            button(motion ? "Ⅱ 暫停" : "▷ 動畫", () => setMotion(!motion), { "aria-label": motion ? "暫停人物動畫" : "開啟人物動畫", "aria-pressed": motion }),
            button(night ? "☀ 日間" : "☾ 夜間", () => setNight(!night), { "aria-label": "切換辦公室光線", "aria-pressed": night })),
          pages > 1 ? h("div", { className: "vo-floor-pages" }, button("←", () => setPage((n) => Math.max(0, n - 1)), { disabled: page === 0, "aria-label": "上一組座位" }), h("span", null, `座位 ${page + 1} / ${pages}`), button("→", () => setPage((n) => Math.min(pages - 1, n + 1)), { disabled: page === pages - 1, "aria-label": "下一組座位" })) : null),
        h("aside", { className: "vo-inspector", "aria-label": "辦公室詳細資訊" },
          h("div", { className: "vo-inspector-top" }, h("span", { className: "vo-eyebrow" }, work ? "TEAM MEMBER" : selection === "overview" ? "OFFICE OVERVIEW" : "WORKSPACE"), selection !== "overview" ? button("×", () => setSelection("overview"), { "aria-label": "關閉詳細資訊" }) : null),
          work ? h(React.Fragment, null,
            h("div", { className: "vo-person-heading" }, h("div", { className: "vo-avatar", style: { "--state-color": statePresentation[stale ? "UNKNOWN" : work.state].color } as React.CSSProperties }, (person?.displayName ?? "H").slice(0, 1)), h("h2", null, person?.displayName ?? "Hermes"), h("p", null, person?.role.name ?? "Orchestrator / 團隊主管"), h(Badge, { activity: work, stale })),
            h("div", { className: "vo-detail-section" }, h("span", null, "目前任務"), h("h3", null, work.missionTitle ?? "等待下一份工作"), h("p", null, stale ? "資料暫時無法更新，請以重新連線後的狀態為準。" : work.reason), work.stepKey ? h("small", null, `步驟 · ${work.stepKey}`) : null),
            h("dl", { className: "vo-facts" }, h("dt", null, "執行裝置"), h("dd", null, work.workerName ?? work.workerId ?? (selection === "orchestrator" || person?.binding.kind === "HERMES_PROFILE" ? "Hermes" : "尚未指派")), h("dt", null, "模型 / 工具"), h("dd", null, work.model ?? work.runtime ?? person?.binding.model_id ?? person?.binding.runtime ?? "尚未回報"), h("dt", null, "活動工作"), h("dd", null, stale ? "待同步" : `${work.activeCount}${person ? ` / ${person.maxConcurrency} 個執行槽` : " 件"}`)),
            h("div", { className: "vo-inspector-actions" }, button("聚焦工作席", () => scene.current?.focus(selection), { disabled: fallback }), !demo && work.taskId ? h("a", { href: `/tasks/${encodeURIComponent(work.taskId)}` }, "查看執行任務 ↗") : null, !demo && work.missionId ? h("a", { href: `/missions/${encodeURIComponent(work.missionId)}` }, "查看交辦與成果 ↗") : null, !demo && person?.kind === "ROLE" ? h("a", { href: "/office/members" }, "成員與綁定設定") : null)) : selection === "overview" ? h(React.Fragment, null,
              h("h2", null, "今天，一起完成。"), h("p", { className: "vo-intro" }, "點選一位同事，看看他正在忙什麼；或走近看板，掌握團隊進度。"),
              h("div", { className: "vo-board-summary" }, (["todo", "active", "attention", "completed"] as const).map((key) => button("", () => setSelection(key === "attention" ? "attention" : "board"), { key, children: [h("span", { key: "label" }, bucketNames[key]), h("strong", { key: "count" }, stats![key])] }))),
              h("div", { className: "vo-manager-summary" }, h("div", null, h("span", { className: "vo-eyebrow" }, "YOUR ORCHESTRATOR"), h("h3", null, manager?.displayName ?? "Hermes")), h(Badge, { activity: manager?.activity ?? data.orchestrator, stale }), h("p", null, (manager?.activity ?? data.orchestrator).reason), button("看看主管在做什麼 →", () => setSelection("orchestrator"))),
              !logicalMembers.length ? h("p", { className: "vo-inline-note" }, "目前沒有設定團隊角色；線上 Worker 仍會以實體裝置顯示。新增角色與綁定後即可交辦 Mission。", h("a", { href: "/office/members" }, "查看成員設定 →")) : null,
              h("div", { className: "vo-inspector-footnote" }, "人物動作是工作狀態的視覺呈現。", h("br"), "只有收到實際執行回報，才會顯示工作中。")) : h(React.Fragment, null,
                h("h2", null, selection === "results" ? "成果櫃" : selection === "attention" ? "等你處理" : "團隊工作看板"),
                h("p", { className: "vo-intro" }, selection === "results" ? "已完成彙整的成果；外部交付回執請進入交辦詳情查看。" : selection === "attention" ? "需要補充資料、確認或排除阻礙的交辦。" : "以每筆交辦的目前執行輪次統計。"),
                button("走近查看", () => scene.current?.focus(selection), { disabled: fallback, className: "vo-equipment-focus" }),
                h("div", { className: "vo-mission-list" }, missionItems.length ? missionItems.map((m) => h("article", { key: m.id }, h("span", { className: `vo-mission-phase vo-phase-${m.bucket}` }, bucketNames[m.bucket]), demo ? h("h3", null, m.title) : h("a", { href: `/missions/${encodeURIComponent(m.id)}` }, m.title), m.waitReason ? h("small", null, m.waitReason === "WAITING_OWNER" ? "等待你補充資料" : m.waitReason) : null, h("time", { dateTime: m.updatedAt }, time(m.updatedAt)))) : h("p", { className: "vo-inline-note" }, "目前沒有符合條件的工作。")),
                !demo ? h("a", { className: "vo-all-missions", href: "/missions" }, "查看所有交辦 ↗") : null))),
      h("div", { className: "vo-equipment-bar", "aria-label": "辦公設備" }, button("▤ 工作看板", () => setSelection("board"), { "aria-pressed": selection === "board" }), button(`▱ 成果櫃 · ${stats!.results}`, () => setSelection("results"), { "aria-pressed": selection === "results" }), button(`◷ 等你處理 · ${stats!.attention}`, () => setSelection("attention"), { "aria-pressed": selection === "attention" }), button(fallback ? "3D 檢視" : "簡潔檢視", () => setFallback(!fallback)), h("span", null, "拖曳調整視角 · 點選人物與設備")),
      h("section", { className: "vo-team-strip", "aria-label": "團隊成員" }, button("", () => setSelection("orchestrator"), { className: "vo-member-chip", "aria-pressed": selection === "orchestrator", children: [h("span", { key: "avatar", className: "vo-chip-avatar" }, "H"), h("span", { key: "name" }, h("strong", null, manager?.displayName ?? "Hermes"), h("small", null, "Orchestrator")), h(Badge, { key: "badge", activity: manager?.activity ?? data.orchestrator, stale })] }), members.filter((m) => m !== manager).map((m) => button("", () => focusMember(m), { key: m.id, className: "vo-member-chip", "aria-pressed": selection === `member:${m.id}`, children: [h("span", { key: "avatar", className: "vo-chip-avatar" }, m.displayName.slice(0, 1)), h("span", { key: "name" }, h("strong", null, m.displayName), h("small", null, m.role.name)), h(Badge, { key: "badge", activity: m.activity, stale })] }))),
      h("section", { className: "vo-activity-bar", "aria-label": "最近活動" }, h("span", { className: "vo-activity-title" }, "最近動態"), data.recentEvents.length ? data.recentEvents.slice(0, 3).map((e) => h("div", { className: "vo-activity-item", key: e.id }, h("time", { dateTime: e.at }, time(e.at)), demo ? h("span", null, e.title) : h("a", { href: `/missions/${encodeURIComponent(e.missionId)}`, title: e.type }, `${eventLabels[e.type] ?? "交辦進度已更新"} · ${e.title}`))) : h("span", { className: "vo-muted" }, "辦公室已就緒，等待第一份交辦。")),
      h("div", { className: "vo-legend", "aria-label": "狀態圖例" }, Object.entries(statePresentation).filter(([key]) => key !== "PLANNING").map(([key, p]) => h("span", { key }, h("i", { style: { background: p.color } }), p.label)), h("small", null, "動作與姿態為狀態比喻；螢幕圖樣非即時程式輸出。"))))
  ;
}
