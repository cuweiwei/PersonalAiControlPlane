/** Read-only presentation of persisted Office evidence. Animation never advances work. */
export type OfficeActivityState = "IDLE" | "WORKING" | "PLANNING" | "REVIEWING" | "DELIVERING" | "WAITING" | "OFFLINE" | "ERROR" | "UNKNOWN";
export interface OfficeActivity {
  state: OfficeActivityState;
  reason: string;
  missionId?: string;
  missionTitle?: string;
  taskId?: string;
  stepKey?: string;
  workerId?: string;
  workerName?: string;
  runtime?: string;
  model?: string;
  activeCount: number;
}
export interface OfficeSceneMember {
  id: string;
  displayName: string;
  seatKey: string;
  role: { name: string };
  binding: Record<string, any>;
  maxConcurrency: number;
  activity: OfficeActivity;
}
export interface OfficeSceneMission {
  id: string;
  title: string;
  phase: string;
  control: string;
  waitReason: string | null;
  bucket: "todo" | "active" | "attention" | "completed" | "closed";
  hasResult: boolean;
  updatedAt: string;
}
export interface OfficeSceneData {
  observedAt: string;
  members: OfficeSceneMember[];
  orchestrator: OfficeActivity;
  board: { todo: number; active: number; attention: number; completed: number; closed: number; results: number };
  missions: OfficeSceneMission[];
  recentEvents: Array<{ id: string; type: string; missionId: string; title: string; at: string }>;
}
