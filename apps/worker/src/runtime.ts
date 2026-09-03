import type { JsonValue } from "../../../packages/contracts/src/index.ts";
import { WorkerLocalDatabase } from "./local-db.ts";

export type WorkerTaskOffer = { task_id: string; attempt_id: string; task_type: string; title?: string; instruction: string; context?: Record<string, JsonValue>; payload?: Record<string, JsonValue>; execution?: Record<string, JsonValue>; limits?: Record<string, JsonValue>; input_artifact_ids?: string[] };
export type ExecutionEvent = { type: "progress" | "log" | "result" | "artifact"; progress?: Record<string, JsonValue>; log?: Record<string, JsonValue>; result?: Record<string, JsonValue>; metrics?: Record<string, JsonValue>; artifact?: Record<string, JsonValue> };
export type WorkerExecutor = { type: string; discover?(): Promise<{ capabilities?: Record<string, JsonValue>[]; models?: Record<string, JsonValue>[] }>; canExecute(task: WorkerTaskOffer): boolean; execute(task: WorkerTaskOffer, context: { emit(event: ExecutionEvent): Promise<void>; signal?: AbortSignal }): AsyncIterable<ExecutionEvent>; cancel?(attemptId: string): Promise<void> };
export type WorkerTransport = { connect?(onMessage: (message: Record<string, any>) => void, onClose?: (error: Error) => void): Promise<void>; send(message: Record<string, any>): Promise<void> | void; close?(): void; connected?(): boolean; poll?(): Promise<WorkerTaskOffer[]> };
export type WorkerRuntimeOptions = { workerId: string; db: WorkerLocalDatabase; transport: WorkerTransport; executors: WorkerExecutor[]; clock?: () => number; report?: () => Record<string, JsonValue> };

type RunningExecution = { executor: WorkerExecutor; controller: AbortController };
type HelloWaiter = { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void };

function workerError(error: unknown, fallback = "WORKER_TRANSPORT_FAILED"): Error {
  return error instanceof Error ? error : new Error(fallback);
}

export class OutboundWorkerRuntime {
  readonly workerId: string;
  readonly db: WorkerLocalDatabase;
  private readonly transport: WorkerTransport;
  private readonly executors: WorkerExecutor[];
  private readonly clock: () => number;
  private readonly report?: () => Record<string, JsonValue>;
  private readonly running = new Map<string, RunningExecution>();
  private transportError?: Error;
  private helloWaiter?: HelloWaiter;

  constructor(options: WorkerRuntimeOptions) { this.workerId = options.workerId; this.db = options.db; this.transport = options.transport; this.executors = options.executors; this.clock = options.clock ?? Date.now; this.report = options.report; }
  async connect(): Promise<void> {
    this.transportError = undefined;
    if (this.transport.connect) {
      await this.transport.connect(
        (message) => { void this.handleMessage(message).catch((error) => this.setTransportError(error)); },
        (error) => this.setTransportError(error),
      );
      const hello = this.prepareHelloWaiter();
      await this.sendHello();
      await hello;
    }
    this.ensureTransportHealthy();
    await this.refreshInventory();
    await this.resendPending();
  }
  async pollOnce(): Promise<number> {
    this.ensureTransportHealthy();
    if (this.transport.poll) { const offers = await this.transport.poll(); for (const offer of offers) await this.handleOffer(offer); return offers.length; }
    if (this.transport.connected && !this.transport.connected()) throw new Error("WORKER_DISCONNECTED");
    await this.resendPending();
    return 0;
  }
  async heartbeat(): Promise<void> { await this.transport.send({ type: "heartbeat", worker_id: this.workerId, timestamp: new Date(this.clock()).toISOString(), ...(this.report?.() ?? {}) }); }
  async refreshInventory(): Promise<void> { this.ensureTransportHealthy(); await this.discover(); }
  async handleOffer(offer: WorkerTaskOffer): Promise<void> {
    const existing = this.db.connection.prepare("SELECT * FROM assignments WHERE attempt_id = ?").get(offer.attempt_id) as Record<string, any> | undefined;
    if (existing) { if (existing.status === "COMPLETED") await this.resendResult(offer.attempt_id); return; }
    const executor = this.executors.find((candidate) => candidate.canExecute(offer));
    this.db.transaction(() => this.db.connection.prepare("INSERT INTO assignments(attempt_id, task_id, task_type, offer_json, status, accepted_at, updated_at) VALUES (?, ?, ?, ?, 'ACCEPTED', ?, ?)").run(offer.attempt_id, offer.task_id, offer.task_type, JSON.stringify(offer), this.clock(), this.clock()));
    await this.transport.send({ type: "task.accept", task_id: offer.task_id, attempt_id: offer.attempt_id });
    if (!executor) { await this.fail(offer, "EXECUTOR_UNAVAILABLE", "No enabled executor can handle this task type.", true); return; }
    const controller = new AbortController();
    this.running.set(offer.attempt_id, { executor, controller });
    this.db.connection.prepare("UPDATE assignments SET status = 'RUNNING', updated_at = ? WHERE attempt_id = ? AND status = 'ACCEPTED'").run(this.clock(), offer.attempt_id);
    if (this.isCancelled(offer.attempt_id)) { controller.abort(); this.running.delete(offer.attempt_id); return; }
    await this.transport.send({ type: "task.started", task_id: offer.task_id, attempt_id: offer.attempt_id });
    try {
      for await (const event of executor.execute(offer, { emit: (item) => this.emit(offer, item), signal: controller.signal })) {
        if (this.isCancelled(offer.attempt_id)) break;
        await this.emit(offer, event);
        if (event.type === "result" && !this.isCancelled(offer.attempt_id)) await this.complete(offer, event.result ?? {}, event.metrics ?? {});
      }
      const state = this.db.connection.prepare("SELECT status FROM assignments WHERE attempt_id = ?").get(offer.attempt_id) as { status: string } | undefined;
      if (state?.status === "RUNNING") await this.complete(offer, {}, {});
    } catch (error) { const code = error instanceof Error ? error.message : "EXECUTION_FAILED"; await this.fail(offer, code, "Worker executor failed.", isInfrastructureFailure(code)); }
    finally { this.running.delete(offer.attempt_id); }
  }

