export type ArtifactRef = { id: string; digest: string; media_type: string; size_bytes: number };

export function isArtifactDigest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}
