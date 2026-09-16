import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { ControlPlaneDatabase } from "../apps/control-plane/src/db/database.ts";
import { ComputerSessionService } from "../apps/control-plane/src/computers/computer-session-service.ts";
import { WorkerService } from "../apps/control-plane/src/workers/worker-service.ts";
import { CuaDriverExecutor } from "../apps/worker/src/executors/cua.ts";
import { EventHub } from "../apps/control-plane/src/events/event-hub.ts";
import { TaskService } from "../apps/control-plane/src/tasks/task-service.ts";

test("CUA executor invokes only the allowlisted driver tool and returns an observation artifact", async () => {
  const calls: string[][] = [];
  const executor = new CuaDriverExecutor({ enabled: true, socket: "/tmp/cua-test.sock", runner: async (args) => {
    calls.push(args);
    if (args[0] === "--version") return { stdout: "cua-driver 0.22.1", stderr: "" };
    if (args[0] === "manifest") return { stdout: "{}", stderr: "" };
    if (args[0] === "list-tools") return { stdout: "click: Click\nget_desktop_state: Desktop", stderr: "" };
    if (args[0] === "permissions") return { stdout: JSON.stringify({ accessibility: "granted", screen_recording: "granted" }), stderr: "" };
    const screenshot = args.indexOf("--screenshot-out-file"); if (screenshot >= 0) await writeFile(args[screenshot + 1]!, Buffer.from("png-test"));
    return { stdout: JSON.stringify({ snapshot_id: "s1", elements: [] }), stderr: "" };
  } });
  const discovered = await executor.discover();
  assert.equal(discovered.capabilities[0]?.status, "READY");
  const events: any[] = [];
  for await (const event of executor.execute({ task_id: "t", attempt_id: "a", task_type: "computer.use", instruction: "observe", payload: { operation: "observe", session_id: "cs", sequence: 1, target: { kind: "desktop", display_id: "primary" }, session: { state: "ACTIVE", expires_at: Date.now() + 60_000, allowed_operations: ["observe"] } } }, { emit: async (event) => { events.push(event); } })) events.push(event);
  assert.equal(calls.at(-1)?.[1], "get_desktop_state");
  assert.equal(calls.at(-1)?.includes("--socket"), true);
  assert.equal(events.some((event) => event.type === "artifact" && event.artifact.media_type === "image/png"), true);
  assert.equal(events.at(-1)?.type, "result");
  await assert.rejects(async () => { for await (const _event of executor.execute({ task_id: "t", attempt_id: "b", task_type: "computer.use", instruction: "x", payload: { operation: "shell", session: { state: "ACTIVE", expires_at: Date.now() + 60_000, allowed_operations: ["shell"] } } }, { emit: async () => {} })) {} }, /CUA_OPERATION_UNSUPPORTED/);
});

test("CUA adapter binds opaque window refs and uses the installed driver coordinate contracts", async () => {
  const calls: string[][] = [];
  const executor = new CuaDriverExecutor({ enabled: true, mode: "cli", socket: "/tmp/cua-test.sock", runner: async (args) => {
    calls.push(args);
    if (args[0] === "--version") return { stdout: "cua-driver 0.22.1", stderr: "" };
    if (args[0] === "manifest") return { stdout: "{}", stderr: "" };
    if (args[0] === "list-tools") return { stdout: "list_windows: Windows\nclick: Click\ndrag: Drag\nget_window_state: State", stderr: "" };
    if (args[0] === "permissions") return { stdout: JSON.stringify({ accessibility: "granted", screen_recording: "granted" }), stderr: "" };
    const input = JSON.parse(args[2] ?? "{}");
    if (args[1] === "list_windows") return { stdout: JSON.stringify({ windows: [{ pid: 42, window_id: 7, app_name: "Editor", title: "Untitled" }] }), stderr: "" };
    return { stdout: JSON.stringify(input), stderr: "" };
  } });
  await executor.discover();
  const listEvents: any[] = [];
  for await (const event of executor.execute({ task_id: "t", attempt_id: "list", task_type: "computer.use", instruction: "list", payload: { operation: "list_windows", session_id: "cs", sequence: 1, session: { state: "ACTIVE", expires_at: Date.now() + 60_000, allowed_operations: ["list_windows", "drag"], allowed_apps: ["Editor"] } } }, { emit: async (event) => { listEvents.push(event); } })) listEvents.push(event);
  const windows = (listEvents.at(-1)?.result?.output?.windows ?? []) as Array<Record<string, any>>;
  assert.equal(typeof windows[0]?.window_ref, "string");
  const ref = windows[0].window_ref;
  for await (const _event of executor.execute({ task_id: "t", attempt_id: "drag", task_type: "computer.use", instruction: "drag", payload: { operation: "drag", session_id: "cs", sequence: 2, target: { kind: "window", window_ref: ref }, arguments: { x: 1, y: 2, to_x: 3, to_y: 4 }, session: { state: "ACTIVE", expires_at: Date.now() + 60_000, allowed_operations: ["list_windows", "drag"], allowed_apps: ["Editor"] } } }, { emit: async () => {} })) {}
  const drag = calls.at(-1)!; const dragInput = JSON.parse(drag[2] ?? "{}");
  assert.equal(drag[1], "drag"); assert.equal(dragInput.pid, 42); assert.equal(dragInput.window_id, 7); assert.equal(dragInput.from_x, 1); assert.equal(dragInput.from_y, 2); assert.equal(dragInput.to_x, 3); assert.equal(dragInput.to_y, 4); assert.equal("x" in dragInput, false);
});

