import { canonicalJson, sha256, uuidv7, type JsonValue } from "../../../packages/crypto/src/index.ts";
import { ArchiveDatabase } from "./db.ts";

export type RetentionRule = { source?: string; scope?: string; days: number | null };
export type RetentionPolicy = { ownerOverrideDays?: number | null; sourceRules?: RetentionRule[]; scopeRules?: RetentionRule[]; globalDays: number | null };

export type NormalizedEnvelope = {
  schemaVersion: 1;
  source: string;
  externalAccountHandle: string;
  conversation: { externalId: string; title: string | null; scope: string[] };
  message: { externalId: string; revision: string; role: string; sentAt: string | null; content: { format: string; text: string }; attachments?: Array<{ contentHash: string; mediaType: string; size: number; artifactRef: string }> };
  provenance: Record<string, JsonValue>;
  checksum: string;
};

export type IngestResult = { status: "INSERTED" | "DUPLICATE" | "CONFLICT"; conversationId: string; messageId?: string };
export type ArchiveExport = { schemaVersion: 1; conversationId: string; generatedAt: string; messages: Array<{ id: string; externalId: string; revision: string; checksum: string; sentAt: string | null; provenance: Record<string, JsonValue>; expiresAt: number | null }>; manifestHash: string };
export type ConversationSummary = { id: string; source: string; externalAccountHandle: string; externalThreadId: string; title: string | null; scope: string[]; messageCount: number; deletionStatus: string | null; createdAt: string; updatedAt: string };
export type ConversationDetail = ConversationSummary & { messages: Array<{ id: string; externalId: string; revision: string; role: string; sentAt: string | null; content: { format: string; text: string }; checksum: string; provenance: Record<string, JsonValue>; expiresAt: number | null; attachments: Array<{ contentHash: string; mediaType: string; size: number; artifactRef: string; expiresAt: number | null }> }> };
export type ArtifactPurgePort = (digests: readonly string[]) => { removed: readonly string[]; remaining: readonly string[] };
export type ArchiveJob = { id: string; kind: "EXPORT" | "PURGE"; conversationId: string; status: string; artifactHash: string | null; manifest: Record<string, unknown> | null; errorCode: string | null; createdAt: string; updatedAt: string };

function expiry(sentAt: number | null, policy: RetentionPolicy, envelope: NormalizedEnvelope, now: number): number | null {
  let days: number | null | undefined = policy.ownerOverrideDays;
  if (days === undefined) days = policy.sourceRules?.find((rule) => rule.source === envelope.source)?.days;
  if (days === undefined) {
    const matching = (policy.scopeRules ?? []).filter((rule) => rule.scope && envelope.conversation.scope.includes(rule.scope));
    if (matching.length === 1) days = matching[0].days;
  }
  if (days === undefined) days = policy.globalDays;
  if (days === null || days === undefined) return null;
  if (!Number.isInteger(days) || days < 0) throw new Error("retention days must be null or a non-negative integer");
  return (sentAt ?? now) + days * 86_400_000;
}

export function calculateRetentionExpiry(sentAt: number | null, policy: RetentionPolicy, envelope: NormalizedEnvelope, now: number): number | null { return expiry(sentAt, policy, envelope, now); }

export class ArchiveService {
  private readonly db: ArchiveDatabase;
  private readonly clock: () => number;
  private readonly purgeArtifacts?: ArtifactPurgePort;
  constructor(db: ArchiveDatabase, clock: () => number = Date.now, purgeArtifacts?: ArtifactPurgePort) { this.db = db; this.clock = clock; this.purgeArtifacts = purgeArtifacts; }

  listConversations(limit = 100): ConversationSummary[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("conversation limit must be 1..100");
    return this.db.all<Record<string, unknown>>(`
      SELECT c.*, COUNT(m.id) AS message_count,
        (SELECT status FROM conversation_tombstones t WHERE t.target_type = 'conversation' AND t.target_id = c.id ORDER BY t.requested_at DESC LIMIT 1) AS deletion_status
      FROM conversations c
      LEFT JOIN messages m ON m.conversation_id = c.id
      GROUP BY c.id
      ORDER BY c.updated_at DESC, c.id DESC
      LIMIT ?
    `, limit).map((row) => this.conversationSummary(row));
  }

