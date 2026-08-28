import { canonicalJson, sha256, type JsonValue } from "../../crypto/src/index.ts";

export type CheckpointManifest = {
  schemaVersion: 1;
  goalId: string;
  taskId: string;
  planRevision: number;
  planDigest: string;
  attempt: number;
  createdAt: string;
  inputDigest: string;
  completedSteps: string[];
  currentState: Record<string, JsonValue>;
  nextActions: string[];
  decisions: string[];
  changedFiles: string[];
  tests: string[];
  knownIssues: string[];
  artifacts: string[];
  usageActuals: Record<string, number>;
  externalOperations: string[];
  providerResume: { kind: "codex-thread" | "artifact-reconstruction" | "none"; reference: string | null };
  compatibility: { capabilityKind: string; capabilityVersion: string; workerPlatform: string | null };
};

export type CheckpointValidation = { valid: true; digest: string } | { valid: false; errors: string[] };

export function validateCheckpointManifest(value: unknown): CheckpointValidation {
  const errors: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false, errors: ["manifest must be an object"] };
  const manifest = value as Partial<CheckpointManifest>;
  if (manifest.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  for (const [key, prefix] of [["goalId", "goalId"], ["taskId", "taskId"], ["planDigest", "planDigest"], ["inputDigest", "inputDigest"], ["createdAt", "createdAt"]] as const) if (typeof manifest[key] !== "string" || manifest[key]!.length === 0) errors.push(`${prefix} is required`);
  if (!Number.isInteger(manifest.planRevision) || manifest.planRevision! < 1) errors.push("planRevision must be positive");
  if (!Number.isInteger(manifest.attempt) || manifest.attempt! < 1) errors.push("attempt must be positive");
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.some((item) => typeof item !== "string" || !/^sha256:[0-9a-f]{64}$/.test(item))) errors.push("artifacts must contain content digests");
  if (!manifest.providerResume || !["codex-thread", "artifact-reconstruction", "none"].includes(manifest.providerResume.kind) || manifest.providerResume.kind !== "none" && !manifest.providerResume.reference) errors.push("providerResume is invalid");
  if (!manifest.compatibility || !manifest.compatibility.capabilityKind || !manifest.compatibility.capabilityVersion) errors.push("compatibility is required");
  if (!Number.isFinite(manifest.usageActuals && manifest.usageActuals.tokens === undefined ? 0 : manifest.usageActuals?.tokens)) errors.push("usageActuals must be numeric");
  return errors.length > 0 ? { valid: false, errors } : { valid: true, digest: sha256(canonicalJson(value as JsonValue)) };
}

export function isCheckpointCompatible(manifest: CheckpointManifest, expected: { goalId: string; taskId: string; planDigest: string; capabilityKind: string; capabilityVersion: string; workerPlatform?: string | null }): boolean {
  return manifest.goalId === expected.goalId && manifest.taskId === expected.taskId && manifest.planDigest === expected.planDigest && manifest.compatibility.capabilityKind === expected.capabilityKind && manifest.compatibility.capabilityVersion === expected.capabilityVersion && (manifest.compatibility.workerPlatform === null || manifest.compatibility.workerPlatform === (expected.workerPlatform ?? null));
}
