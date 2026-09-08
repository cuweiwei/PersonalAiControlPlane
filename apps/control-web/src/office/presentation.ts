import type { OfficeActivityState } from "../../../../packages/contracts/src/office-scene.ts";

export const statePresentation: Record<OfficeActivityState, { label: string; color: string; verb: string }> = {
  IDLE: { label: "閒置可接案", color: "#79a974", verb: "等待下一份工作" },
  WORKING: { label: "工作中", color: "#6b9eea", verb: "專注處理工作" },
  PLANNING: { label: "規劃中", color: "#6b9eea", verb: "安排團隊的下一步" },
  REVIEWING: { label: "審查中", color: "#b59ad7", verb: "審閱與整理成果" },
  DELIVERING: { label: "交付中", color: "#67bcb4", verb: "將成果送往交付區" },
  WAITING: { label: "等待中", color: "#d7ac65", verb: "等待條件就緒" },
  OFFLINE: { label: "離線", color: "#929995", verb: "工作席目前離線" },
  ERROR: { label: "需要處理", color: "#d98075", verb: "工作遇到阻礙" },
  UNKNOWN: { label: "待確認", color: "#b4aaa1", verb: "等待最新執行證據" },
};
export const eventLabels: Record<string, string> = {
  "mission.created": "收到新的交辦", "mission.completed": "成果已完成", "mission.plan.activated": "工作計畫已啟用",
  "plan.activated": "工作計畫已啟用", "step.execution.created": "已安排執行步驟", "mission.finalization.requested": "已送交主管審閱",
  "mission.updated": "工作狀態已更新", "mission.delivery.updated": "交付狀態已更新", "mission.control.changed": "工作控制已更新",
};
export type OfficeSelection = "overview" | "board" | "results" | "attention" | "orchestrator" | `member:${string}`;
