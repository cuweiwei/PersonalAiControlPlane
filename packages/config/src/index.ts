export type ControlPlaneConfig = {
  schema_version: 2;
  port: number;
  data_dir: string;
  artifact_dir: string;
  hermes_url: string;
  contexthub_url: string;
  heartbeat_interval_seconds: number;
  stale_after_seconds: number;
  callback_path: string;
};

export const defaultControlPlaneConfig: ControlPlaneConfig = {
  schema_version: 2,
  port: 8080,
  data_dir: "/data",
  artifact_dir: "/data/artifacts",
  hermes_url: "http://hermes-agent:9119",
  contexthub_url: "http://contexthub:8787",
  heartbeat_interval_seconds: 30,
  stale_after_seconds: 90,
  callback_path: "/api/internal/control-plane/task-events",
};
