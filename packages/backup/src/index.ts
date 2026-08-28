import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, copyFileSync } from "node:fs";
import { dirname } from "node:path";

export type BackupManifest = { schemaVersion: 1; source: string; backup: string; sourceDigest: string; backupDigest: string; schemaVersionObserved: number; migrationChecksums: string[]; artifactDigests: string[]; createdAt: string; restoreDrill: "NOT_RUN" | "PASSED" | "FAILED" };
function fileDigest(path: string): string { return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`; }

export function createConsistentFileBackup(source: string, destination: string, metadata: Omit<BackupManifest, "schemaVersion" | "source" | "backup" | "sourceDigest" | "backupDigest" | "createdAt" | "restoreDrill">): BackupManifest {
  if (!existsSync(source) || existsSync(destination)) throw new Error("backup source/destination is invalid");
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  const sourceDigest = fileDigest(source); const backupDigest = fileDigest(destination);
  if (sourceDigest !== backupDigest) throw new Error("backup digest mismatch");
  return { schemaVersion: 1, source, backup: destination, sourceDigest, backupDigest, ...metadata, createdAt: new Date().toISOString(), restoreDrill: "NOT_RUN" };
}

export function verifyBackupManifest(manifest: BackupManifest): { valid: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (manifest.schemaVersion !== 1 || !existsSync(manifest.backup)) reasons.push("manifest-or-backup-missing");
  if (existsSync(manifest.backup) && fileDigest(manifest.backup) !== manifest.backupDigest) reasons.push("backup-digest-mismatch");
  if (manifest.sourceDigest !== manifest.backupDigest) reasons.push("source-backup-digest-differ");
  if (manifest.restoreDrill !== "PASSED") reasons.push("restore-drill-not-passed");
  return { valid: reasons.length === 0, reasons };
}

export function markRestoreDrill(manifest: BackupManifest, passed: boolean): BackupManifest { return { ...manifest, restoreDrill: passed ? "PASSED" : "FAILED" }; }
