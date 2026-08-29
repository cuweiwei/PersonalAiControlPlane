import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArchiveDatabase } from "../apps/archive/src/db.ts";
import { ArchiveBackgroundRuntime } from "../apps/archive/src/runtime.ts";
import { ArchiveService, type NormalizedEnvelope } from "../apps/archive/src/service.ts";
import { ContentAddressedArtifactStore } from "../packages/artifacts/src/index.ts";
import { canonicalJson, sha256 } from "../packages/crypto/src/index.ts";

function envelope(attachmentHash?: string): NormalizedEnvelope {
  const unsigned = {
    schemaVersion: 1 as const,
    source: "web",
    externalAccountHandle: "owner",
    conversation: { externalId: "thread", title: "Archive job", scope: ["personal"] },
    message: { externalId: "message", revision: "1", role: "user", sentAt: "2026-08-28T00:00:00.000Z", content: { format: "text/plain", text: "durable content" }, ...(attachmentHash ? { attachments: [{ contentHash: attachmentHash, mediaType: "text/plain", size: 10, artifactRef: attachmentHash }] } : {}) },
    provenance: { connector: "test" },
  };
  return { ...unsigned, checksum: sha256(canonicalJson(unsigned)) };
}

test("archive export and purge are durable jobs with content-addressed results and absence proof", () => {
  let now = 1_700_000_000_000;
  const db = new ArchiveDatabase(":memory:");
  const store = new ContentAddressedArtifactStore(join(mkdtempSync(join(tmpdir(), "pai-archive-runtime-")), "artifacts"));
  const attachment = store.put(Buffer.from("attachment"), { maxBytes: 100, mediaType: "text/plain" });
  const service = new ArchiveService(db, () => now, (digests) => {
    const removable = digests.filter((digest) => !db.one("SELECT 1 AS value FROM artifact_references WHERE artifact_hash = ? AND released_at IS NULL", digest));
    const removed = store.sweep(removable, 0, Date.now() + 1_000);
    return { removed, remaining: digests.filter((digest) => store.has(digest)) };
  });
  const inserted = service.ingest(envelope(attachment.digest), { globalDays: null });
  const runtime = new ArchiveBackgroundRuntime(db, service, store, () => now);

  const exportId = service.requestExport(inserted.conversationId, "owner", "export-1");
  assert.equal(service.getJob(exportId)?.status, "REQUESTED");
  assert.equal(runtime.runOnce(), 1);
  const completedExport = service.getJob(exportId)!;
  assert.equal(completedExport.status, "COMPLETED");
  assert.ok(completedExport.artifactHash && store.has(completedExport.artifactHash));
  assert.equal(service.requestExport(inserted.conversationId, "owner", "export-1"), exportId);

  const purgeId = service.requestPurge(inserted.conversationId, "owner", "owner deletion", true, "purge-1");
  assert.throws(() => service.requestExport(inserted.conversationId, "owner", "blocked"), /blocked/);
  now += 1;
  assert.equal(runtime.runOnce(), 1);
  assert.equal(service.getJob(purgeId)?.status, "VERIFIED");
  assert.equal(store.has(attachment.digest), false);
  assert.equal(service.getConversation(inserted.conversationId)?.messageCount, 0);
  assert.equal(service.requestPurge(inserted.conversationId, "owner", "owner deletion", true, "purge-1"), purgeId);
  db.close();
});

test("archive export fails closed without an artifact authority and remains retryable", () => {
  let now = 1_700_000_000_000;
  const db = new ArchiveDatabase(":memory:");
  const service = new ArchiveService(db, () => now);
  const conversationId = service.ingest(envelope(), { globalDays: null }).conversationId;
  const exportId = service.requestExport(conversationId, "owner", "export-no-artifacts");
  const runtime = new ArchiveBackgroundRuntime(db, service, undefined, () => now);
  runtime.runOnce();
  assert.equal(service.getJob(exportId)?.status, "FAILED");
  assert.equal(service.getJob(exportId)?.errorCode, "ARTIFACT_AUTHORITY_UNAVAILABLE");
  assert.equal(db.one<{ delivered_at: number | null }>("SELECT delivered_at FROM archive_outbox WHERE aggregate_id = ?", exportId)?.delivered_at, null);
  now += 1_001;
  assert.equal(runtime.runOnce(), 1);
  db.close();
});