test("computer sessions require a granted verified capability, serialize the desktop, and bind actions to fresh observations", () => {
  const now = Date.now(); const db = new ControlPlaneDatabase(":memory:"); const workers = new WorkerService(db);
  const registration = workers.register({ name: "CUA Worker", registrationSecret: "computer-use-secret-123", platform: "linux", hardware: {} }, now);
  const approved = workers.approveRegistration(registration.registrationId, "owner", now); const workerId = String(approved.workerId);
  workers.updateCapabilities(workerId, [{ capability: "computer.use", runtime: "cua-driver", status: "READY", evidence_state: "VERIFIED", verification_expires_at: now + 60_000, descriptor: { capability: "computer.use", runtime: "cua-driver", operations: ["observe", "click"] } }], now);
  const capabilityId = Number(db.one<{ id: number }>("SELECT id FROM worker_capabilities WHERE worker_id = ?", workerId)?.id); workers.grantCapability(workerId, capabilityId, "owner", now);
  const computers = new ComputerSessionService(db);
  const pending = computers.create({ principal: "owner", workerId, desktopId: "primary", desktopKind: "desktop", captureScope: "desktop", allowedOperations: ["observe", "click"] }, "session-key", now);
  assert.equal(pending.state, "PENDING_APPROVAL");
  const active = computers.approve(String(pending.id), String(pending.scopeHash), "owner", now);
  assert.equal(active.state, "ACTIVE");
  const observeInput: any = { taskType: "computer.use", payload: { operation: "observe", session_id: pending.id, sequence: 1 } , execution: {}, requestedBy: "owner" };
  const preparedObserve = computers.prepareTask(observeInput, "owner", now); const task = new TaskService(db, new EventHub(), { callbackEnabled: false }).create({ source: "hermes", title: "observe", taskType: "computer.use", instruction: "observe", context: {}, payload: preparedObserve.payload as any, execution: preparedObserve.execution as any, limits: { timeoutSeconds: 60, maxAttempts: 1 }, priority: "normal", inputArtifactIds: [] }, now); computers.recordOperation(String(pending.id), String(task.id), preparedObserve.payload as any, now);
  db.run("INSERT INTO computer_observations(id, session_id, sequence, target_json, expires_at, created_at) VALUES ('obs-1', ?, 1, '{}', ?, ?)", pending.id, now + 86_400_000, now);
  const preparedClick = computers.prepareTask({ taskType: "computer.use", payload: { operation: "click", session_id: pending.id, sequence: 2, observation_id: "obs-1" }, execution: {}, requestedBy: "owner" } as any, "owner", now);
  assert.equal((preparedClick.execution as any).workerId, workerId);
  assert.throws(() => computers.prepareTask({ taskType: "computer.use", payload: { operation: "click", session_id: pending.id, sequence: 2, observation_id: "obs-1", sensitive: true }, execution: {}, requestedBy: "owner" } as any, "owner", now), /APPROVAL_REQUIRED/);
  assert.throws(() => computers.prepareTask({ taskType: "computer.use", payload: { operation: "click", session_id: pending.id, sequence: 2, observation_id: "obs-1" }, execution: {} } as any, "owner", now + 11_000), /OBSERVATION_STALE/);
  const second = computers.create({ principal: "owner", workerId, desktopId: "primary", desktopKind: "desktop", captureScope: "desktop", allowedOperations: ["observe"] }, "session-key-2", now);
  assert.throws(() => computers.approve(String(second.id), String(second.scopeHash), "owner", now), /DESKTOP_BUSY/);
  const closing = computers.control(String(active.id), "close", Number(active.revision), "owner", now);
  assert.equal(closing.state, "CLOSING");
  const closed = computers.recordStopReceipt(String(active.id), workerId, "CONFIRMED", now);
  assert.equal(closed.state, "CLOSED"); assert.equal((closed.lock as any).state, "RELEASED");
  assert.equal(computers.approve(String(second.id), String(second.scopeHash), "owner", now).state, "ACTIVE");
  db.close();
});
