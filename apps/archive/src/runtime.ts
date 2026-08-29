import { uuidv7 } from "../../../packages/crypto/src/index.ts";
import { ArchiveDatabase } from "./db.ts";
import { ArchiveService } from "./service.ts";

export type ArchiveArtifactWritePort = { put(bytes: Uint8Array, options: { maxBytes: number; mediaType: string }): { digest: string; size: number } };

export class ArchiveBackgroundRuntime {
  private readonly db: ArchiveDatabase; private readonly service: ArchiveService; private readonly artifacts?: ArchiveArtifactWritePort; private readonly clock: () => number; private timer?: ReturnType<typeof setInterval>;
  constructor(db: ArchiveDatabase, service: ArchiveService, artifacts?: ArchiveArtifactWritePort, clock: () => number = Date.now) { this.db = db; this.service = service; this.artifacts = artifacts; this.clock = clock; }
  start(intervalMs = 1_000): void { if (this.timer) return; this.timer = setInterval(() => { this.runOnce(); }, intervalMs); this.timer.unref(); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  runOnce(limit = 10): number {
    const now = this.clock();
    const rows = this.db.transaction(() => {
      const pending = this.db.all<{ id: string; topic: string; aggregate_id: string; payload_json: string; attempt_count: number }>("SELECT id, topic, aggregate_id, payload_json, attempt_count FROM archive_outbox WHERE delivered_at IS NULL AND dead_lettered_at IS NULL AND available_at <= ? AND (claimed_until IS NULL OR claimed_until <= ?) AND topic IN ('conversation.export.requested', 'conversation.purge.requested') ORDER BY available_at, id LIMIT ?", now, now, limit);
      return pending.map((row) => { const token = uuidv7(now); this.db.run("UPDATE archive_outbox SET claimed_until = ?, claim_token = ?, attempt_count = attempt_count + 1 WHERE id = ?", now + 30_000, token, row.id); return { ...row, token }; });
    });
    for (const row of rows) {
      try {
        const payload = JSON.parse(row.payload_json) as { exportId?: string; tombstoneId?: string; conversationId: string };
        if (row.topic === "conversation.export.requested") this.runExport(String(payload.exportId), payload.conversationId);
        else {
          const result = this.service.purge(String(payload.tombstoneId));
          if (result.status !== "VERIFIED") throw new Error("PURGE_VERIFICATION_FAILED");
        }
        this.db.run("UPDATE archive_outbox SET delivered_at = ?, claimed_until = NULL, claim_token = NULL, last_error = NULL WHERE id = ? AND claim_token = ?", now, row.id, row.token);
      } catch (error) {
        const code = error instanceof Error && /^[A-Z0-9_]{3,100}$/.test(error.message) ? error.message : "ARCHIVE_JOB_FAILED";
        if (row.topic === "conversation.export.requested") this.db.run("UPDATE conversation_exports SET status = 'FAILED', error_code = ?, updated_at = ? WHERE id = ? AND status <> 'COMPLETED'", code, now, row.aggregate_id);
        if (row.attempt_count + 1 >= 10) this.db.run("UPDATE archive_outbox SET dead_lettered_at = ?, claimed_until = NULL, claim_token = NULL, last_error = ? WHERE id = ? AND claim_token = ?", now, code, row.id, row.token);
        else this.db.run("UPDATE archive_outbox SET available_at = ?, claimed_until = NULL, claim_token = NULL, last_error = ? WHERE id = ? AND claim_token = ?", now + Math.min(120_000, 1_000 * 2 ** row.attempt_count), code, row.id, row.token);
      }
    }
    return rows.length;
  }
  private runExport(exportId: string, conversationId: string): void {
    if (!this.artifacts) throw new Error("ARTIFACT_AUTHORITY_UNAVAILABLE");
    const job = this.service.getJob(exportId); if (!job || job.status === "COMPLETED") return;
    this.db.run("UPDATE conversation_exports SET status = 'RUNNING', updated_at = ? WHERE id = ? AND status IN ('REQUESTED', 'FAILED', 'RUNNING')", this.clock(), exportId);
    const detail = this.service.getConversation(conversationId); if (!detail) throw new Error("CONVERSATION_NOT_FOUND");
    const manifest = this.service.exportConversation(conversationId);
    const bundle = Buffer.from(JSON.stringify({ schemaVersion: 1, manifest, conversation: detail }), "utf8");
    const artifact = this.artifacts.put(bundle, { maxBytes: 100 * 1024 * 1024, mediaType: "application/vnd.pai.conversation-export+json" });
    this.db.transaction(() => {
      this.db.run("UPDATE conversation_exports SET status = 'COMPLETED', artifact_hash = ?, manifest_json = ?, error_code = NULL, updated_at = ? WHERE id = ?", artifact.digest, JSON.stringify({ ...manifest, artifactHash: artifact.digest, size: artifact.size }), this.clock(), exportId);
      this.db.run("INSERT OR IGNORE INTO artifact_references(owner_type, owner_id, artifact_hash, purpose, created_at) VALUES ('export', ?, ?, 'conversation-export', ?)", exportId, artifact.digest, this.clock());
    });
  }
}