  getConversation(conversationId: string): ConversationDetail | undefined {
    const row = this.db.one<Record<string, unknown>>(`
      SELECT c.*, COUNT(m.id) AS message_count,
        (SELECT status FROM conversation_tombstones t WHERE t.target_type = 'conversation' AND t.target_id = c.id ORDER BY t.requested_at DESC LIMIT 1) AS deletion_status
      FROM conversations c
      LEFT JOIN messages m ON m.conversation_id = c.id
      WHERE c.id = ?
      GROUP BY c.id
    `, conversationId);
    if (!row) return undefined;
    const messages = this.db.all<Record<string, unknown>>("SELECT * FROM messages WHERE conversation_id = ? ORDER BY sent_at, id", conversationId).map((message) => ({
      id: String(message.id),
      externalId: String(message.external_message_id),
      revision: String(message.revision),
      role: String(message.role),
      sentAt: message.sent_at === null ? null : new Date(Number(message.sent_at)).toISOString(),
      content: JSON.parse(String(message.normalized_content_json)) as { format: string; text: string },
      checksum: String(message.checksum),
      provenance: JSON.parse(String(message.provenance_json)) as Record<string, JsonValue>,
      expiresAt: message.expires_at === null ? null : Number(message.expires_at),
      attachments: this.db.all<Record<string, unknown>>("SELECT content_hash, media_type, size, artifact_ref, expires_at FROM attachments WHERE message_id = ? ORDER BY id", message.id).map((attachment) => ({
        contentHash: String(attachment.content_hash),
        mediaType: String(attachment.media_type),
        size: Number(attachment.size),
        artifactRef: String(attachment.artifact_ref),
        expiresAt: attachment.expires_at === null ? null : Number(attachment.expires_at),
      })),
    }));
    return { ...this.conversationSummary(row), messages };
  }

  private conversationSummary(row: Record<string, unknown>): ConversationSummary {
    return {
      id: String(row.id),
      source: String(row.source),
      externalAccountHandle: String(row.external_account_handle),
      externalThreadId: String(row.external_thread_id),
      title: row.title === null ? null : String(row.title),
      scope: JSON.parse(String(row.scope_json)) as string[],
      messageCount: Number(row.message_count),
      deletionStatus: row.deletion_status === null ? null : String(row.deletion_status),
      createdAt: new Date(Number(row.created_at)).toISOString(),
      updatedAt: new Date(Number(row.updated_at)).toISOString(),
    };
  }

