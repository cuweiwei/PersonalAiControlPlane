import type { OfficeActivityState, OfficeSceneData } from "../../../../packages/contracts/src/office-scene.ts";

/** Explicit preview only. Never posted to the API or mixed into the live projection. */
export function demoOffice(tick = 0): OfficeSceneData {
  const states: OfficeActivityState[] = ["WORKING", "REVIEWING", "DELIVERING", "IDLE", "WAITING", "OFFLINE", "ERROR", "UNKNOWN"];
  const names = ["阿程", "小析", "小文", "阿研", "小審"];
  const roles = ["工程師", "分析師", "撰稿員", "研究員", "審查員"];
  const models = ["Codex", "Python", "本機模型", "本機模型", "審查模型"];
  const titles = ["實作辦公室狀態呈現", "審閱研究資料", "交付團隊週報", "整理下一份研究題目", "等待補充參考資料"];
  const now = new Date().toISOString();
  const members = names.map((name, i) => {
    const state = states[(i + tick) % states.length];
    return { id: `demo-${i}`, displayName: name, seatKey: `desk-${i}`, role: { name: roles[i] }, binding: { kind: "WORKER_SELECTOR", runtime: models[i] }, maxConcurrency: 1, activity: { state, reason: "示範動畫：這不是實際執行中的任務", missionId: `demo-mission-${i}`, missionTitle: titles[i], workerName: ["Worker Mac", "Worker NAS", "Worker Windows"][i % 3], model: models[i], activeCount: ["WORKING", "REVIEWING", "DELIVERING"].includes(state) ? 1 : 0 } };
  });
  return {
    observedAt: now, members,
    orchestrator: { state: tick % 2 ? "REVIEWING" : "PLANNING", reason: "示範動畫：Hermes 規劃與審閱姿態", missionTitle: "安排團隊的下一步", activeCount: 1 },
    board: { todo: 1, active: 2, attention: 1, completed: 1, closed: 0, results: 1 },
    missions: titles.map((title, i) => ({ id: `demo-mission-${i}`, title, phase: i === 2 ? "COMPLETED" : "EXECUTING", control: "ACTIVE", waitReason: i === 4 ? "WAITING_OWNER" : null, bucket: (["active", "active", "completed", "todo", "attention"] as const)[i], hasResult: i === 2, updatedAt: now })),
    recentEvents: [{ id: "demo-event", type: "step.execution.created", missionId: "demo-mission-0", title: "示範：Hermes 已安排工作", at: now }],
  };
}
