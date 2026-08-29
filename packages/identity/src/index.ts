import { createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { canonicalJson, sha256, uuidv7, type JsonValue } from "../../crypto/src/index.ts";

const ACTION_GRANT_ALGORITHM = "EdDSA";
const ACTION_GRANT_TYPE = "pai-action+jwt";
const DEFAULT_MAX_LIFETIME_SECONDS = 300;

export type ActionGrantKeyState = "PENDING" | "ACTIVE" | "RETIRING" | "RETIRED" | "REVOKED";

export type ActionGrantKey = {
  kid: string;
  state: ActionGrantKeyState;
  privateKey: KeyObject;
  publicKey: KeyObject;
};

export type OpaqueActionGrantSigner = {
  kid: string;
  state: ActionGrantKeyState;
  sign(signingInput: Buffer): Buffer | Promise<Buffer>;
};

export type ActionGrantProtectedHeader = {
  alg: "EdDSA";
  typ: "pai-action+jwt";
  kid: string;
};

export type ActionGrantClaims = {
  iss: string;
  sub: string;
  aud: string;
  jti: string;
  iat: number;
  nbf: number;
  exp: number;
  taskId: string;
  attemptId: string;
  planDigest: string;
  policyVersion: number;
  fencingToken: number;
  actions: string[];
  resources: string[];
  capabilityIds: string[];
  budget: Record<string, JsonValue>;
  sandbox: Record<string, JsonValue>;
  hardStopApprovalId: string | null;
};

export type ActionGrantVerificationKey = {
  kid: string;
  state: ActionGrantKeyState;
  publicKey: KeyObject;
};

export type ActionGrantVerifyOptions = {
  issuer: string;
  audience: string;
  taskId: string;
  attemptId: string;
  planDigest: string;
  policyVersion: number;
  fencingToken: number;
  resolveKey: (kid: string) => ActionGrantVerificationKey | undefined;
  consumeJti: (jti: string, exp: number) => boolean;
  allowedActions?: readonly string[];
  allowedResources?: readonly string[];
  allowedCapabilityIds?: readonly string[];
  expectedBudget?: Record<string, JsonValue>;
  expectedSandbox?: Record<string, JsonValue>;
  hardStopApprovalId?: string | null;
  nowSeconds?: number;
  clockSkewSeconds?: number;
  maxLifetimeSeconds?: number;
};

export type VerifiedActionGrant = {
  header: ActionGrantProtectedHeader;
  claims: ActionGrantClaims;
  grantDigest: string;
};

export type ActionGrantVerificationFailureCode =
  | "grant.malformed"
  | "grant.header.invalid"
  | "grant.claims.invalid"
  | "grant.key.unavailable"
  | "grant.key.inactive"
  | "grant.signature.invalid"
  | "grant.issuer.invalid"
  | "grant.audience.invalid"
  | "grant.time.invalid"
  | "grant.binding.invalid"
  | "grant.action.undeclared"
  | "grant.resource.undeclared"
  | "grant.capability.undeclared"
  | "grant.replay"
  | "grant.replay-store-unavailable";

export type ActionGrantVerificationResult =
  | { ok: true; grant: VerifiedActionGrant }
  | { ok: false; code: ActionGrantVerificationFailureCode; message: string };

export function generateActionGrantKey(kid = uuidv7()): ActionGrantKey {
  if (kid.length === 0) throw new Error("kid must be non-empty");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { kid, state: "ACTIVE", privateKey, publicKey };
}

export function importActionGrantPublicKey(
  kid: string,
  publicKey: string | Buffer | KeyObject,
  state: ActionGrantKeyState = "ACTIVE",
): ActionGrantVerificationKey {
  if (kid.length === 0) throw new Error("kid must be non-empty");
  const resolvedPublicKey = typeof publicKey === "object" && publicKey !== null && "type" in publicKey
    ? publicKey as KeyObject
    : createPublicKey(publicKey);
  return { kid, state, publicKey: resolvedPublicKey };
}

function encodePart(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodePart(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url part");
  return Buffer.from(value, "base64url").toString("utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function requireInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${field} must be an integer`);
  return value;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new Error(`${field} must be a non-empty array of strings`);
  }
  return [...value];
}

function requireJsonObject(value: unknown, field: string): Record<string, JsonValue> {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  try {
    canonicalJson(value as Record<string, JsonValue>);
  } catch {
    throw new Error(`${field} must contain JSON values only`);
  }
  return value as Record<string, JsonValue>;
}

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[], context: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${context}.${key} is not allowed`);
  }
}

function normalizeClaims(value: ActionGrantClaims): ActionGrantClaims {
  if (!isRecord(value)) throw new Error("claims must be an object");
  const claims = value as unknown as Record<string, unknown>;
  rejectUnknown(claims, ["iss", "sub", "aud", "jti", "iat", "nbf", "exp", "taskId", "attemptId", "planDigest", "policyVersion", "fencingToken", "actions", "resources", "capabilityIds", "budget", "sandbox", "hardStopApprovalId"], "claims");
  const normalized: ActionGrantClaims = {
    iss: requireString(claims.iss, "iss"),
    sub: requireString(claims.sub, "sub"),
    aud: requireString(claims.aud, "aud"),
    jti: requireString(claims.jti, "jti"),
    iat: requireInteger(claims.iat, "iat"),
    nbf: requireInteger(claims.nbf, "nbf"),
    exp: requireInteger(claims.exp, "exp"),
    taskId: requireString(claims.taskId, "taskId"),
    attemptId: requireString(claims.attemptId, "attemptId"),
    planDigest: requireString(claims.planDigest, "planDigest"),
    policyVersion: requireInteger(claims.policyVersion, "policyVersion"),
    fencingToken: requireInteger(claims.fencingToken, "fencingToken"),
    actions: requireStringArray(claims.actions, "actions"),
    resources: requireStringArray(claims.resources, "resources"),
    capabilityIds: requireStringArray(claims.capabilityIds, "capabilityIds"),
    budget: requireJsonObject(claims.budget, "budget"),
    sandbox: requireJsonObject(claims.sandbox, "sandbox"),
    hardStopApprovalId: claims.hardStopApprovalId === null ? null : requireString(claims.hardStopApprovalId, "hardStopApprovalId"),
  };
  if (normalized.policyVersion < 1 || normalized.fencingToken < 0) throw new Error("policyVersion/fencingToken are out of range");
  if (normalized.exp <= normalized.iat || normalized.nbf > normalized.exp) throw new Error("grant time range is invalid");
  return normalized;
}

function failure(code: ActionGrantVerificationFailureCode, message: string): ActionGrantVerificationResult {
  return { ok: false, code, message };
}

function subset(values: readonly string[], allowed: readonly string[] | undefined): boolean {
  if (!allowed) return true;
  const allowedSet = new Set(allowed);
  return values.every((value) => allowedSet.has(value));
}

export function signActionGrant(claims: ActionGrantClaims, key: ActionGrantKey, maxLifetimeSeconds = DEFAULT_MAX_LIFETIME_SECONDS): string {
  if (key.state !== "ACTIVE") throw new Error("only ACTIVE keys may sign grants");
  const normalizedClaims = normalizeClaims(claims);
  if (!Number.isInteger(maxLifetimeSeconds) || maxLifetimeSeconds < 1 || normalizedClaims.exp - normalizedClaims.iat > maxLifetimeSeconds) {
    throw new Error("grant lifetime exceeds the configured bound");
  }
  const header: ActionGrantProtectedHeader = { alg: ACTION_GRANT_ALGORITHM, typ: ACTION_GRANT_TYPE, kid: key.kid };
  const encodedHeader = encodePart(canonicalJson(header));
  const encodedClaims = encodePart(canonicalJson(normalizedClaims as unknown as JsonValue));
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const signature = sign(null, Buffer.from(signingInput, "ascii"), key.privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}

/** Signs through an opaque key handle; private key material never enters the gateway process. */
export async function signActionGrantWithOpaqueSigner(
  claims: ActionGrantClaims,
  signer: OpaqueActionGrantSigner,
  maxLifetimeSeconds = DEFAULT_MAX_LIFETIME_SECONDS,
): Promise<string> {
  if (signer.state !== "ACTIVE") throw new Error("only ACTIVE keys may sign grants");
  const normalizedClaims = normalizeClaims(claims);
  if (!Number.isInteger(maxLifetimeSeconds) || maxLifetimeSeconds < 1 || normalizedClaims.exp - normalizedClaims.iat > maxLifetimeSeconds) {
    throw new Error("grant lifetime exceeds the configured bound");
  }
  const header: ActionGrantProtectedHeader = { alg: ACTION_GRANT_ALGORITHM, typ: ACTION_GRANT_TYPE, kid: signer.kid };
  const encodedHeader = encodePart(canonicalJson(header));
  const encodedClaims = encodePart(canonicalJson(normalizedClaims as unknown as JsonValue));
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const signature = await signer.sign(Buffer.from(signingInput, "ascii"));
  if (!Buffer.isBuffer(signature) || signature.length === 0) throw new Error("opaque signer returned an invalid signature");
  return `${signingInput}.${signature.toString("base64url")}`;
}

export function verifyActionGrant(token: string, options: ActionGrantVerifyOptions): ActionGrantVerificationResult {
  if (typeof token !== "string") return failure("grant.malformed", "grant must be a string");
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) return failure("grant.malformed", "grant must have three compact JWS parts");
  let headerValue: unknown;
  let claimsValue: unknown;
  let signature: Buffer;
  try {
    headerValue = JSON.parse(decodePart(parts[0]));
    claimsValue = JSON.parse(decodePart(parts[1]));
    if (!/^[A-Za-z0-9_-]+$/.test(parts[2])) throw new Error("invalid base64url signature");
    signature = Buffer.from(parts[2], "base64url");
  } catch {
    return failure("grant.malformed", "grant encoding or JSON is invalid");
  }
  if (!isRecord(headerValue) || headerValue.alg !== ACTION_GRANT_ALGORITHM || headerValue.typ !== ACTION_GRANT_TYPE || typeof headerValue.kid !== "string" || headerValue.kid.length === 0) {
    return failure("grant.header.invalid", "grant header must use EdDSA and the pai-action+jwt type");
  }
  try {
    rejectUnknown(headerValue, ["alg", "typ", "kid"], "header");
    if (parts[0] !== encodePart(canonicalJson(headerValue as unknown as JsonValue))) return failure("grant.malformed", "grant header is not canonical JSON");
  } catch {
    return failure("grant.header.invalid", "grant header is invalid");
  }
  const header = headerValue as unknown as ActionGrantProtectedHeader;
  let claims: ActionGrantClaims;
  try {
    claims = normalizeClaims(claimsValue as ActionGrantClaims);
    if (parts[1] !== encodePart(canonicalJson(claimsValue as unknown as JsonValue))) return failure("grant.malformed", "grant claims are not canonical JSON");
  } catch (error) {
    return failure("grant.claims.invalid", error instanceof Error ? error.message : "grant claims are invalid");
  }
  let verificationKey: ActionGrantVerificationKey | undefined;
  try {
    verificationKey = options.resolveKey(header.kid);
  } catch {
    return failure("grant.key.unavailable", "grant signing key is unavailable");
  }
  if (!verificationKey) return failure("grant.key.unavailable", "grant signing key is unavailable");
  if (verificationKey.kid !== header.kid || !["ACTIVE", "RETIRING"].includes(verificationKey.state)) {
    return failure("grant.key.inactive", "grant signing key is not active for verification");
  }
  try {
    if (!verify(null, Buffer.from(`${parts[0]}.${parts[1]}`, "ascii"), verificationKey.publicKey, signature)) {
      return failure("grant.signature.invalid", "grant signature is invalid");
    }
  } catch {
    return failure("grant.signature.invalid", "grant signature is invalid");
  }
  if (claims.iss !== options.issuer) return failure("grant.issuer.invalid", "grant issuer does not match the configured identity gateway");
  if (claims.aud !== options.audience) return failure("grant.audience.invalid", "grant audience does not match this consumer");
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const skew = options.clockSkewSeconds ?? 5;
  const maxLifetime = options.maxLifetimeSeconds ?? DEFAULT_MAX_LIFETIME_SECONDS;
  if (claims.iat > now + skew || claims.nbf > now + skew || claims.nbf < claims.iat || claims.exp <= now - skew || claims.exp - claims.iat > maxLifetime) {
    return failure("grant.time.invalid", "grant is not currently valid or exceeds the lifetime bound");
  }
  if (claims.taskId !== options.taskId || claims.attemptId !== options.attemptId || claims.planDigest !== options.planDigest || claims.policyVersion !== options.policyVersion || claims.fencingToken !== options.fencingToken) {
    return failure("grant.binding.invalid", "grant is not bound to the requested task, attempt, plan, policy, or fencing token");
  }
  if ((options.expectedBudget && canonicalJson(claims.budget) !== canonicalJson(options.expectedBudget)) || (options.expectedSandbox && canonicalJson(claims.sandbox) !== canonicalJson(options.expectedSandbox)) || (options.hardStopApprovalId !== undefined && claims.hardStopApprovalId !== options.hardStopApprovalId)) {
    return failure("grant.binding.invalid", "grant budget, sandbox, or approval binding does not match the offered operation");
  }
  if (!subset(claims.actions, options.allowedActions)) return failure("grant.action.undeclared", "grant contains an action outside the declared operation scope");
  if (!subset(claims.resources, options.allowedResources)) return failure("grant.resource.undeclared", "grant contains a resource outside the declared operation scope");
  if (!subset(claims.capabilityIds, options.allowedCapabilityIds)) return failure("grant.capability.undeclared", "grant contains a capability outside the declared operation scope");
  try {
    if (!options.consumeJti(claims.jti, claims.exp)) return failure("grant.replay", "grant jti has already been consumed");
  } catch {
    return failure("grant.replay-store-unavailable", "grant replay protection is unavailable");
  }
  return { ok: true, grant: { header, claims, grantDigest: sha256(token) } };
}
