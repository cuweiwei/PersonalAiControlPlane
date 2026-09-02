import type { TaskState } from "../../../../packages/contracts/src/index.ts";

export const TASK_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  QUEUED: ["ASSIGNED", "CANCELLED"],
  ASSIGNED: ["RUNNING", "QUEUED", "FAILED", "CANCELLED"],
  RUNNING: ["SUCCEEDED", "FAILED", "QUEUED", "CANCELLED"],
  SUCCEEDED: [],
  FAILED: ["QUEUED"],
  CANCELLED: [],
};

export const terminalTaskStates = new Set<TaskState>(["SUCCEEDED", "FAILED", "CANCELLED"]);

export function assertTaskTransition(from: TaskState, to: TaskState): void {
  if (!TASK_TRANSITIONS[from].includes(to)) throw new Error("INVALID_TASK_STATE");
}
