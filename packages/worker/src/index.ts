import { createHash, createPublicKey, randomBytes, sign, timingSafeEqual, verify, type KeyObject } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { canonicalJson, sha256, uuidv7, type JsonValue } from "../../crypto/src/index.ts";

export type WorkerEnvelopeType = "worker.hello" | "worker.heartbeat" | "job.accept" | "job.reject" | "job.event" | "job.checkpoint" | "job.result" | "capability.update";

export type WorkerHeartbeatReport = {
  health: "HEALTHY" | "DEGRADED" | "UNHEALTHY";
  capabilityId?: string;
  capabilityDescriptorHash?: string;
  agent?: { version?: string; platform?: string; architecture?: string; storageClass?: string };
  transport?: "WSS" | "HTTP_FALLBACK";
  resources?: { cpuCount?: number; load1?: number; memoryTotalBytes?: number; memoryFreeBytes?: number };
  runtime?: { activeJobs?: number; queuedJobs?: number; maxConcurrency?: number };
  lastErrorCode?: string;
};

export type WorkerCredential = {
  id: string;
  workerId: string;
  secret: string;
  issuedAt: number;
  expiresAt: number;
};

export type WorkerCredentialRecord = Omit<WorkerCredential, "secret"> & { secretHash: string; revokedAt: number | null };

export function hashWorkerCredential(secret: string): string {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(secret)) throw new Error("worker credential has invalid encoding");
  return `sha256:${createHash("sha256").update(secret, "utf8").digest("hex")}`;
}

export function createWorkerCredential(workerId: string, now = Date.now(), ttlMs = 24 * 60 * 60_000): WorkerCredential {
  if (!workerId || !Number.isInteger(now) || !Number.isInteger(ttlMs) || ttlMs < 5 * 60_000 || ttlMs > 7 * 24 * 60 * 60_000) throw new Error("worker credential bounds are invalid");
  return { id: uuidv7(now), workerId, secret: randomBytes(48).toString("base64url"), issuedAt: now, expiresAt: now + ttlMs };
}

export function verifyWorkerCredential(credential: string, record: WorkerCredentialRecord, now = Date.now()): boolean {
  if (record.revokedAt !== null || record.expiresAt <= now || record.issuedAt > now + 60_000) return false;
  try {
    const actual = Buffer.from(hashWorkerCredential(credential), "utf8");
    const expected = Buffer.from(record.secretHash, "utf8");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function enrollmentProofPayload(challenge: string, serverNonce: string, connectionId = ""): Buffer {
  if (!challenge || !serverNonce) throw new Error("enrollment proof inputs are required");
  return Buffer.from(`${challenge}.${serverNonce}${connectionId ? `.${connectionId}` : ""}`, "utf8");
}

export function signEnrollmentProof(challenge: string, serverNonce: string, privateKey: KeyObject, connectionId = ""): string {
  return sign(null, enrollmentProofPayload(challenge, serverNonce, connectionId), privateKey).toString("base64url");
}

export function verifyEnrollmentProofSignature(challenge: string, serverNonce: string, workerSignature: string, publicKey: KeyObject, connectionId = ""): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(workerSignature)) return false;
  try { return verify(null, enrollmentProofPayload(challenge, serverNonce, connectionId), publicKey, Buffer.from(workerSignature, "base64url")); } catch { return false; }
}

export type WorkerEnvelope = {
  protocolVersion: string;
  messageId: string;
  connectionId: string;
  sequence: number;
  workerId: string;
  sentAt: string;
  nonce: string;
  type: WorkerEnvelopeType;
  payload: Record<string, JsonValue>;
  signature: string;
};

export type WorkerFrameVerification = { ok: true; envelope: WorkerEnvelope } | { ok: false; code: string; message: string };

function frameForSigning(frame: Omit<WorkerEnvelope, "signature">): string {
  return canonicalJson(frame as unknown as JsonValue);
}

function exportPublicKey(publicKey: KeyObject): Buffer {
  return publicKey.export({ type: "spki", format: "der" }) as Buffer;
}

export function publicKeyFingerprint(publicKey: KeyObject | string | Buffer): string {
  const key = typeof publicKey === "string" || Buffer.isBuffer(publicKey) ? createPublicKey(publicKey) : publicKey;
  return sha256(exportPublicKey(key));
}

export function signWorkerEnvelope(frame: Omit<WorkerEnvelope, "signature">, privateKey: KeyObject): WorkerEnvelope {
  const signature = sign(null, Buffer.from(frameForSigning(frame), "utf8"), privateKey).toString("base64url");
  return { ...frame, signature };
}

export async function signWorkerEnvelopeWithSigner(
  frame: Omit<WorkerEnvelope, "signature">,
  signer: (payload: Buffer) => Buffer | Promise<Buffer>,
): Promise<WorkerEnvelope> {
  const signature = await signer(Buffer.from(frameForSigning(frame), "utf8"));
  if (!Buffer.isBuffer(signature) || signature.length === 0) throw new Error("worker signer returned an invalid signature");
  return { ...frame, signature: signature.toString("base64url") };
}

