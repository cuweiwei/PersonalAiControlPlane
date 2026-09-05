import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type WorkerConfig = { version: number; executors: Record<string, { enabled?: boolean }>; workspaces: Record<string, { name: string; path: string }> };
const emptyConfig: WorkerConfig = { version: 1, executors: {}, workspaces: {} };

export function readWorkerConfig(path: string): WorkerConfig {
  if (!existsSync(path)) return structuredClone(emptyConfig);
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; const executors = value.executors && typeof value.executors === "object" && !Array.isArray(value.executors) ? value.executors as Record<string, { enabled?: boolean }> : {}; const source = value.workspaces && typeof value.workspaces === "object" && !Array.isArray(value.workspaces) ? value.workspaces as Record<string, Record<string, unknown>> : {};
    const workspaces: WorkerConfig["workspaces"] = {};
    for (const [id, item] of Object.entries(source)) if (/^[A-Za-z0-9_-]{1,80}$/.test(id) && typeof item?.path === "string" && item.path.length > 0) workspaces[id] = { name: typeof item.name === "string" && item.name ? item.name.slice(0, 200) : id, path: item.path };
    return { version: Number(value.version) === 1 ? 1 : 1, executors, workspaces };
  } catch { return structuredClone(emptyConfig); }
}

export function writeWorkerConfig(path: string, value: WorkerConfig): void {
  const normalized: WorkerConfig = { version: 1, executors: value.executors ?? {}, workspaces: value.workspaces ?? {} }; const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try { renameSync(temporary, path); } catch (error) { try { if (existsSync(temporary)) renameSync(temporary, `${path}.recovery-${process.pid}`); } catch { /* preserve the original failure */ } throw error; }
}

export function addWorkspace(path: string, id: string, name: string, workspacePath: string): WorkerConfig {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error("INVALID_WORKSPACE_ID"); if (!name.trim() || name.length > 200) throw new Error("INVALID_WORKSPACE_NAME"); const resolved = resolve(workspacePath); if (!existsSync(resolved) || !statSync(resolved).isDirectory()) throw new Error("WORKSPACE_PATH_UNAVAILABLE"); const config = readWorkerConfig(path); if (config.workspaces[id]) throw new Error("WORKSPACE_ALREADY_EXISTS"); config.workspaces[id] = { name: name.trim(), path: resolved }; return config;
}

export function configPath(dataDir: string): string { return resolve(dirname(dataDir), dataDir.endsWith("/") ? "worker-config.json" : `${dataDir}/worker-config.json`); }
