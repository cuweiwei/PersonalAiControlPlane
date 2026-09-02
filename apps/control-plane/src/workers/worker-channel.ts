import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { EventHub } from "../events/event-hub.ts";
import { TaskService } from "../tasks/task-service.ts";
import { ArtifactStorage } from "../artifacts/artifact-storage.ts";
import { WorkerService } from "./worker-service.ts";

type JsonRecord = Record<string, any>;
type SocketRecord = { socket: WebSocket; workerId: string; hello: boolean };

function record(value: unknown): JsonRecord { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {}; }
function messagePayload(value: unknown): JsonRecord { const parsed = typeof value === "string" ? JSON.parse(value) : value; return record(parsed); }
function bearer(request: IncomingMessage): string | undefined { const value = request.headers.authorization; return value?.startsWith("Bearer ") ? value.slice(7) : undefined; }

export class WorkerCoordinator {
  readonly websocketServer = new WebSocketServer({ noServer: true });
  private readonly workers: WorkerService;
  private readonly tasks: TaskService;
  private readonly events: EventHub;
  private readonly artifacts?: ArtifactStorage;
  private readonly connections = new Map<string, SocketRecord>();

  constructor(workers: WorkerService, tasks: TaskService, events: EventHub, artifacts?: ArtifactStorage) { this.workers = workers; this.tasks = tasks; this.events = events; this.artifacts = artifacts; this.websocketServer.on("connection", (socket: WebSocket, request: IncomingMessage, workerId: string) => this.acceptSocket(socket, request, workerId)); }

  handleUpgrade(request: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer): void {
    const token = bearer(request); const worker = token ? this.workers.authenticate(token) : undefined;
    if (!worker) {
      const disposition = this.workers.tokenDisposition(token ?? "");
      const status = disposition === "removed" ? "410 Gone" : disposition === "disabled" ? "403 Forbidden" : "401 Unauthorized";
      const code = disposition === "removed" ? "WORKER_REMOVED" : disposition === "disabled" ? "WORKER_DISABLED" : "INVALID_WORKER_TOKEN";
      const body = JSON.stringify({ error: { code } });
      socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      socket.destroy();
      return;
    }
    this.websocketServer.handleUpgrade(request, socket, head, (ws) => this.websocketServer.emit("connection", ws, request, worker.id));
  }

  isConnected(workerId: string): boolean { return this.connections.has(workerId); }

  offer(workerId: string, task: Record<string, any>, attemptId: string): boolean {
    const connection = this.connections.get(workerId); if (!connection || !connection.hello || connection.socket.readyState !== 1) return false;
    connection.socket.send(JSON.stringify({ type: "task.offer", task_id: task.id, attempt_id: attemptId, task_type: task.taskType, title: task.title, instruction: task.instruction, context: task.context, payload: task.payload, execution: task.execution, limits: { timeout_seconds: task.timeoutSeconds }, input_artifact_ids: task.inputArtifactIds ?? [] }));
    return true;
  }

  cancel(workerId: string, taskId: string, attemptId: string): boolean { const connection = this.connections.get(workerId); if (!connection) return false; connection.socket.send(JSON.stringify({ type: "task.cancel", task_id: taskId, attempt_id: attemptId })); return true; }
  closeWorker(workerId: string, code = 4001, reason = "worker removed"): void { this.connections.get(workerId)?.socket.close(code, reason); }
  close(): void { for (const connection of this.connections.values()) connection.socket.close(); this.websocketServer.close(); this.connections.clear(); }

  private acceptSocket(socket: WebSocket, _request: IncomingMessage, workerId: string): void {
    const previous = this.connections.get(workerId); previous?.socket.close(4000, "replaced");
    const connection: SocketRecord = { socket, workerId, hello: false }; this.connections.set(workerId, connection); this.workers.markConnected(workerId);
    const timeout = setTimeout(() => { if (!connection.hello) socket.close(4002, "hello required"); }, 10_000); timeout.unref();
    socket.on("message", (raw) => { void this.handleMessage(connection, raw.toString()); });
    socket.on("close", () => { clearTimeout(timeout); if (this.connections.get(workerId) === connection) { this.connections.delete(workerId); this.workers.markDisconnected(workerId); } });
    socket.on("error", () => { /* close event owns state cleanup */ });
  }