export class WorkerConnectionVerifier {
  private readonly seenMessageIds = new Set<string>();
  private lastSequence = -1;
  private readonly connectionId: string;
  private readonly workerId: string;
  private readonly publicKey: KeyObject;
  private readonly clock: () => number;
  private readonly maxSkewMs: number;

  constructor(connectionId: string, workerId: string, publicKey: KeyObject, clock: () => number = Date.now, maxSkewMs = 60_000) {
    this.connectionId = connectionId;
    this.workerId = workerId;
    this.publicKey = publicKey;
    this.clock = clock;
    this.maxSkewMs = maxSkewMs;
  }

  verify(frame: WorkerEnvelope): WorkerFrameVerification {
    if (!/^1\.[0-9]+$/.test(frame.protocolVersion)) return { ok: false, code: "PROTOCOL_UNSUPPORTED", message: "worker protocol version is unsupported" };
    if (!frame.messageId || !frame.connectionId || !frame.workerId || !frame.nonce || !Number.isInteger(frame.sequence) || frame.sequence < 0) return { ok: false, code: "FRAME_INVALID", message: "worker envelope identity is invalid" };
    if (frame.connectionId !== this.connectionId) return { ok: false, code: "CONNECTION_MISMATCH", message: "worker frame belongs to another connection" };
    if (frame.workerId !== this.workerId) return { ok: false, code: "WORKER_MISMATCH", message: "worker frame belongs to another worker" };
    if (this.seenMessageIds.has(frame.messageId)) return { ok: false, code: "MESSAGE_REPLAY", message: "worker message id was already accepted" };
    if (frame.sequence <= this.lastSequence) return { ok: false, code: "SEQUENCE_REPLAY", message: "worker sequence is not increasing" };
    const sentAt = Date.parse(frame.sentAt);
    if (!Number.isFinite(sentAt) || Math.abs(this.clock() - sentAt) > this.maxSkewMs) return { ok: false, code: "CLOCK_SKEW", message: "worker frame timestamp is outside the allowed window" };
    let valid = false;
    try {
      const { signature, ...unsigned } = frame;
      if (!/^[A-Za-z0-9_-]+$/.test(signature)) return { ok: false, code: "SIGNATURE_INVALID", message: "worker signature encoding is invalid" };
      valid = verify(null, Buffer.from(frameForSigning(unsigned), "utf8"), this.publicKey, Buffer.from(signature, "base64url"));
    } catch {
      return { ok: false, code: "SIGNATURE_INVALID", message: "worker signature is invalid" };
    }
    if (!valid) return { ok: false, code: "SIGNATURE_INVALID", message: "worker signature is invalid" };
    this.seenMessageIds.add(frame.messageId);
    this.lastSequence = frame.sequence;
    return { ok: true, envelope: frame };
  }
}

export type EnrollmentRequest = {
  id: string;
  workerPublicKey: KeyObject;
  fingerprint: string;
  deviceSummary: Record<string, JsonValue>;
  challenge: string;
  createdAt: number;
  expiresAt: number;
  status: "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED";
};

export function createEnrollmentRequest(workerPublicKey: KeyObject, deviceSummary: Record<string, JsonValue>, now = Date.now(), ttlMs = 10 * 60_000): EnrollmentRequest {
  if (ttlMs < 1 || ttlMs > 60 * 60_000) throw new Error("enrollment TTL is out of bounds");
  return { id: uuidv7(now), workerPublicKey, fingerprint: publicKeyFingerprint(workerPublicKey), deviceSummary, challenge: randomBytes(32).toString("base64url"), createdAt: now, expiresAt: now + ttlMs, status: "PENDING" };
}

export function approveEnrollment(request: EnrollmentRequest, fingerprint: string, approved: boolean, now = Date.now()): EnrollmentRequest {
  if (request.status !== "PENDING" || request.expiresAt <= now) return { ...request, status: request.expiresAt <= now ? "EXPIRED" : request.status };
  if (!approved || fingerprint !== request.fingerprint) return { ...request, status: "REJECTED" };
  return { ...request, status: "APPROVED" };
}

export function verifyEnrollmentProof(request: EnrollmentRequest, serverNonce: string, workerSignature: string, now = Date.now()): boolean {
  if (request.status !== "APPROVED" || request.expiresAt <= now || !serverNonce || !/^[A-Za-z0-9_-]+$/.test(workerSignature)) return false;
  try {
    return verify(null, Buffer.from(`${request.challenge}.${serverNonce}`, "utf8"), request.workerPublicKey, Buffer.from(workerSignature, "base64url"));
  } catch {
    return false;
  }
}

const COMMON_CAPABILITY_KEYS = ["health", "properties"] as const;
const CAPABILITY_PROPERTY_KEYS: Record<string, readonly string[]> = {
  "codex.execute": ["loginMode", "sandboxModes", "maxConcurrency"],
  "shell.execute": ["profiles", "networkModes", "maxConcurrency"],
  "filesystem.read": ["roots", "maxBytes"],
  "filesystem.write": ["roots", "maxBytes"],
  "cua.execute": ["desktopMode", "profile", "indicatorRequired"],
};