  ingest(envelope: NormalizedEnvelope, policy: RetentionPolicy): IngestResult {
    if (envelope.schemaVersion !== 1 || !envelope.source || !envelope.externalAccountHandle || !envelope.conversation?.externalId || !envelope.message?.externalId || !envelope.message.revision || !envelope.message.content?.format || typeof envelope.message.content.text !== "string" || !envelope.message.role) throw new Error("normalized envelope is invalid");
    if (envelope.message.sentAt !== null && (!envelope.message.sentAt || !Number.isFinite(Date.parse(envelope.message.sentAt)))) throw new Error("message sentAt is invalid");
    for (const attachment of envelope.message.attachments ?? []) {
      if (!/^sha256:[0-9a-f]{64}$/.test(attachment.contentHash) || !attachment.mediaType || !Number.isInteger(attachment.size) || attachment.size < 0 || !attachment.artifactRef) throw new Error("attachment metadata is invalid");
    }
    const { checksum: _checksum, ...unsignedEnvelope } = envelope;
    const expectedChecksum = sha256(canonicalJson(unsignedEnvelope as never));
    if (envelope.checksum !== expectedChecksum) throw new Error("normalized envelope checksum mismatch");
    const now = this.clock();
    const blocked = this.db.one("SELECT id FROM conversation_tombstones WHERE target_type = 'conversation' AND target_id IN (SELECT id FROM conversations WHERE source = ? AND external_account_handle = ? AND external_thread_id = ?) AND block_future = 1 AND status IN ('PURGING', 'VERIFIED')", envelope.source, envelope.externalAccountHandle, envelope.conversation.externalId);
    if (blocked) throw new Error("conversation is blocked for future ingestion");
    return this.db.transaction(() => {
      let conversation = this.db.one<{ id: string }>("SELECT id FROM conversations WHERE source = ? AND external_account_handle = ? AND external_thread_id = ?", envelope.source, envelope.externalAccountHandle, envelope.conversation.externalId);
      const conversationId = conversation?.id ?? uuidv7(now);
      if (!conversation) {
        this.db.run("INSERT INTO conversations(id, source, external_account_handle, external_thread_id, title, scope_json, effective_retention, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", conversationId, envelope.source, envelope.externalAccountHandle, envelope.conversation.externalId, envelope.conversation.title, JSON.stringify(envelope.conversation.scope), policy.ownerOverrideDays === undefined ? "policy" : String(policy.ownerOverrideDays), now, now);
      }
      const existing = this.db.one<{ id: string; checksum: string }>("SELECT id, checksum FROM messages WHERE conversation_id = ? AND external_message_id = ? AND revision = ?", conversationId, envelope.message.externalId, envelope.message.revision);
      if (existing) return { status: existing.checksum === envelope.checksum ? "DUPLICATE" : "CONFLICT", conversationId, messageId: existing.id };
      const messageId = uuidv7(now);
      const sentAt = envelope.message.sentAt ? Date.parse(envelope.message.sentAt) : null;
      const expiresAt = expiry(sentAt, policy, envelope, now);
      this.db.run("INSERT INTO messages(id, conversation_id, external_message_id, revision, role, sent_at, normalized_content_json, format, checksum, provenance_json, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", messageId, conversationId, envelope.message.externalId, envelope.message.revision, envelope.message.role, sentAt, JSON.stringify(envelope.message.content), envelope.message.content.format, envelope.checksum, JSON.stringify(envelope.provenance), expiresAt, now);
      for (const attachment of envelope.message.attachments ?? []) {
        const attachmentId = uuidv7(now);
        this.db.run("INSERT INTO attachments(id, message_id, content_hash, media_type, size, artifact_ref, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)", attachmentId, messageId, attachment.contentHash, attachment.mediaType, attachment.size, attachment.artifactRef, expiresAt);
        this.db.run("INSERT OR IGNORE INTO artifact_references(owner_type, owner_id, artifact_hash, purpose, created_at) VALUES ('conversation', ?, ?, 'attachment', ?)", conversationId, attachment.contentHash, now);
      }
      this.db.run("UPDATE conversations SET updated_at = ? WHERE id = ?", now, conversationId);
      this.db.run("INSERT INTO archive_outbox(id, topic, aggregate_id, dedupe_key, payload_json, available_at) VALUES (?, 'conversation.extract.requested', ?, ?, ?, ?)", uuidv7(now), conversationId, `conversation.message:${conversationId}:${envelope.message.externalId}:${envelope.message.revision}`, JSON.stringify({ conversationId, messageId }), now);
      return { status: "INSERTED", conversationId, messageId };
    });
  }

  requestExport(conversationId: string, requestedBy: string, idempotencyKey: string): string {
    if (!conversationId || !requestedBy || !idempotencyKey || !this.db.one("SELECT id FROM conversations WHERE id = ?", conversationId)) throw new Error("conversation is unavailable");
    const blocked = this.db.one("SELECT id FROM conversation_tombstones WHERE target_id = ? AND status IN ('REQUESTED', 'PURGING', 'VERIFIED')", conversationId);
    if (blocked) throw new Error("conversation export is blocked by deletion state");
    const existing = this.db.one<{ id: string; conversation_id: string }>("SELECT id, conversation_id FROM conversation_exports WHERE requested_by = ? AND idempotency_key = ?", requestedBy, idempotencyKey);
    if (existing) {
      if (existing.conversation_id !== conversationId) throw new Error("archive idempotency conflict");
      return existing.id;
    }
    const now = this.clock(); const id = uuidv7(now);
    this.db.transaction(() => {
      this.db.run("INSERT INTO conversation_exports(id, conversation_id, requested_by, idempotency_key, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'REQUESTED', ?, ?)", id, conversationId, requestedBy, idempotencyKey, now, now);
      this.db.run("INSERT INTO archive_outbox(id, topic, aggregate_id, dedupe_key, payload_json, available_at) VALUES (?, 'conversation.export.requested', ?, ?, ?, ?)", uuidv7(now), id, `conversation.export.requested:${id}`, JSON.stringify({ exportId: id, conversationId }), now);
    });
    return id;
  }