  async handleCancel(message: { task_id: string; attempt_id: string }): Promise<void> {
    const running = this.running.get(message.attempt_id);
    running?.controller.abort();
    try { await running?.executor.cancel?.(message.attempt_id); } catch { /* cancellation is best effort; the DB fence is authoritative */ }
    finally {
      this.db.connection.prepare("UPDATE assignments SET status = 'CANCELLED', updated_at = ? WHERE attempt_id = ? AND status IN ('ACCEPTED', 'RUNNING')").run(this.clock(), message.attempt_id);
      await this.transport.send({ type: "task.cancelled", task_id: message.task_id, attempt_id: message.attempt_id });
    }
  }
  close(): void { this.transport.close?.(); }

  private async handleMessage(message: Record<string, any>): Promise<void> {
    if (message.type === "hello.ack") { this.helloWaiter?.resolve(); return; }
    if (message.type === "error") { const error = new Error(String(message.code ?? "WORKER_REMOTE_ERROR")); this.helloWaiter?.reject(error); this.setTransportError(error); return; }
    if (message.type === "task.offer") await this.handleOffer(message as WorkerTaskOffer);
    else if (message.type === "task.cancel") await this.handleCancel(message as { task_id: string; attempt_id: string });
    else if (message.type === "task.result.ack") this.db.connection.prepare("UPDATE results SET status = 'DELIVERED', delivered_at = ? WHERE attempt_id = ?").run(this.clock(), message.attempt_id);
  }
  private async sendHello(): Promise<void> { await this.transport.send({ type: "hello", protocol_version: 2, worker_id: this.workerId, agent_version: "2.0.0" }); }
  private prepareHelloWaiter(): Promise<void> {
    let resolveWaiter!: () => void;
    let rejectWaiter!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => { resolveWaiter = resolve; rejectWaiter = reject; });
    this.helloWaiter = { promise, resolve: resolveWaiter, reject: rejectWaiter };
    const timer = setTimeout(() => rejectWaiter(new Error("WORKER_HELLO_TIMEOUT")), 10_000);
    void promise.then(() => { clearTimeout(timer); if (this.helloWaiter?.promise === promise) this.helloWaiter = undefined; }, () => { clearTimeout(timer); if (this.helloWaiter?.promise === promise) this.helloWaiter = undefined; });
    return promise;
  }
  private async discover(): Promise<void> {
    const capabilities: Record<string, JsonValue>[] = [];
    const models: Record<string, JsonValue>[] = [];
    for (const executor of this.executors) { const found = await executor.discover?.(); if (found?.capabilities) capabilities.push(...found.capabilities); if (found?.models) models.push(...found.models); }
    await this.transport.send({ type: "capabilities.update", worker_id: this.workerId, capabilities });
    await this.transport.send({ type: "models.update", worker_id: this.workerId, models });
  }
  private async emit(offer: WorkerTaskOffer, event: ExecutionEvent): Promise<void> { if (this.isCancelled(offer.attempt_id)) return; if (event.type === "progress") await this.transport.send({ type: "task.progress", task_id: offer.task_id, attempt_id: offer.attempt_id, progress: event.progress ?? {} }); else if (event.type === "log") await this.transport.send({ type: "task.log", task_id: offer.task_id, attempt_id: offer.attempt_id, log: event.log ?? {} }); else if (event.type === "artifact") await this.transport.send({ type: "task.artifact", task_id: offer.task_id, attempt_id: offer.attempt_id, artifact: event.artifact ?? {} }); }
  private async complete(offer: WorkerTaskOffer, result: Record<string, JsonValue>, metrics: Record<string, JsonValue>): Promise<void> {
    const payload = { result, metrics };
    const completed = this.db.transaction(() => {
      const state = this.db.connection.prepare("SELECT status FROM assignments WHERE attempt_id = ?").get(offer.attempt_id) as { status?: string } | undefined;
      if (state?.status !== "RUNNING") return false;
      this.db.connection.prepare("INSERT INTO results(attempt_id, task_id, result_json, status, created_at) VALUES (?, ?, ?, 'PENDING', ?) ON CONFLICT(attempt_id) DO UPDATE SET result_json = excluded.result_json, status = 'PENDING'").run(offer.attempt_id, offer.task_id, JSON.stringify(payload), this.clock());
      this.db.connection.prepare("UPDATE assignments SET status = 'COMPLETED', updated_at = ? WHERE attempt_id = ? AND status = 'RUNNING'").run(this.clock(), offer.attempt_id);
      return true;
    });
    if (completed) await this.resendResult(offer.attempt_id);
  }
  private async resendResult(attemptId: string): Promise<void> { const row = this.db.connection.prepare("SELECT * FROM results WHERE attempt_id = ? AND status = 'PENDING'").get(attemptId) as Record<string, any> | undefined; if (!row) return; const offer = this.db.connection.prepare("SELECT * FROM assignments WHERE attempt_id = ?").get(attemptId) as Record<string, any> | undefined; if (!offer) return; const parsed = JSON.parse(row.result_json); const task = JSON.parse(offer.offer_json); await this.transport.send({ type: "task.result", task_id: task.task_id, attempt_id: attemptId, result: parsed.result, metrics: parsed.metrics }); }
  private async resendPending(): Promise<void> { const rows = this.db.connection.prepare("SELECT attempt_id FROM results WHERE status = 'PENDING' ORDER BY created_at").all() as Array<{ attempt_id: string }>; for (const row of rows) await this.resendResult(row.attempt_id); }
  private async fail(offer: WorkerTaskOffer, code: string, message: string, retryable: boolean): Promise<void> {
    const failed = this.db.connection.prepare("UPDATE assignments SET status = 'FAILED', updated_at = ? WHERE attempt_id = ? AND status IN ('ACCEPTED', 'RUNNING')").run(this.clock(), offer.attempt_id);
    if (Number(failed.changes) > 0) await this.transport.send({ type: "task.failed", task_id: offer.task_id, attempt_id: offer.attempt_id, code, message, retryable });
  }
  private isCancelled(attemptId: string): boolean { return (this.db.connection.prepare("SELECT status FROM assignments WHERE attempt_id = ?").get(attemptId) as { status?: string } | undefined)?.status === "CANCELLED"; }
  private setTransportError(error: unknown): void { this.transportError ??= workerError(error); this.helloWaiter?.reject(this.transportError); }
  private ensureTransportHealthy(): void { if (this.transportError) throw this.transportError; }
}

function isInfrastructureFailure(code: string): boolean {
  return code === "EXECUTOR_UNAVAILABLE" || code === "WORKER_DISCONNECTED" || code === "WORKER_TRANSPORT_FAILED" || code.endsWith("_TIMEOUT") || code.endsWith("_UNAVAILABLE") || /^\w+_HTTP_5\d\d$/.test(code) || code === "fetch failed";
}
