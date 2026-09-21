import type { DispatchLanguageClass } from "../../../../../packages/contracts/src/dispatch.ts";
import type { NormalizedMatch, ProviderDescriptor, RouteInput, SemanticRouterProvider } from "../dispatch-types.ts";

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const LANGUAGE_CLASSES: readonly DispatchLanguageClass[] = ["ZH_DOMINANT", "EN_HEAVY", "UNKNOWN"];
const PRIVACY_LOCALITIES = ["LOCAL_ONLY", "TRUSTED_PRIVATE"] as const;
const RESPONSE_KEYS = ["schema_version", "intent", "abstain", "reason", "assurance", "calibrated_probability", "calibration_profile_id", "alternatives", "provenance"] as const;
const PROVENANCE_KEYS = ["provider_id", "model_revision", "bundle_id", "runtime_revision", "rule_set_hash", "dataset_revision"] as const;
const ALTERNATIVE_KEYS = ["intent", "calibrated_probability"] as const;

type PrivateHttpPrivacy = (typeof PRIVACY_LOCALITIES)[number];

export type PrivateHttpSemanticRouterConfig = {
  endpoint: string;
  providerId: string;
  modelRevision: string | null;
  runtimeRevision: string;
  bundleId: string;
  bundleHash: string;
  calibrationProfileId: string;
  supportedLanguageClasses: DispatchLanguageClass[];
  maxBytes: number;
  maxTokens: number;
  maxResponseBytes: number;
  timeoutMs: number;
  privacyLocality: PrivateHttpPrivacy;
  calibrationExpiresAt?: number;
  bearerToken?: string;
};

type PrivateHttpEnvironment = Record<string, string | undefined>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], scope: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new ProviderProtocolError("PROVIDER_RESPONSE_SCHEMA", `${scope}.${key}`);
}

function requiredString(value: unknown, name: string, maxLength = 200): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) throw new ProviderProtocolError("PROVIDER_RESPONSE_SCHEMA", name);
  return value;
}

function optionalString(value: unknown, name: string, maxLength = 200): string | null {
  if (value === null) return null;
  return requiredString(value, name, maxLength);
}