  private async handleMessage(connection: SocketRecord, raw: string): Promise<void> {
    let message: JsonRecord; try { message = messagePayload(raw); } catch { connection.socket.close(4003, "invalid json"); return; }
    const type = String(message.type ?? ""); const workerId = connection.workerId; const taskId = String(message.task_id ?? ""); const attemptId = String(message.attempt_id ?? "");
    if (!connection.hello) {
      if (type !== "hello" || String(message.worker_id ?? "") !== workerId || Number(message.protocol_version) !== 2) { connection.socket.close(4004, "protocol version unsupported"); return; }
      connection.hello = true; connection.socket.send(JSON.stringify({ type: "hello.ack", server_version: "2.0.0", heartbeat_interval_seconds: 30 })); this.flushAssigned(workerId); this.events.publish({ type: "worker.updated", workerId, status: "ONLINE" }); return;
    }
    try {
      if (type === "heartbeat") this.workers.heartbeat(workerId, message, Date.now());
      else if (type === "capabilities.update") this.workers.updateCapabilities(workerId, Array.isArray(message.capabilities) ? message.capabilities : [], Date.now());
      else if (type === "models.update") this.workers.updateModels(workerId, Array.isArray(message.models) ? message.models : [], Date.now());
      else if (type === "task.accept") this.tasks.accept(taskId, attemptId, workerId);
      else if (type === "task.reject") this.tasks.fail(taskId, attemptId, workerId, String(message.reason ?? "WORKER_REJECTED"), "Worker rejected the task offer.", Date.now(), true);
      else if (type === "task.started") this.tasks.started(taskId, attemptId, workerId);
      else if (type === "task.progress") this.tasks.progress(taskId, attemptId, workerId, record(message.progress));
      else if (type === "task.log") this.tasks.log(taskId, attemptId, workerId, record(message.log));
      else if (type === "task.artifact") this.storeArtifact(workerId, taskId, attemptId, record(message.artifact), connection.socket);
      else if (type === "task.result") { this.tasks.result(taskId, attemptId, workerId, record(message.result), record(message.metrics)); connection.socket.send(JSON.stringify({ type: "task.result.ack", task_id: taskId, attempt_id: attemptId })); }
      else if (type === "task.failed") this.tasks.fail(taskId, attemptId, workerId, String(message.code ?? "WORKER_EXECUTION_FAILED"), String(message.message ?? "Worker execution failed."), Date.now(), message.retryable === true);
      else if (type === "task.cancelled") this.tasks.fail(taskId, attemptId, workerId, "CANCELLED_BY_WORKER", "Worker acknowledged cancellation.", Date.now(), false);
    } catch (error) { connection.socket.send(JSON.stringify({ type: "error", code: error instanceof Error ? error.message : "INTERNAL_ERROR" })); }
  }

  private flushAssigned(workerId: string): void {
    const rows = this.tasks.db.all<JsonRecord>("SELECT t.id, t.current_attempt_id FROM tasks t JOIN task_attempts a ON a.id = t.current_attempt_id WHERE t.status = 'ASSIGNED' AND a.worker_id = ? AND a.status = 'OFFERED'", workerId);
    for (const row of rows) {
      const task = this.tasks.get(String(row.id));
      if (task) this.offer(workerId, task, String(row.current_attempt_id));
    }
  }

  private storeArtifact(workerId: string, taskId: string, attemptId: string, value: JsonRecord, socket: WebSocket): void {
    if (!this.artifacts) throw new Error("ARTIFACT_UNAVAILABLE");
    const row = this.tasks.db.one<JsonRecord>("SELECT t.status, t.current_attempt_id FROM tasks t JOIN task_attempts a ON a.id = t.current_attempt_id WHERE t.id = ? AND a.id = ? AND a.worker_id = ?", taskId, attemptId, workerId);
    if (!row || !["ASSIGNED", "RUNNING"].includes(String(row.status))) throw new Error("ARTIFACT_NOT_FOUND");
    const encoded = typeof value.data_base64 === "string" ? value.data_base64 : "";
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error("INVALID_ARTIFACT_ENCODING");
    const bytes = Buffer.from(encoded, "base64");
    const limit = Math.min(1_073_741_824, Math.max(1, Number(process.env.PAI_MAX_ARTIFACT_BYTES ?? 1_073_741_824)));
    if (bytes.byteLength > limit) throw new Error("REQUEST_TOO_LARGE");
    const mediaTypeRaw = String(value.media_type ?? value.mediaType ?? "application/octet-stream");
    const mediaType = /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+(?:;[A-Za-z0-9=._ -]+)*$/.test(mediaTypeRaw) ? mediaTypeRaw.slice(0, 160) : "application/octet-stream";
    const stored = this.artifacts.write(taskId, String(value.filename ?? "artifact.bin"), mediaType, bytes);
    this.tasks.db.run("INSERT INTO artifacts(id, task_id, attempt_id, filename, media_type, size_bytes, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", stored.id, taskId, attemptId, stored.filename, stored.mediaType, stored.sizeBytes, stored.sha256, stored.storagePath, Date.now());
    this.tasks.db.run("INSERT INTO task_artifacts(task_id, artifact_id, direction) VALUES (?, ?, 'OUTPUT')", taskId, stored.id);
    socket.send(JSON.stringify({ type: "task.artifact.ack", task_id: taskId, attempt_id: attemptId, artifact_id: stored.id, sha256: stored.sha256 }));
  }
}
