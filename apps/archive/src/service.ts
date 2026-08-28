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
  constructor(db: ArchiveDatabase, clock: () => number = Date.now) { this.db = db; this.clock = clock; }

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
        this.db.run("INSERT INTO attachments(id, message_id, content_hash, media_type, size, artifact_ref, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)", uuidv7(now), messageId, attachment.contentHash, attachment.mediaType, attachment.size, attachment.artifactRef, expiresAt);
      }
      this.db.run("UPDATE conversations SET updated_at = ? WHERE id = ?", now, conversationId);
      this.db.run("INSERT INTO archive_outbox(id, topic, aggregate_id, dedupe_key, payload_json, available_at) VALUES (?, 'conversation.extract.requested', ?, ?, ?, ?)", uuidv7(now), conversationId, `conversation.message:${conversationId}:${envelope.message.externalId}:${envelope.message.revision}`, JSON.stringify({ conversationId, messageId }), now);
      return { status: "INSERTED", conversationId, messageId };
    });
  }

  requestPurge(conversationId: string, requestedBy: string, reason: string, blockFuture = false): string {
    const now = this.clock();
    if (!conversationId || !requestedBy || !reason || !this.db.one("SELECT id FROM conversations WHERE id = ?", conversationId)) throw new Error("conversation is unavailable");
    const id = uuidv7(now);
    this.db.run("INSERT INTO conversation_tombstones(id, target_type, target_id, requested_by, requested_at, reason, block_future, status) VALUES (?, 'conversation', ?, ?, ?, ?, ?, 'REQUESTED')", id, conversationId, requestedBy, now, reason, blockFuture ? 1 : 0);
    return id;
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
    return this.db.transaction(() => {
      this.db.run("UPDATE conversation_tombstones SET status = 'PURGING' WHERE id = ?", tombstoneId);
      const messageIds = this.db.all<{ id: string }>("SELECT id FROM messages WHERE conversation_id = ?", tombstone.target_id).map((row) => row.id);
      this.db.run("DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = ?)", tombstone.target_id);
      this.db.run("DELETE FROM messages WHERE conversation_id = ?", tombstone.target_id);
      const remaining = this.db.one<{ count: number }>("SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?", tombstone.target_id)?.count ?? 0;
      const manifestHash = sha256(canonicalJson({ tombstoneId, conversationId: tombstone.target_id, deletedMessageIds: messageIds, verifiedAt: now } as never));
      const status = remaining === 0 ? "VERIFIED" : "FAILED";
      this.db.run("UPDATE conversation_tombstones SET status = ?, completed_at = ?, purge_manifest_hash = ? WHERE id = ?", status, now, manifestHash, tombstoneId);
      return { status, manifestHash };
    });
  }

  storagePressureAction(usedBytes: number, warningBytes: number, criticalBytes: number): "NORMAL" | "REDUCE_OPTIONAL" | "STOP_OPTIONAL_WRITES" {
    if (!Number.isFinite(usedBytes) || !Number.isFinite(warningBytes) || !Number.isFinite(criticalBytes) || warningBytes > criticalBytes) throw new Error("storage thresholds are invalid");
    return usedBytes >= criticalBytes ? "STOP_OPTIONAL_WRITES" : usedBytes >= warningBytes ? "REDUCE_OPTIONAL" : "NORMAL";
  }
}