function boundedInteger(value: string | undefined, name: string, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`INVALID_SEMANTIC_PROVIDER_CONFIG:${name}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`INVALID_SEMANTIC_PROVIDER_CONFIG:${name}`);
  return parsed;
}

function configuredString(env: PrivateHttpEnvironment, name: string, fallback?: string, maxLength = 200): string {
  const value = env[name] ?? fallback;
  if (value === undefined || value.length === 0 || value.length > maxLength) throw new Error(`INVALID_SEMANTIC_PROVIDER_CONFIG:${name}`);
  return value;
}

function validateEndpoint(raw: string): string {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error("INVALID_SEMANTIC_PROVIDER_CONFIG:PAI_DISPATCH_SEMANTIC_PROVIDER_URL"); }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("INVALID_SEMANTIC_PROVIDER_CONFIG:PAI_DISPATCH_SEMANTIC_PROVIDER_URL");
  }
  const hostname = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (!isPrivateHost(hostname)) throw new Error("SEMANTIC_PROVIDER_ENDPOINT_NOT_PRIVATE");
  return parsed.toString().replace(/\/$/, "");
}

function isPrivateHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "::1" || hostname === "0.0.0.0") return true;
  if (hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname.endsWith(".lan") || !hostname.includes(".")) return true;
  if (hostname.includes(":")) return /^(fc|fd|fe[89ab])/i.test(hostname);
  const octets = hostname.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [first, second] = octets;
  return first === 10 || first === 127 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168) || (first === 169 && second === 254);
}

function parseLanguages(raw: string | undefined): DispatchLanguageClass[] {
  const values = (raw ?? "ZH_DOMINANT").split(",").map((value) => value.trim()).filter(Boolean);
  if (values.length === 0 || values.some((value) => !LANGUAGE_CLASSES.includes(value as DispatchLanguageClass))) throw new Error("INVALID_SEMANTIC_PROVIDER_CONFIG:PAI_DISPATCH_SEMANTIC_SUPPORTED_LANGUAGES");
  return [...new Set(values)] as DispatchLanguageClass[];
}

function parsePrivacy(raw: string | undefined): PrivateHttpPrivacy {
  const value = raw ?? "LOCAL_ONLY";
  if (!PRIVACY_LOCALITIES.includes(value as PrivateHttpPrivacy)) throw new Error("INVALID_SEMANTIC_PROVIDER_CONFIG:PAI_DISPATCH_SEMANTIC_PRIVACY");
  return value as PrivateHttpPrivacy;
}

function parseCalibrationExpiry(raw: string | undefined): number {
  if (raw === undefined || raw.length === 0) throw new Error("INVALID_SEMANTIC_PROVIDER_CONFIG:PAI_DISPATCH_SEMANTIC_CALIBRATION_EXPIRES_AT");
  const epoch = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  if (!Number.isSafeInteger(epoch) || epoch <= 0) throw new Error("INVALID_SEMANTIC_PROVIDER_CONFIG:PAI_DISPATCH_SEMANTIC_CALIBRATION_EXPIRES_AT");
  return epoch;
}

export function parsePrivateHttpSemanticRouterConfig(env: PrivateHttpEnvironment = process.env): PrivateHttpSemanticRouterConfig {
  const endpoint = validateEndpoint(configuredString(env, "PAI_DISPATCH_SEMANTIC_PROVIDER_URL"));
  const providerId = configuredString(env, "PAI_DISPATCH_SEMANTIC_PROVIDER_ID", "private-http-v1");
  if (!IDENTIFIER.test(providerId)) throw new Error("INVALID_SEMANTIC_PROVIDER_CONFIG:PAI_DISPATCH_SEMANTIC_PROVIDER_ID");
  const modelRevisionValue = env.PAI_DISPATCH_SEMANTIC_MODEL_REVISION;
  if (modelRevisionValue !== undefined && (modelRevisionValue.length === 0 || modelRevisionValue.length > 200 || !IDENTIFIER.test(modelRevisionValue))) throw new Error("INVALID_SEMANTIC_PROVIDER_CONFIG:PAI_DISPATCH_SEMANTIC_MODEL_REVISION");
  const runtimeRevision = configuredString(env, "PAI_DISPATCH_SEMANTIC_RUNTIME_REVISION");
  if (!IDENTIFIER.test(runtimeRevision)) throw new Error("INVALID_SEMANTIC_PROVIDER_CONFIG:PAI_DISPATCH_SEMANTIC_RUNTIME_REVISION");
  const bundleId = configuredString(env, "PAI_DISPATCH_SEMANTIC_BUNDLE_ID");
  if (!IDENTIFIER.test(bundleId)) throw new Error("INVALID_SEMANTIC_PROVIDER_CONFIG:PAI_DISPATCH_SEMANTIC_BUNDLE_ID");
  const bundleHash = configuredString(env, "PAI_DISPATCH_SEMANTIC_BUNDLE_HASH", undefined, 71);
  if (!SHA256.test(bundleHash)) throw new Error("INVALID_SEMANTIC_PROVIDER_CONFIG:PAI_DISPATCH_SEMANTIC_BUNDLE_HASH");
  const calibrationProfileId = configuredString(env, "PAI_DISPATCH_SEMANTIC_CALIBRATION_PROFILE_ID");
  if (!IDENTIFIER.test(calibrationProfileId)) throw new Error("INVALID_SEMANTIC_PROVIDER_CONFIG:PAI_DISPATCH_SEMANTIC_CALIBRATION_PROFILE_ID");
  const bearerToken = env.PAI_DISPATCH_SEMANTIC_PROVIDER_TOKEN;
  if (bearerToken !== undefined && (bearerToken.length === 0 || bearerToken.length > 4096 || /[\r\n]/.test(bearerToken))) throw new Error("INVALID_SEMANTIC_PROVIDER_CONFIG:PAI_DISPATCH_SEMANTIC_PROVIDER_TOKEN");
  return {
    endpoint,
    providerId,
    modelRevision: modelRevisionValue ?? null,
    runtimeRevision,
    bundleId,
    bundleHash,
    calibrationProfileId,
    supportedLanguageClasses: parseLanguages(env.PAI_DISPATCH_SEMANTIC_SUPPORTED_LANGUAGES),
    maxBytes: boundedInteger(env.PAI_DISPATCH_SEMANTIC_MAX_BYTES, "PAI_DISPATCH_SEMANTIC_MAX_BYTES", 8 * 1024, 1, 64 * 1024),
    maxTokens: boundedInteger(env.PAI_DISPATCH_SEMANTIC_MAX_TOKENS, "PAI_DISPATCH_SEMANTIC_MAX_TOKENS", 128, 1, 4096),
    maxResponseBytes: boundedInteger(env.PAI_DISPATCH_SEMANTIC_MAX_RESPONSE_BYTES, "PAI_DISPATCH_SEMANTIC_MAX_RESPONSE_BYTES", 32 * 1024, 1, 256 * 1024),
    timeoutMs: boundedInteger(env.PAI_DISPATCH_SEMANTIC_TIMEOUT_MS, "PAI_DISPATCH_SEMANTIC_TIMEOUT_MS", 150, 1, 5_000),
    privacyLocality: parsePrivacy(env.PAI_DISPATCH_SEMANTIC_PRIVACY),
    calibrationExpiresAt: parseCalibrationExpiry(env.PAI_DISPATCH_SEMANTIC_CALIBRATION_EXPIRES_AT),
    ...(bearerToken === undefined ? {} : { bearerToken }),
  };
}

export class ProviderProtocolError extends Error {
  readonly code: string;
  constructor(code: string, detail?: string) {
    super(detail ? `${code}:${detail}` : code);
    this.name = code;
    this.code = code;
  }
}

function timeoutError(): ProviderProtocolError {
  const error = new ProviderProtocolError("PROVIDER_TIMEOUT");
  Object.defineProperty(error, "name", { value: "TimeoutError" });
  return error;
}

function readRuleSetHash(input: RouteInput): string | undefined {
  const value = (input as RouteInput & { ruleSetHash?: unknown }).ruleSetHash;
  if (value === undefined) return undefined;
  const hash = requiredString(value, "ruleSetHash", 71);
  if (!SHA256.test(hash)) throw new ProviderProtocolError("PROVIDER_REQUEST_SCHEMA", "ruleSetHash");
  return hash;
}

export class PrivateHttpSemanticRouterProvider implements SemanticRouterProvider {
  private readonly descriptor: ProviderDescriptor;
  private readonly config: PrivateHttpSemanticRouterConfig;

  constructor(config: PrivateHttpSemanticRouterConfig) {
    const endpoint = validateEndpoint(config.endpoint);
    if (!IDENTIFIER.test(config.providerId) || (config.modelRevision !== null && !IDENTIFIER.test(config.modelRevision)) || !IDENTIFIER.test(config.runtimeRevision) || !IDENTIFIER.test(config.bundleId) || !SHA256.test(config.bundleHash) || !IDENTIFIER.test(config.calibrationProfileId)) throw new Error("INVALID_SEMANTIC_PROVIDER_CONFIG");
    if (!Array.isArray(config.supportedLanguageClasses) || config.supportedLanguageClasses.length === 0 || config.supportedLanguageClasses.some((value) => !LANGUAGE_CLASSES.includes(value))) throw new Error("INVALID_SEMANTIC_PROVIDER_CONFIG");
    if (!Number.isSafeInteger(config.maxBytes) || config.maxBytes < 1 || config.maxBytes > 64 * 1024 || !Number.isSafeInteger(config.maxTokens) || config.maxTokens < 1 || config.maxTokens > 4096 || !Number.isSafeInteger(config.maxResponseBytes) || config.maxResponseBytes < 1 || config.maxResponseBytes > 256 * 1024 || !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 5_000) throw new Error("INVALID_SEMANTIC_PROVIDER_CONFIG");
    if (!PRIVACY_LOCALITIES.includes(config.privacyLocality) || (config.calibrationExpiresAt !== undefined && (!Number.isSafeInteger(config.calibrationExpiresAt) || config.calibrationExpiresAt <= 0)) || (config.bearerToken !== undefined && (config.bearerToken.length === 0 || config.bearerToken.length > 4096 || /[\r\n]/.test(config.bearerToken)))) throw new Error("INVALID_SEMANTIC_PROVIDER_CONFIG");
    this.config = { ...config, endpoint, supportedLanguageClasses: [...new Set(config.supportedLanguageClasses)] };
    this.descriptor = {
      providerId: config.providerId,
      protocolVersion: 1,
      modelRevision: config.modelRevision,
      runtimeRevision: config.runtimeRevision,
      bundleId: config.bundleId,
      bundleHash: config.bundleHash,
      supportedLanguageClasses: [...config.supportedLanguageClasses],
      maxBytes: config.maxBytes,
      maxTokens: config.maxTokens,
      privacyLocality: config.privacyLocality,
    };
  }

  describe(): ProviderDescriptor { return { ...this.descriptor, supportedLanguageClasses: [...this.descriptor.supportedLanguageClasses] }; }

  async readiness(): Promise<{ ready: boolean; reason: string }> {
    if (this.config.calibrationExpiresAt !== undefined && Date.now() >= this.config.calibrationExpiresAt) return { ready: false, reason: "CALIBRATION_PROFILE_EXPIRED" };
    return { ready: true, reason: "PRIVATE_HTTP_PROVIDER_CONFIGURED" };
  }

  async match(input: RouteInput, signal: AbortSignal): Promise<NormalizedMatch> {
    if (this.config.calibrationExpiresAt !== undefined && Date.now() >= this.config.calibrationExpiresAt) throw new ProviderProtocolError("PROVIDER_CALIBRATION_EXPIRED");
    this.validateInput(input);
    const remainingMs = Math.floor(input.deadlineAt - Date.now());
    if (remainingMs <= 0) throw timeoutError();
    const timeout = AbortSignal.timeout(Math.min(this.config.timeoutMs, remainingMs));
    const combined = AbortSignal.any([signal, timeout]);
    const requestBody: Record<string, unknown> = {
      schema_version: 1,
      request_id: input.requestId,
      text: input.text,
      context: { locale: input.context.locale, language_class: input.context.languageClass },
      candidate_intents: [...input.candidateIntents],
      bundle_id: input.bundleId,
      deadline_at: input.deadlineAt,
      max_tokens: this.config.maxTokens,
    };
    const ruleSetHash = readRuleSetHash(input);
    if (ruleSetHash !== undefined) requestBody.rule_set_hash = ruleSetHash;
    try {
      const response = await fetch(this.config.endpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...(this.config.bearerToken === undefined ? {} : { authorization: `Bearer ${this.config.bearerToken}` }),
        },
        body: JSON.stringify(requestBody),
        redirect: "error",
        signal: combined,
      });
      const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
      if (contentType !== "application/json") throw new ProviderProtocolError("PROVIDER_RESPONSE_SCHEMA", "content-type");
      const body = await readBoundedBody(response, this.config.maxResponseBytes, combined);
      if (!response.ok) throw new ProviderProtocolError("PROVIDER_HTTP_STATUS", String(response.status));
      let parsed: unknown;
      try { parsed = JSON.parse(body); } catch { throw new ProviderProtocolError("PROVIDER_RESPONSE_SCHEMA", "json"); }
      return this.normalizeResponse(parsed, input);
    } catch (error) {
      if (combined.aborted && (combined.reason as { name?: string } | undefined)?.name === "TimeoutError") throw timeoutError();
      throw error;
    }
  }

  async close(): Promise<void> {}

  private validateInput(input: RouteInput): void {
    if (!isRecord(input) || typeof input.requestId !== "string" || input.requestId.length === 0 || input.requestId.length > 200) throw new ProviderProtocolError("PROVIDER_REQUEST_SCHEMA", "requestId");
    if (typeof input.text !== "string" || input.text.length === 0 || input.text.length > 160 || Buffer.byteLength(input.text, "utf8") > this.config.maxBytes) throw new ProviderProtocolError("PROVIDER_REQUEST_SCHEMA", "text");
    if (!isRecord(input.context) || typeof input.context.locale !== "string" || input.context.locale.length === 0 || typeof input.context.languageClass !== "string" || !LANGUAGE_CLASSES.includes(input.context.languageClass as DispatchLanguageClass) || !this.descriptor.supportedLanguageClasses.includes(input.context.languageClass as DispatchLanguageClass)) throw new ProviderProtocolError("PROVIDER_REQUEST_SCHEMA", "context");
    if (!Array.isArray(input.candidateIntents) || input.candidateIntents.length === 0 || input.candidateIntents.length > 100 || input.candidateIntents.some((value) => typeof value !== "string" || !IDENTIFIER.test(value))) throw new ProviderProtocolError("PROVIDER_REQUEST_SCHEMA", "candidateIntents");
    if (input.bundleId !== this.config.bundleId) throw new ProviderProtocolError("PROVIDER_BUNDLE_MISMATCH");
    if (!Number.isFinite(input.deadlineAt)) throw new ProviderProtocolError("PROVIDER_REQUEST_SCHEMA", "deadlineAt");
  }

  private normalizeResponse(value: unknown, input: RouteInput): NormalizedMatch {
    if (!isRecord(value)) throw new ProviderProtocolError("PROVIDER_RESPONSE_SCHEMA", "response");
    rejectUnknownKeys(value, RESPONSE_KEYS, "response");
    if (value.schema_version !== 1 || typeof value.abstain !== "boolean") throw new ProviderProtocolError("PROVIDER_RESPONSE_SCHEMA", "schema_version");
    const intent = value.intent === null ? null : requiredString(value.intent, "intent");
    const reason = requiredString(value.reason, "reason", 200);
    if (value.assurance !== "UNASSESSED" && value.assurance !== "HIGH") throw new ProviderProtocolError("PROVIDER_RESPONSE_SCHEMA", "assurance");
    const probability = value.calibrated_probability === null ? null : value.calibrated_probability;
    if (probability !== null && (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1)) throw new ProviderProtocolError("PROVIDER_RESPONSE_SCHEMA", "calibrated_probability");
    const profileId = optionalString(value.calibration_profile_id, "calibration_profile_id");
    if (!Array.isArray(value.alternatives) || value.alternatives.length > 100) throw new ProviderProtocolError("PROVIDER_RESPONSE_SCHEMA", "alternatives");
    const alternatives = value.alternatives.map((raw, index) => this.normalizeAlternative(raw, input, index));
    if (!isRecord(value.provenance)) throw new ProviderProtocolError("PROVIDER_RESPONSE_SCHEMA", "provenance");
    rejectUnknownKeys(value.provenance, PROVENANCE_KEYS, "provenance");
    const provenance = {
      providerId: requiredString(value.provenance.provider_id, "provenance.provider_id"),
      modelRevision: optionalString(value.provenance.model_revision, "provenance.model_revision"),
      bundleId: requiredString(value.provenance.bundle_id, "provenance.bundle_id"),
      runtimeRevision: requiredString(value.provenance.runtime_revision, "provenance.runtime_revision"),
      ruleSetHash: requiredString(value.provenance.rule_set_hash, "provenance.rule_set_hash", 71),
      datasetRevision: optionalString(value.provenance.dataset_revision, "provenance.dataset_revision"),
    };
    if (provenance.providerId !== this.descriptor.providerId || provenance.modelRevision !== this.descriptor.modelRevision || provenance.bundleId !== this.descriptor.bundleId || provenance.runtimeRevision !== this.descriptor.runtimeRevision || !SHA256.test(provenance.ruleSetHash)) throw new ProviderProtocolError("PROVIDER_PROVENANCE_MISMATCH");
    const requestedRuleSetHash = readRuleSetHash(input);
    if (requestedRuleSetHash !== undefined && provenance.ruleSetHash !== requestedRuleSetHash) throw new ProviderProtocolError("PROVIDER_PROVENANCE_MISMATCH", "ruleSetHash");
    if (value.abstain) {
      if (intent !== null || value.assurance !== "UNASSESSED" || probability !== null || profileId !== null) throw new ProviderProtocolError("PROVIDER_RESPONSE_SCHEMA", "abstain");
    } else {
      if (intent === null || !input.candidateIntents.includes(intent) || value.assurance !== "HIGH" || probability === null || profileId !== this.config.calibrationProfileId || provenance.datasetRevision === null) throw new ProviderProtocolError("PROVIDER_CALIBRATION_MISMATCH");
    }
    return { schemaVersion: 1, intent, abstain: value.abstain, reason, assurance: value.assurance, calibratedProbability: probability, calibrationProfileId: profileId, alternatives, provenance };
  }

  private normalizeAlternative(value: unknown, input: RouteInput, index: number): { intent: string; calibratedProbability: number | null } {
    if (!isRecord(value)) throw new ProviderProtocolError("PROVIDER_RESPONSE_SCHEMA", `alternatives.${index}`);
    rejectUnknownKeys(value, ALTERNATIVE_KEYS, `alternatives.${index}`);
    const intent = requiredString(value.intent, `alternatives.${index}.intent`);
    if (!input.candidateIntents.includes(intent)) throw new ProviderProtocolError("PROVIDER_RESPONSE_SCHEMA", `alternatives.${index}.intent`);
    const probability = value.calibrated_probability === null ? null : value.calibrated_probability;
    if (probability !== null && (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1)) throw new ProviderProtocolError("PROVIDER_RESPONSE_SCHEMA", `alternatives.${index}.calibrated_probability`);
    return { intent, calibratedProbability: probability };
  }
}

async function readBoundedBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  const advertised = response.headers.get("content-length");
  if (advertised !== null && (!/^\d+$/.test(advertised) || Number(advertised) > maxBytes)) {
    try { await response.body?.cancel(); } catch { /* the bounded response is already being rejected */ }
    throw new ProviderProtocolError("PROVIDER_RESPONSE_TOO_LARGE");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new ProviderProtocolError("PROVIDER_RESPONSE_TOO_LARGE");
      chunks.push(next.value);
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* preserve the protocol/abort error */ }
    throw error;
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(body);
}

export function createPrivateHttpSemanticRouterProvider(env: PrivateHttpEnvironment = process.env): SemanticRouterProvider | undefined {
  const kind = env.PAI_DISPATCH_SEMANTIC_PROVIDER?.trim();
  if (kind === undefined || kind === "" || kind === "off" || kind === "none") return undefined;
  if (kind !== "private-http") return undefined;
  try {
    return new PrivateHttpSemanticRouterProvider(parsePrivateHttpSemanticRouterConfig(env));
  } catch (error) {
    const reason = error instanceof Error ? error.message.split(":", 1)[0] : "INVALID_SEMANTIC_PROVIDER_CONFIG";
    console.error(JSON.stringify({ event: "dispatch.semantic_provider.disabled", reason }));
    return undefined;
  }
}

export const createSemanticRouterProviderFromEnv = createPrivateHttpSemanticRouterProvider;
