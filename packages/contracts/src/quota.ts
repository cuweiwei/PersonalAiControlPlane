export const QUOTA_BUCKETS = ["FIVE_HOUR", "WEEKLY", "OTHER", "UNKNOWN"] as const;
export type QuotaBucket = (typeof QUOTA_BUCKETS)[number];

export const QUOTA_POOL_IDENTITY_STATES = ["UNKNOWN", "OWNER_CONFIRMED"] as const;
export type QuotaPoolIdentityState = (typeof QUOTA_POOL_IDENTITY_STATES)[number];

export const QUOTA_OBSERVATION_SOURCES = [
  "PROVIDER_STRUCTURED_ERROR",
  "PROVIDER_USAGE_API",
  "CODEX_APP_SERVER",
  "OWNER_REPORTED",
] as const;
export type QuotaObservationSource = (typeof QUOTA_OBSERVATION_SOURCES)[number];

export const QUOTA_CONFIDENCE_LEVELS = ["HIGH", "MEDIUM", "LOW", "UNKNOWN"] as const;
export type QuotaConfidence = (typeof QUOTA_CONFIDENCE_LEVELS)[number];

export type QuotaPoolBindingEvidence = "OWNER_CONFIRMED" | "UNVERIFIED" | "UNKNOWN";

/** Account references are one-way fingerprints, never provider credentials or account names. */
export type CreateQuotaPoolInput = {
  provider: string;
  account_fingerprint?: string | null;
  identity_state?: QuotaPoolIdentityState;
};

/** Only structured, bounded evidence is accepted; raw provider bodies and tokens are not part of this contract. */
export type RecordQuotaObservationInput = {
  bucket: QuotaBucket;
  exhausted: boolean | null;
  used_percent?: number | null;
  resets_at?: number | null;
  observed_at: number;
  source: QuotaObservationSource;
  confidence: QuotaConfidence;
  evidence_hash?: string | null;
};

/** Worker-reported quota interruption; the native session identifier is persisted but never projected in API/audit output. */
export type NativeQuotaBlockReport = {
  task_id: string;
  attempt_id: string;
  worker_id: string;
  runtime: "opencode" | "codex";
  native_session_id: string;
  workspace_id: string;
  workspace_fence_epoch: number;
  blocker_kind: "FIVE_HOUR" | "WEEKLY" | "UNKNOWN";
  blocker_generation: number;
  resume_policy: "INHERIT_WORKER" | "MANUAL_ONLY";
  observed_at: number;
  next_probe_at?: number | null;
  usage_pool_id?: string | null;
  provider_id?: string | null;
  model_id?: string | null;
  branch?: string | null;
  baseline_sha?: string | null;
  last_head_sha?: string | null;
  checkpoint_artifact_id?: string | null;
};
