import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { ControlPlaneDatabase } from "../apps/control-plane/src/db/database.ts";
import { ComputerSessionService } from "../apps/control-plane/src/computers/computer-session-service.ts";
import { WorkerService } from "../apps/control-plane/src/workers/worker-service.ts";
import { CuaDriverExecutor } from "../apps/worker/src/executors/cua.ts";
import { EventHub } from "../apps/control-plane/src/events/event-hub.ts";
import { TaskService } from "../apps/control-plane/src/tasks/task-service.ts";

test("CUA executor invokes the allowlisted driver and accepts a persistent session without expiry", async () => {
  const calls: string[][] = [];
  const executor = new CuaDriverExecutor({ enabled: true, socket: "/tmp/cua-test.sock", platform: "darwin", runner: async (args) => {
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
  for await (const event of executor.execute({ task_id: "t", attempt_id: "a", task_type: "computer.use", instruction: "observe", payload: { operation: "observe", session_id: "cs", sequence: 1, target: { kind: "desktop", display_id: "primary" }, session: { state: "ACTIVE", persistent: true, expires_at: null, allowed_operations: ["observe"] } } }, { emit: async (event) => { events.push(event); } })) events.push(event);
  assert.equal(calls.at(-1)?.[1], "get_desktop_state");
  assert.equal(calls.at(-1)?.includes("--socket"), true);
  assert.equal(events.some((event) => event.type === "artifact" && event.artifact.media_type === "image/png"), true);
  assert.equal(events.at(-1)?.type, "result");
  await assert.rejects(async () => { for await (const _event of executor.execute({ task_id: "t", attempt_id: "b", task_type: "computer.use", instruction: "x", payload: { operation: "shell", session: { state: "ACTIVE", expires_at: Date.now() + 60_000, allowed_operations: ["shell"] } } }, { emit: async () => {} })) {} }, /CUA_OPERATION_UNSUPPORTED/);
});

test("CUA adapter binds opaque window refs and uses the installed driver coordinate contracts", async () => {
  const calls: string[][] = [];
  const executor = new CuaDriverExecutor({ enabled: true, mode: "cli", socket: "/tmp/cua-test.sock", platform: "darwin", runner: async (args) => {
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

test("CUA list_windows filters legacy and unidentified windows against the approved app scope", async () => {
  const executor = new CuaDriverExecutor({ enabled: true, mode: "cli", platform: "win32", runner: async (args) => {
    if (args[1] === "list_windows") return { stdout: JSON.stringify({ windows: [], _legacy_windows: [
      { pid: 10, window_id: 1, app_name: "Notepad", title: "Allowed window" },
      { pid: 11, window_id: 2, process_name: "C:\\Program Files\\Notepad\\notepad.exe", title: "Allowed by executable" },
      { pid: 12, window_id: 3, app_name: "Browser", title: "Out of scope" },
      { pid: 13, window_id: 4, title: "Identity unavailable" },
    ] }), stderr: "" };
    throw new Error(`unexpected driver call: ${args[1] ?? args[0]}`);
  } });
  const events: any[] = [];
  for await (const event of executor.execute({ task_id: "t", attempt_id: "scoped-list", task_type: "computer.use", instruction: "list scoped windows", payload: {
    operation: "list_windows", session_id: "cs", sequence: 1, target: { kind: "window" },
    session: { state: "ACTIVE", expires_at: Date.now() + 60_000, allowed_operations: ["list_windows"], allowed_apps: ["Notepad", "notepad.exe"], capture_scope: "window" },
  } }, { emit: async (event) => { events.push(event); } })) events.push(event);
  const output = events.at(-1)?.result?.output;
  assert.deepEqual(output?.windows, []);
  assert.deepEqual(output?._legacy_windows?.map((window: Record<string, unknown>) => window.title), ["Allowed window", "Allowed by executable"]);
  assert.doesNotMatch(JSON.stringify(output), /Out of scope|Identity unavailable/);
});

test("Windows CUA discovery verifies the interactive desktop without macOS TCC permissions", async () => {
  const calls: string[][] = [];
  const healthReport = {
    schema_version: "1", platform: "win32", driver_version: "0.28.2", overall: "ok",
    checks: [
      { name: "binary_version", status: "pass" },
      { name: "platform_supported", status: "pass" },
      { name: "session_active", status: "pass" },
      { name: "ax_capability", status: "pass" },
      { name: "screen_capture_capability", status: "pass" },
    ],
  };
  const executor = new CuaDriverExecutor({
    enabled: true, platform: "win32", mode: "cli", socket: "\\\\.\\pipe\\cua-driver",
    healthReportProbe: async () => healthReport,
    runner: async (args) => {
      calls.push(args);
      if (args[0] === "--version") return { stdout: "cua-driver 0.28.2", stderr: "" };
      if (args[0] === "manifest") return { stdout: "{}", stderr: "" };
      if (args[0] === "list-tools") return { stdout: "get_window_state: Observe\nlist_windows: List\nclick: Click", stderr: "" };
      if (args[0] === "doctor") return { stdout: JSON.stringify({ ok: true, probes: [
        { label: "interactive session", status: "ok", message: "session 1 attached" },
        { label: "UI Automation", status: "ok", message: "UIA available" },
        { label: "EnumWindows visible", status: "ok", message: "6 windows" },
      ] }), stderr: "" };
      throw new Error(`unexpected probe: ${args.join(" ")}`);
    },
  });

  const discovered = await executor.discover();
  assert.equal(discovered.capabilities[0]?.status, "READY");
  assert.equal(discovered.capabilities[0]?.evidence_state, "VERIFIED");
  assert.equal((discovered.capabilities[0]?.permissions as any)?.screen_recording, "not_applicable");
  assert.equal(calls.some((args) => args[0] === "permissions"), false);

  const lockedExecutor = new CuaDriverExecutor({
    enabled: true, platform: "win32", mode: "cli", socket: "\\\\.\\pipe\\cua-driver",
    healthReportProbe: async () => healthReport,
    runner: async (args) => {
      if (args[0] === "--version") return { stdout: "cua-driver 0.28.2", stderr: "" };
      if (args[0] === "manifest") return { stdout: "{}", stderr: "" };
      if (args[0] === "list-tools") return { stdout: "get_window_state: Observe", stderr: "" };
      if (args[0] === "doctor") return { stdout: JSON.stringify({ ok: true, probes: [
        { label: "interactive session", status: "warn", message: "desktop locked" },
        { label: "UI Automation", status: "ok", message: "UIA available" },
      ] }), stderr: "" };
      throw new Error(`unexpected probe: ${args.join(" ")}`);
    },
  });
  const locked = await lockedExecutor.discover();
  assert.equal(locked.capabilities[0]?.status, "DEGRADED");
  assert.equal(locked.capabilities[0]?.evidence_state, "ADVERTISED");
});

test("computer sessions start directly after capability Grant, persist until revoked, and bind actions to fresh observations", () => {
  const now = Date.now(); const db = new ControlPlaneDatabase(":memory:"); const workers = new WorkerService(db);
  const registration = workers.register({ name: "CUA Worker", registrationSecret: "computer-use-secret-123", platform: "linux", hardware: {} }, now);
  const approved = workers.approveRegistration(registration.registrationId, "owner", now); const workerId = String(approved.workerId);
  workers.updateCapabilities(workerId, [{ capability: "computer.use", runtime: "cua-driver", status: "READY", evidence_state: "VERIFIED", verification_expires_at: now + 60_000, descriptor: { capability: "computer.use", runtime: "cua-driver", operations: ["observe", "click"] } }], now);
  const capabilityId = Number(db.one<{ id: number }>("SELECT id FROM worker_capabilities WHERE worker_id = ?", workerId)?.id); workers.grantCapability(workerId, capabilityId, "owner", now);
  db.run("UPDATE workers SET status = 'ONLINE' WHERE id = ?", workerId);
  const computers = new ComputerSessionService(db);
  db.run("UPDATE workers SET drain = 1 WHERE id = ?", workerId);
  assert.throws(() => computers.create({ principal: "owner", workerId }, "session-key", now), /COMPUTER_WORKER_UNAVAILABLE/);
  db.run("UPDATE workers SET drain = 0 WHERE id = ?", workerId);
  const active = computers.create({ principal: "owner", workerId, desktopId: "primary", desktopKind: "desktop", captureScope: "desktop", allowedOperations: ["observe", "click"] }, "session-key", now);
  assert.equal(active.state, "ACTIVE");
  assert.equal(active.persistent, true);
  assert.equal(active.expiresAt, null);
  assert.equal(active.idleExpiresAt, null);
  assert.equal(active.maxActions, null);
  const reused = computers.create({ principal: "owner", workerId, desktopId: "primary", desktopKind: "desktop", captureScope: "desktop", allowedOperations: ["observe", "click"] }, "session-key-reuse", now + 1);
  assert.equal(reused.id, active.id);
  assert.equal(reused.reused, true);
  const observeInput: any = { taskType: "computer.use", payload: { operation: "observe", session_id: active.id, sequence: 1 } , execution: {}, requestedBy: "owner" };
  const preparedObserve = computers.prepareTask(observeInput, "owner", now); const task = new TaskService(db, new EventHub(), { callbackEnabled: false }).create({ source: "hermes", title: "observe", taskType: "computer.use", instruction: "observe", context: {}, payload: preparedObserve.payload as any, execution: preparedObserve.execution as any, limits: { timeoutSeconds: 60, maxAttempts: 1 }, priority: "normal", inputArtifactIds: [] }, now); computers.recordOperation(String(active.id), String(task.id), preparedObserve.payload as any, now);
  db.run("INSERT INTO computer_observations(id, session_id, sequence, target_json, expires_at, created_at) VALUES ('obs-1', ?, 1, '{}', ?, ?)", active.id, now + 86_400_000, now);
  db.run("UPDATE computer_sessions SET action_count = 100 WHERE id = ?", active.id);
  const preparedClick = computers.prepareTask({ taskType: "computer.use", payload: { operation: "click", session_id: active.id, sequence: 2, observation_id: "obs-1" }, execution: {}, requestedBy: "owner" } as any, "owner", now);
  assert.equal((preparedClick.execution as any).workerId, workerId);
  assert.throws(() => computers.prepareTask({ taskType: "computer.use", payload: { operation: "click", session_id: active.id, sequence: 2, observation_id: "obs-1", sensitive: true }, execution: {}, requestedBy: "owner" } as any, "owner", now), /APPROVAL_REQUIRED/);
  assert.throws(() => computers.prepareTask({ taskType: "computer.use", payload: { operation: "click", session_id: active.id, sequence: 2, observation_id: "obs-1" }, execution: {} } as any, "owner", now + 11_000), /OBSERVATION_STALE/);
  assert.throws(() => computers.create({ principal: "owner", workerId, desktopId: "primary", desktopKind: "desktop", captureScope: "desktop", allowedOperations: ["observe"] }, "session-key-2", now), /DESKTOP_BUSY/);
  assert.equal(computers.get(String(active.id), now + 365 * 86_400_000)?.state, "ACTIVE");
  const closing = computers.control(String(active.id), "close", Number(active.revision), "owner", now);
  assert.equal(closing.state, "CLOSING");
  const closed = computers.recordStopReceipt(String(active.id), workerId, "CONFIRMED", now);
  assert.equal(closed.state, "CLOSED"); assert.equal((closed.lock as any).state, "RELEASED");
  const second = computers.create({ principal: "owner", workerId, desktopId: "primary", desktopKind: "desktop", captureScope: "desktop", allowedOperations: ["observe"] }, "session-key-2", now);
  assert.equal(second.state, "ACTIVE");
  assert.equal(computers.listSessions("owner").length, 2);
  const deleted = computers.deleteSession(String(second.id), Number(second.revision), "owner", now + 1);
  assert.equal(deleted.state, "REVOKED");
  assert.ok(deleted.deletedAt);
  assert.equal((deleted.lock as any).state, "UNKNOWN");
  assert.equal(computers.listSessions("owner").some((item) => item.id === second.id), true);
  assert.throws(() => computers.prepareTask({ taskType: "computer.use", payload: { operation: "observe", session_id: second.id, sequence: 1 }, execution: {} } as any, "owner", now + 2), /SESSION_NOT_ACTIVE/);
  computers.recordStopReceipt(String(second.id), workerId, "CONFIRMED", now + 3);
  assert.equal(computers.listSessions("owner").some((item) => item.id === second.id), false);
  assert.equal(computers.get(String(second.id), now + 4)?.state, "REVOKED");
  db.close();
});
