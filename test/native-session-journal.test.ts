import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkerLocalDatabase } from "../apps/worker/src/local-db.ts";
import { NativeSessionJournal } from "../apps/worker/src/native-session-journal.ts";

const sha = `sha256:${"a".repeat(64)}`;
const binding = {
  taskId: "task-native-1",
  attemptId: "attempt-native-1",
  runtime: "opencode" as const,
  nativeSessionId: "native-session-local-1",
  workspaceId: "workspace-1",
  fenceEpoch: 3,
  branch: "feature/resumable-work",
  baselineSha: "b".repeat(40),
};

test("native session journal binds only supported runtimes and enforces immutable attempt ownership", () => {
  const db = new WorkerLocalDatabase(":memory:");
  const journal = new NativeSessionJournal(db, () => 1_800_000_000_000);
  const first = journal.bind(binding);
  assert.equal(first.state, "BOUND");
  assert.equal(first.nativeSessionId, binding.nativeSessionId);
  assert.deepEqual(journal.bind(binding), first);
  assert.throws(() => journal.bind({ ...binding, nativeSessionId: "other-session" }), /NATIVE_SESSION_BINDING_CONFLICT/);
  assert.throws(() => journal.bind({ ...binding, fenceEpoch: 4 }), /NATIVE_SESSION_BINDING_CONFLICT/);
  assert.throws(() => journal.bind({ ...binding, runtime: "unsupported" as any }), /NATIVE_SESSION_INVALID_RUNTIME/);
  assert.throws(() => journal.bind({ ...binding, fenceEpoch: 0 }), /NATIVE_SESSION_INVALID_FENCEEPOCH/);
  db.close();
});

test("checkpoint writes are fenced, compare-and-set, monotonic, and accept only bounded metadata", () => {
  const db = new WorkerLocalDatabase(":memory:");
  let now = 1_800_000_000_000;
  const journal = new NativeSessionJournal(db, () => now);
  const first = journal.bind(binding);
  const running = journal.recordCheckpoint({
    attemptId: binding.attemptId,
    fenceEpoch: binding.fenceEpoch,
    expectedUpdatedAt: first.updatedAt,
    phase: "RUNNING",
    lastHeadSha: "c".repeat(40),
    // Extra runtime fields are intentionally ignored; arbitrary checkpoint JSON is not part of this API.
    rawPrompt: "provider-token=do-not-persist",
  } as any);
  assert.equal(running.state, "RUNNING");
  assert.equal(running.lastHeadSha, "c".repeat(40));
  assert.ok(running.updatedAt > first.updatedAt);
  const stored = db.connection.prepare("SELECT checkpoint_json FROM native_session_journal WHERE attempt_id = ?").get(binding.attemptId) as { checkpoint_json: string };
  assert.deepEqual(JSON.parse(stored.checkpoint_json), { schema_version: 1, phase: "RUNNING", observed_at: running.updatedAt });
  assert.equal(stored.checkpoint_json.includes("provider-token"), false);
  assert.throws(() => journal.recordCheckpoint({ attemptId: binding.attemptId, fenceEpoch: binding.fenceEpoch, expectedUpdatedAt: first.updatedAt, phase: "QUOTA_BLOCKED" }), /NATIVE_SESSION_STALE_CHECKPOINT/);
  assert.throws(() => journal.recordCheckpoint({ attemptId: binding.attemptId, fenceEpoch: binding.fenceEpoch + 1, expectedUpdatedAt: running.updatedAt, phase: "QUOTA_BLOCKED" }), /NATIVE_SESSION_FENCE_CONFLICT/);

  now += 1;
  const blocked = journal.recordCheckpoint({ attemptId: binding.attemptId, fenceEpoch: binding.fenceEpoch, expectedUpdatedAt: running.updatedAt, phase: "QUOTA_BLOCKED" });
  assert.equal(blocked.state, "QUOTA_BLOCKED");
  assert.throws(() => journal.recordCheckpoint({ attemptId: binding.attemptId, fenceEpoch: binding.fenceEpoch, expectedUpdatedAt: blocked.updatedAt, phase: "RUNNING" }), /NATIVE_SESSION_TERMINAL_STATE/);
  db.close();
});