export type CapabilityDescriptor = {
  kind: string;
  version: string;
  descriptorHash: string;
  health: "HEALTHY" | "DEGRADED" | "UNHEALTHY";
  properties: Record<string, JsonValue>;
};

export function validateCapabilityDescriptor(descriptor: CapabilityDescriptor): { valid: true } | { valid: false; reasons: string[] } {
  const reasons: string[] = [];
  if (!descriptor.kind || !descriptor.version || !descriptor.descriptorHash) reasons.push("identity-required");
  if (!Object.keys(CAPABILITY_PROPERTY_KEYS).includes(descriptor.kind)) reasons.push("capability-kind-unsupported");
  if (!["HEALTHY", "DEGRADED", "UNHEALTHY"].includes(descriptor.health)) reasons.push("health-invalid");
  for (const key of Object.keys(descriptor)) if (!["kind", "version", "descriptorHash", ...COMMON_CAPABILITY_KEYS].includes(key)) reasons.push(`field-not-allowed:${key}`);
  const allowedProperties = CAPABILITY_PROPERTY_KEYS[descriptor.kind] ?? [];
  for (const key of Object.keys(descriptor.properties ?? {})) if (!allowedProperties.includes(key)) reasons.push(`property-not-allowed:${key}`);
  if (descriptor.descriptorHash !== sha256(canonicalJson({ kind: descriptor.kind, version: descriptor.version, health: descriptor.health, properties: descriptor.properties } as unknown as JsonValue))) reasons.push("descriptor-digest-mismatch");
  return reasons.length === 0 ? { valid: true } : { valid: false, reasons };
}

export function resolvePathWithinRoots(candidatePath: string, roots: readonly string[]): string | undefined {
  if (!isAbsolute(candidatePath) || roots.length === 0) return undefined;
  const canonicalize = (input: string): string => {
    const suffix: string[] = [];
    let current = resolve(input);
    while (true) {
      try {
        const existing = realpathSync(current);
        return suffix.reverse().reduce((path, segment) => join(path, segment), existing);
      } catch {
        const parent = dirname(current);
        if (parent === current) return resolve(input);
        suffix.push(basename(current));
        current = parent;
      }
    }
  };
  const candidate = canonicalize(candidatePath);
  for (const root of roots) {
    if (!isAbsolute(root)) continue;
    const canonicalRoot = canonicalize(root);
    const relativePath = relative(canonicalRoot, candidate);
    if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) return candidate;
  }
  return undefined;
}

export type ShellProfile = {
  name: string;
  allowedExecutables: readonly string[];
  allowedEnvironment: readonly string[];
  roots: readonly string[];
  maxRuntimeMs: number;
  maxOutputBytes: number;
  network: "none" | "approved";
};

export function validateShellInvocation(profile: ShellProfile, executable: string, args: readonly string[], cwd: string, environment: Record<string, string>): { valid: true } | { valid: false; reason: string } {
  if (!profile.name || !profile.allowedExecutables.includes(executable)) return { valid: false, reason: "executable-not-allowed" };
  if (["sudo", "su", "doas", "docker", "nsenter", "mount", "umount", "chroot"].includes(basename(executable).toLowerCase())) return { valid: false, reason: "privilege-or-host-boundary-command" };
  if (args.some((arg) => /[;&|`$<>\n\r]/.test(arg))) return { valid: false, reason: "shell-metacharacter-rejected" };
  if (!resolvePathWithinRoots(cwd, profile.roots)) return { valid: false, reason: "working-root-outside-profile" };
  if (Object.keys(environment).some((key) => !profile.allowedEnvironment.includes(key))) return { valid: false, reason: "environment-key-not-allowed" };
  if (!Number.isInteger(profile.maxRuntimeMs) || profile.maxRuntimeMs < 1 || !Number.isInteger(profile.maxOutputBytes) || profile.maxOutputBytes < 1) return { valid: false, reason: "profile-limits-invalid" };
  return { valid: true };
}

export type JobOffer = {
  workerId: string;
  capabilityId: string;
  capabilityDescriptorHash: string;
  attemptId: string;
  planDigest: string;
  fencingToken: number;
  leaseId: string;
  grantDigest: string;
  grantActions: readonly string[];
  requiredAction: string;
};

export function validateJobOffer(offer: JobOffer, expected: Omit<JobOffer, "grantActions" | "requiredAction"> & { requiredAction: string }): { valid: true } | { valid: false; reason: string } {
  if (offer.workerId !== expected.workerId || offer.capabilityId !== expected.capabilityId || offer.capabilityDescriptorHash !== expected.capabilityDescriptorHash || offer.attemptId !== expected.attemptId || offer.planDigest !== expected.planDigest || offer.fencingToken !== expected.fencingToken || offer.leaseId !== expected.leaseId || offer.grantDigest !== expected.grantDigest) return { valid: false, reason: "offer-binding-mismatch" };
  if (!offer.grantActions.includes(expected.requiredAction)) return { valid: false, reason: "grant-action-missing" };
  return { valid: true };
}
