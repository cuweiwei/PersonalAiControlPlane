import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { canonicalJson } from "../../../packages/crypto/src/index.ts";

export type WorkloadPrincipal = {
  workloadId: string;
  ownerId: string;
  subject: string;
  publicKeyPem: string;
};

export type WorkloadIdentity = {
  workloadId: string;
  ownerId: string;
  subject: string;
  publicKey: KeyObject;
};

export type WorkloadRequestPolicy = (request: IncomingMessage, body: unknown) => boolean;

type WorkloadProof = {
  method: string;
  path: string;
  timestamp: number;
  nonce: string;
  idempotencyKey: string;
  bodyDigest: string;
};

const WORKLOAD_ID_HEADER = "x-pai-workload-id";
const WORKLOAD_TIMESTAMP_HEADER = "x-pai-workload-timestamp";
const WORKLOAD_NONCE_HEADER = "x-pai-workload-nonce";
const WORKLOAD_SIGNATURE_HEADER = "x-pai-workload-signature";
const WORKLOAD_BODY_DIGEST_HEADER = "x-pai-workload-body-digest";
const MAX_CLOCK_SKEW_MS = 60_000;
const NONCE_TTL_MS = 10 * 60_000;

function pathOf(request: IncomingMessage): string {
  const url = new URL(request.url ?? "/", "http://workload.invalid");
  return url.pathname + url.search;
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

function bodyDigest(body: unknown): string {
  return createHash("sha256").update(canonicalJson((body ?? {}) as never)).digest("hex");
}

export function workloadRequestSigningPayload(proof: WorkloadProof): string {
  return canonicalJson(proof as never);
}

export class WorkloadRequestVerifier {
  private readonly identity: WorkloadIdentity;
  private readonly clock: () => number;
  private readonly policy?: WorkloadRequestPolicy;
  private readonly consumedNonces = new Map<string, number>();

  constructor(principal: WorkloadPrincipal, clock: () => number = Date.now, policy?: WorkloadRequestPolicy) {
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(principal.workloadId)) throw new Error("workloadId is invalid");
    if (typeof principal.ownerId !== "string" || !principal.ownerId || principal.ownerId.length > 200) throw new Error("ownerId is invalid");
    if (typeof principal.subject !== "string" || !principal.subject || principal.subject.length > 200) throw new Error("subject is invalid");
    if (typeof principal.publicKeyPem !== "string" || !principal.publicKeyPem) throw new Error("publicKeyPem is invalid");
    const publicKey = createPublicKey(principal.publicKeyPem);
    if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("publicKeyPem must contain an Ed25519 public key");
    this.identity = { workloadId: principal.workloadId, ownerId: principal.ownerId, subject: principal.subject, publicKey };
    this.clock = clock;
    this.policy = policy;
  }

  verify(request: IncomingMessage, body?: unknown): WorkloadIdentity | undefined {
    const workloadId = header(request, WORKLOAD_ID_HEADER);
    const timestamp = Number(header(request, WORKLOAD_TIMESTAMP_HEADER));
    const nonce = header(request, WORKLOAD_NONCE_HEADER);
    const signature = header(request, WORKLOAD_SIGNATURE_HEADER);
    const suppliedDigest = header(request, WORKLOAD_BODY_DIGEST_HEADER);
    if (!workloadId && !nonce && !signature && !suppliedDigest) return undefined;
    if (workloadId !== this.identity.workloadId || !nonce || !/^[A-Za-z0-9_-]{1,200}$/.test(nonce) || !signature || !/^[A-Za-z0-9_-]+$/.test(signature) || !suppliedDigest || !/^[a-f0-9]{64}$/.test(suppliedDigest)) return undefined;
    if (!Number.isInteger(timestamp)) return undefined;
    const now = this.clock();
    if (Math.abs(now - timestamp) > MAX_CLOCK_SKEW_MS) return undefined;
    if (body === undefined) return undefined;
    if (this.policy && !this.policy(request, body)) return undefined;
    if (bodyDigest(body) !== suppliedDigest) return undefined;
    for (const [key, expiresAt] of this.consumedNonces) if (expiresAt <= now) this.consumedNonces.delete(key);
    const nonceKey = `${workloadId}:${nonce}`;
    if (this.consumedNonces.has(nonceKey)) return undefined;
    const proof: WorkloadProof = {
      method: request.method ?? "GET",
      path: pathOf(request),
      timestamp,
      nonce,
      idempotencyKey: header(request, "idempotency-key") ?? "",
      bodyDigest: suppliedDigest,
    };
    let valid = false;
    try { valid = verify(null, Buffer.from(workloadRequestSigningPayload(proof), "utf8"), this.identity.publicKey, Buffer.from(signature, "base64url")); } catch { valid = false; }
    if (!valid) return undefined;
    this.consumedNonces.set(nonceKey, now + NONCE_TTL_MS);
    return this.identity;
  }
}

/** The Hermes workload is intentionally narrower than a browser owner session. */
export function allowHermesWorkloadOperation(request: IncomingMessage, body: unknown): boolean {
  const method = request.method ?? "GET";
  const path = pathOf(request);
  if (method === "POST" && path === "/api/v1/goals") return true;
  if (method === "GET" && (path === "/api/v1/goals" || /^\/api\/v1\/goals\/[^/]+(?:\/(?:plans|tasks|events))?$/.test(path))) return true;
  if (method === "POST" && /^\/api\/v1\/goals\/[^/]+\/cancel$/.test(path)) return true;
  if (method === "GET" && (path === "/api/v1/approvals" || /^\/api\/v1\/approvals\/[^/]+$/.test(path))) return true;
  if (method === "POST" && /^\/api\/v1\/approvals\/[^/]+\/decision$/.test(path)) {
    return Boolean(body && typeof body === "object" && !Array.isArray(body) && (body as Record<string, unknown>).decision === "REJECT");
  }
  return false;
}

export function workloadBodyDigest(body: unknown): string {
  return bodyDigest(body);
}

export const WORKLOAD_HEADERS = {
  id: WORKLOAD_ID_HEADER,
  timestamp: WORKLOAD_TIMESTAMP_HEADER,
  nonce: WORKLOAD_NONCE_HEADER,
  signature: WORKLOAD_SIGNATURE_HEADER,
  bodyDigest: WORKLOAD_BODY_DIGEST_HEADER,
} as const;