test("unsupported resume requests are durably idempotent but never authorized for dispatch", () => {
  const db = new WorkerLocalDatabase(":memory:");
  const journal = new NativeSessionJournal(db, () => 1_800_000_000_100);
  journal.bind(binding);
  const request = { operationKey: "resume-op-1", attemptId: binding.attemptId, nativeSessionId: binding.nativeSessionId, fenceEpoch: binding.fenceEpoch, requestHash: sha };
  const result = journal.recordUnsupportedResume(request);
  assert.deepEqual(result, {
    operationKey: request.operationKey,
    attemptId: request.attemptId,
    state: "UNSUPPORTED",
    nativeMessageId: null,
    requestHash: sha,
    createdAt: 1_800_000_000_100,
    updatedAt: 1_800_000_000_100,
    dispatchAllowed: false,
    reason: "NATIVE_RESUME_UNSUPPORTED",
  });
  assert.equal("nativeSessionId" in result, false);
  assert.deepEqual(journal.recordUnsupportedResume(request), result);
  const stored = db.connection.prepare("SELECT state, native_message_id, native_session_id, request_hash FROM native_resume_operations WHERE operation_key = ?").get(request.operationKey) as Record<string, unknown>;
  assert.deepEqual({ ...stored }, { state: "UNSUPPORTED", native_message_id: null, native_session_id: binding.nativeSessionId, request_hash: sha });
  assert.throws(() => journal.recordUnsupportedResume({ ...request, requestHash: `sha256:${"d".repeat(64)}` }), /NATIVE_RESUME_OPERATION_CONFLICT/);
  assert.throws(() => journal.recordUnsupportedResume({ ...request, operationKey: "resume-op-2" }), /NATIVE_RESUME_OPERATION_ALREADY_RECORDED/);
  assert.equal(db.connection.prepare("SELECT COUNT(*) AS count FROM native_resume_operations").get()?.count, 1);
  db.close();
});

test("resume journal requires the current local binding and a valid opaque request digest", () => {
  const db = new WorkerLocalDatabase(":memory:");
  const journal = new NativeSessionJournal(db);
  assert.throws(() => journal.recordUnsupportedResume({ operationKey: "op", attemptId: binding.attemptId, nativeSessionId: binding.nativeSessionId, fenceEpoch: binding.fenceEpoch, requestHash: sha }), /NATIVE_SESSION_NOT_FOUND/);
  journal.bind(binding);
  assert.throws(() => journal.recordUnsupportedResume({ operationKey: "op", attemptId: binding.attemptId, nativeSessionId: "another-session", fenceEpoch: binding.fenceEpoch, requestHash: sha }), /NATIVE_SESSION_FENCE_CONFLICT/);
  assert.throws(() => journal.recordUnsupportedResume({ operationKey: "op", attemptId: binding.attemptId, nativeSessionId: binding.nativeSessionId, fenceEpoch: binding.fenceEpoch, requestHash: "raw prompt" }), /NATIVE_SESSION_INVALID_REQUEST_HASH/);
  db.close();
});

test("native session and denied resume journals survive Worker database reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pai-native-session-journal-"));
  const path = join(directory, "worker.db");
  try {
    const firstDb = new WorkerLocalDatabase(path);
    const firstJournal = new NativeSessionJournal(firstDb, () => 1_800_000_000_100);
    firstJournal.bind(binding);
    firstJournal.recordUnsupportedResume({ operationKey: "resume-op-durable", attemptId: binding.attemptId, nativeSessionId: binding.nativeSessionId, fenceEpoch: binding.fenceEpoch, requestHash: sha });
    firstDb.close();

    const secondDb = new WorkerLocalDatabase(path);
    const secondJournal = new NativeSessionJournal(secondDb);
    assert.equal(secondJournal.getByAttempt(binding.attemptId)?.nativeSessionId, binding.nativeSessionId);
    const resumed = secondJournal.recordUnsupportedResume({ operationKey: "resume-op-durable", attemptId: binding.attemptId, nativeSessionId: binding.nativeSessionId, fenceEpoch: binding.fenceEpoch, requestHash: sha });
    assert.equal(resumed.state, "UNSUPPORTED");
    assert.equal(resumed.dispatchAllowed, false);
    secondDb.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