  requestPurge(conversationId: string, requestedBy: string, reason: string, blockFuture = false, idempotencyKey?: string): string {
    const now = this.clock();
    if (!conversationId || !requestedBy || !reason || !this.db.one("SELECT id FROM conversations WHERE id = ?", conversationId)) throw new Error("conversation is unavailable");
    if (idempotencyKey) {
      const existing = this.db.one<{ id: string; target_id: string }>("SELECT id, target_id FROM conversation_tombstones WHERE requested_by = ? AND idempotency_key = ?", requestedBy, idempotencyKey);
      if (existing) { if (existing.target_id !== conversationId) throw new Error("archive idempotency conflict"); return existing.id; }
    }
    const id = uuidv7(now);
    this.db.transaction(() => {
      this.db.run("INSERT INTO conversation_tombstones(id, target_type, target_id, requested_by, idempotency_key, requested_at, reason, block_future, status) VALUES (?, 'conversation', ?, ?, ?, ?, ?, ?, 'REQUESTED')", id, conversationId, requestedBy, idempotencyKey ?? null, now, reason, blockFuture ? 1 : 0);
      this.db.run("INSERT INTO archive_outbox(id, topic, aggregate_id, dedupe_key, payload_json, available_at) VALUES (?, 'conversation.purge.requested', ?, ?, ?, ?)", uuidv7(now), id, `conversation.purge.requested:${id}`, JSON.stringify({ tombstoneId: id, conversationId }), now);
    });
    return id;
  }

  getJob(id: string): ArchiveJob | undefined {
    const exported = this.db.one<Record<string, unknown>>("SELECT * FROM conversation_exports WHERE id = ?", id);
    if (exported) return { id, kind: "EXPORT", conversationId: String(exported.conversation_id), status: String(exported.status), artifactHash: exported.artifact_hash === null ? null : String(exported.artifact_hash), manifest: exported.manifest_json === null ? null : JSON.parse(String(exported.manifest_json)), errorCode: exported.error_code === null ? null : String(exported.error_code), createdAt: new Date(Number(exported.created_at)).toISOString(), updatedAt: new Date(Number(exported.updated_at)).toISOString() };
    const purge = this.db.one<Record<string, unknown>>("SELECT * FROM conversation_tombstones WHERE id = ?", id);
    return purge ? { id, kind: "PURGE", conversationId: String(purge.target_id), status: String(purge.status), artifactHash: null, manifest: purge.purge_manifest_hash === null ? null : { manifestHash: String(purge.purge_manifest_hash) }, errorCode: purge.status === "FAILED" ? "PURGE_VERIFICATION_FAILED" : null, createdAt: new Date(Number(purge.requested_at)).toISOString(), updatedAt: new Date(Number(purge.completed_at ?? purge.requested_at)).toISOString() } : undefined;
  }

  exportConversation(conversationId: string): ArchiveExport {
    const now = this.clock();
    if (!this.db.one("SELECT id FROM conversations WHERE id = ?", conversationId)) throw new Error("conversation is unavailable");
    const rows = this.db.all<Record<string, unknown>>("SELECT id, external_message_id, revision, checksum, sent_at, provenance_json, expires_at FROM messages WHERE conversation_id = ? ORDER BY sent_at, id", conversationId);
    const messages = rows.map((row) => ({ id: String(row.id), externalId: String(row.external_message_id), revision: String(row.revision), checksum: String(row.checksum), sentAt: row.sent_at === null ? null : new Date(Number(row.sent_at)).toISOString(), provenance: JSON.parse(String(row.provenance_json)), expiresAt: row.expires_at === null ? null : Number(row.expires_at) }));
    const unsigned = { schemaVersion: 1 as const, conversationId, generatedAt: new Date(now).toISOString(), messages };
    return { ...unsigned, manifestHash: sha256(canonicalJson(unsigned as never)) };
  }

