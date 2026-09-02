export type BackupManifest = {
  schema_version: 2;
  source: string;
  backup: string;
  source_digest: string;
  backup_digest: string;
  artifact_digests: string[];
  created_at: string;
  restore_drill: "NOT_RUN" | "PASSED" | "FAILED";
};
