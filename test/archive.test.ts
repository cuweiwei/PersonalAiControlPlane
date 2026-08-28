import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { ArchiveDatabase } from "../apps/archive/src/db.ts";
import { ArchiveService, type NormalizedEnvelope } from "../apps/archive/src/service.ts";
import { canonicalJson, sha256 } from "../packages/crypto/src/index.ts";
import { ContentAddressedArtifactStore } from "../packages/artifacts/src/index.ts";
import { CredentialBroker, credentialHandleUri, parseCredentialHandleUri } from "../packages/credentials/src/index.ts";

function envelope(text = "hello"): NormalizedEnvelope {
  const unsigned = { schemaVersion: 1 as const, source: "test", externalAccountHandle: "credential://device-vault/test/acct", conversation: { externalId: "thread-1", title: null, scope: ["personal"] }, message: { externalId: "message-1", revision: "1", role: "user", sentAt: "2026-08-28T00:00:00.000Z", content: { format: "text/plain", text } }, provenance: { connectorId: "test", observedAt: "2026-08-28T00:00:00.000Z" } };
  return { ...unsigned, checksum: sha256(canonicalJson(unsigned as never)) };
}

test("archive ingestion is idempotent and conflicts on same identity with changed content", () => {
  const db = new ArchiveDatabase(":memory:");
  const service = new ArchiveService(db, () => 1_700_000_000_000);
  const policy = { globalDays: null };
  assert.equal(service.ingest(envelope(), policy).status, "INSERTED");
  assert.equal(service.ingest(envelope(), policy).status, "DUPLICATE");
  assert.equal(service.ingest(envelope("changed"), policy).status, "CONFLICT");
  assert.equal(db.one<{ expires_at: number | null }>("SELECT expires_at FROM messages LIMIT 1")?.expires_at, null);
  db.close();
});

test("archive retention precedence, pressure controls, and verified purge are explicit", () => {
  const db = new ArchiveDatabase(":memory:");
  const service = new ArchiveService(db, () => 1_700_000_000_000);
  const inserted = service.ingest(envelope(), { ownerOverrideDays: 1, sourceRules: [{ source: "test", days: 30 }], globalDays: 90 });
  assert.equal(db.one<{ expires_at: number }>("SELECT expires_at FROM messages WHERE id = ?", inserted.messageId)?.expires_at, Date.parse("2026-08-28T00:00:00.000Z") + 86_400_000);
  assert.equal(service.storagePressureAction(5, 10, 20), "NORMAL");
  assert.equal(service.storagePressureAction(10, 10, 20), "REDUCE_OPTIONAL");
  assert.equal(service.storagePressureAction(20, 10, 20), "STOP_OPTIONAL_WRITES");
  const tombstone = service.requestPurge(inserted.conversationId, "owner", "requested");
  assert.equal(service.purge(tombstone).status, "VERIFIED");
  assert.equal(db.one<{ count: number }>("SELECT COUNT(*) AS count FROM messages")?.count, 0);
  db.close();
});

test("artifact store writes content-addressed immutable bytes and credential broker exposes only metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "pai-artifact-"));
  const store = new ContentAddressedArtifactStore(root);
  const artifact = store.put(Buffer.from("artifact"), { maxBytes: 100, mediaType: "text/plain" });
  assert.equal(store.has(artifact.digest), true);
  assert.equal(readFileSync(artifact.path, "utf8"), "artifact");
  assert.throws(() => store.put(Buffer.alloc(101), { maxBytes: 100, mediaType: "application/octet-stream" }), /size limit/);
  const broker = new CredentialBroker((handle) => ({ available: true, withSecret: <T>(callback: (secret: string) => T) => callback("secret-value") }));
  const view = broker.register({ alias: "test", storageClass: "device-vault", adapter: "test", purpose: "unit", scopes: ["read"], health: "HEALTHY", expiresAt: null });
  assert.equal("secret-value" in view, false);
  assert.deepEqual(parseCredentialHandleUri(credentialHandleUri({ ...view })), { storageClass: "device-vault", adapter: "test", opaqueId: view.id });
  const lease = broker.lease(view.id, { purpose: "unit", adapter: "test", ttlMs: 1000, now: 1_700_000_000_000 });
  assert.equal(broker.withLeaseSecret(lease.id, (secret) => secret.length, 1_700_000_000_001), 12);
  lease.release();
  assert.throws(() => broker.withLeaseSecret(lease.id, () => "nope", 1_700_000_000_001), /expired/);
});