  recordExtraction(input: { conversationId: string; messageStartId?: string | null; messageEndId?: string | null; extractorVersion: string; inputDigest: string; candidateIds?: string[]; evidence?: Record<string, JsonValue> }): string {
    if (!input.conversationId || !input.extractorVersion || !/^sha256:[0-9a-f]{64}$/.test(input.inputDigest)) throw new Error("extraction input is invalid");
    const id = uuidv7(this.clock());
    this.db.run("INSERT INTO extractions(id, conversation_id, message_start_id, message_end_id, extractor_version, input_digest, status, candidate_ids_json, evidence_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?)", id, input.conversationId, input.messageStartId ?? null, input.messageEndId ?? null, input.extractorVersion, input.inputDigest, JSON.stringify(input.candidateIds ?? []), JSON.stringify(input.evidence ?? {}), this.clock(), this.clock());
    return id;
  }

  purge(tombstoneId: string): { status: "VERIFIED" | "FAILED"; manifestHash: string } {
    const tombstone = this.db.one<{ target_id: string; status: string }>("SELECT target_id, status FROM conversation_tombstones WHERE id = ?", tombstoneId);
    if (!tombstone || tombstone.status === "VERIFIED") throw new Error("purge tombstone is unavailable");
    const now = this.clock();
    const artifactDigests = this.db.transaction(() => {
      this.db.run("UPDATE conversation_tombstones SET status = 'PURGING' WHERE id = ?", tombstoneId);
      const digests = this.db.all<{ artifact_hash: string }>("SELECT artifact_hash FROM artifact_references WHERE owner_type = 'conversation' AND owner_id = ?", tombstone.target_id).map((row) => row.artifact_hash);
      this.db.run("DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = ?)", tombstone.target_id);
      this.db.run("DELETE FROM messages WHERE conversation_id = ?", tombstone.target_id);
      this.db.run("UPDATE artifact_references SET released_at = ? WHERE owner_type = 'conversation' AND owner_id = ? AND released_at IS NULL", now, tombstone.target_id);
      return digests;
    });
    let remainingArtifacts = artifactDigests;
    if (artifactDigests.length === 0) remainingArtifacts = [];
    else if (this.purgeArtifacts) {
      try { remainingArtifacts = [...this.purgeArtifacts(artifactDigests).remaining]; } catch { remainingArtifacts = artifactDigests; }
    }
    const remainingMessages = Number(this.db.one<{ count: number }>("SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?", tombstone.target_id)?.count ?? 0);
    const status = remainingMessages === 0 && remainingArtifacts.length === 0 ? "VERIFIED" : "FAILED";
    const manifestHash = sha256(canonicalJson({ tombstoneId, conversationId: tombstone.target_id, artifactDigests, remainingArtifacts, verifiedAt: now, status } as never));
    this.db.run("UPDATE conversation_tombstones SET status = ?, completed_at = ?, purge_manifest_hash = ? WHERE id = ?", status, now, manifestHash, tombstoneId);
    return { status, manifestHash };
  }

  storagePressureAction(usedBytes: number, warningBytes: number, criticalBytes: number): "NORMAL" | "REDUCE_OPTIONAL" | "STOP_OPTIONAL_WRITES" {
    if (!Number.isFinite(usedBytes) || !Number.isFinite(warningBytes) || !Number.isFinite(criticalBytes) || warningBytes > criticalBytes) throw new Error("storage thresholds are invalid");
    return usedBytes >= criticalBytes ? "STOP_OPTIONAL_WRITES" : usedBytes >= warningBytes ? "REDUCE_OPTIONAL" : "NORMAL";
  }
}
