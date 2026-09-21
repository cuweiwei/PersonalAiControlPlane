import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import test from "node:test";
import {
  createPrivateHttpSemanticRouterProvider,
  parsePrivateHttpSemanticRouterConfig,
  PrivateHttpSemanticRouterProvider,
  type PrivateHttpSemanticRouterConfig,
  ProviderProtocolError,
} from "../apps/control-plane/src/dispatch/providers/private-http-provider.ts";

const BUNDLE_HASH = `sha256:${"a".repeat(64)}`;
const RULE_SET_HASH = `sha256:${"b".repeat(64)}`;

function baseEnvironment(endpoint: string): Record<string, string> {
  return {
    PAI_DISPATCH_SEMANTIC_PROVIDER: "private-http",
    PAI_DISPATCH_SEMANTIC_PROVIDER_URL: endpoint,
    PAI_DISPATCH_SEMANTIC_PROVIDER_ID: "private-router-v1",
    PAI_DISPATCH_SEMANTIC_MODEL_REVISION: "router-model-v1",
    PAI_DISPATCH_SEMANTIC_RUNTIME_REVISION: "runtime-v1",
    PAI_DISPATCH_SEMANTIC_BUNDLE_ID: "private-bundle-v1",
    PAI_DISPATCH_SEMANTIC_BUNDLE_HASH: BUNDLE_HASH,
    PAI_DISPATCH_SEMANTIC_CALIBRATION_PROFILE_ID: "calibration-v1",
    PAI_DISPATCH_SEMANTIC_CALIBRATION_EXPIRES_AT: String(Date.now() + 60_000),
    PAI_DISPATCH_SEMANTIC_SUPPORTED_LANGUAGES: "ZH_DOMINANT",
    PAI_DISPATCH_SEMANTIC_MAX_RESPONSE_BYTES: "4096",
    PAI_DISPATCH_SEMANTIC_TIMEOUT_MS: "100",
    PAI_DISPATCH_SEMANTIC_PROVIDER_TOKEN: "test-token",
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "request-1",
    text: "ContextHub 還活著嗎？",
    context: { locale: "zh-TW", languageClass: "ZH_DOMINANT" as const },
    candidateIntents: ["service.health_check"],
    bundleId: "private-bundle-v1",
    ruleSetHash: RULE_SET_HASH,
    deadlineAt: Date.now() + 500,
    ...overrides,
  };
}

async function bodyOf(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>): Promise<{ server: Server; endpoint: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => { void handler(request, response); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return {
    server,
    endpoint: `http://127.0.0.1:${address.port}/v1/route`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function validResponse(requestBody: Record<string, unknown>): Record<string, unknown> {
  return {
    schema_version: 1,
    intent: "service.health_check",
    abstain: false,
    reason: "CALIBRATED_MATCH",
    assurance: "HIGH",
    calibrated_probability: 0.997,
    calibration_profile_id: "calibration-v1",
    alternatives: [],
    provenance: {
      provider_id: "private-router-v1",
      model_revision: "router-model-v1",
      bundle_id: "private-bundle-v1",
      runtime_revision: "runtime-v1",
      rule_set_hash: requestBody.rule_set_hash,
      dataset_revision: "dataset-v1",
    },
  };
}

function config(endpoint: string, overrides: Partial<PrivateHttpSemanticRouterConfig> = {}): PrivateHttpSemanticRouterConfig {
  return {
    endpoint,
    providerId: "private-router-v1",
    modelRevision: "router-model-v1",
    runtimeRevision: "runtime-v1",
    bundleId: "private-bundle-v1",
    bundleHash: BUNDLE_HASH,
    calibrationProfileId: "calibration-v1",
    supportedLanguageClasses: ["ZH_DOMINANT"],
    maxBytes: 8 * 1024,
    maxTokens: 128,
    maxResponseBytes: 4096,
    timeoutMs: 100,
    privacyLocality: "LOCAL_ONLY",
    calibrationExpiresAt: Date.now() + 60_000,
    bearerToken: "test-token",
    ...overrides,
  };
}

test("factory is off by default and invalid/missing profile config abstains without throwing", () => {
  assert.equal(createPrivateHttpSemanticRouterProvider({}), undefined);
  const invalid = { ...baseEnvironment("http://127.0.0.1:9/v1/route") };
  invalid.PAI_DISPATCH_SEMANTIC_CALIBRATION_PROFILE_ID = "";
  const originalError = console.error;
  const errors: unknown[][] = [];
  console.error = (...values: unknown[]) => errors.push(values);
  try { assert.equal(createPrivateHttpSemanticRouterProvider(invalid), undefined); } finally { console.error = originalError; }
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]?.[0]), /dispatch\.semantic_provider\.disabled/);
});
test("private endpoint and strict calibration config reject public or incomplete configuration", () => {
  const environment = baseEnvironment("https://example.com/v1/route");
  assert.throws(() => parsePrivateHttpSemanticRouterConfig(environment), /SEMANTIC_PROVIDER_ENDPOINT_NOT_PRIVATE/);
  const missingExpiry = { ...baseEnvironment("http://127.0.0.1:9/v1/route") };
  delete missingExpiry.PAI_DISPATCH_SEMANTIC_CALIBRATION_EXPIRES_AT;
  assert.throws(() => parsePrivateHttpSemanticRouterConfig(missingExpiry), /CALIBRATION_EXPIRES_AT/);
});

test("private HTTP provider sends pinned bundle/rule provenance and normalizes a valid response", async () => {
  const stub = await listen(async (request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.headers.authorization, "Bearer test-token");
    const requestBody = await bodyOf(request);
    assert.deepEqual(Object.keys(requestBody).sort(), ["bundle_id", "candidate_intents", "context", "deadline_at", "max_tokens", "request_id", "rule_set_hash", "schema_version", "text"].sort());
    assert.equal(requestBody.schema_version, 1);
    assert.equal(requestBody.bundle_id, "private-bundle-v1");
    assert.equal(requestBody.rule_set_hash, RULE_SET_HASH);
    const payload = JSON.stringify(validResponse(requestBody));
    response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
    response.end(payload);
  });
  try {
    const provider = createPrivateHttpSemanticRouterProvider(baseEnvironment(stub.endpoint));
    assert.ok(provider);
    assert.equal((await provider.readiness()).ready, true);
    const result = await provider.match(input(), new AbortController().signal);
    assert.equal(result.intent, "service.health_check");
    assert.equal(result.calibratedProbability, 0.997);
    assert.equal(result.provenance.ruleSetHash, RULE_SET_HASH);
    await provider.close();
  } finally { await stub.close(); }
});

test("provider rejects unknown response fields, provenance mismatch, and unbound calibration", async () => {
  let mode: "unknown" | "provenance" | "profile" = "unknown";
  const stub = await listen(async (request, response) => {
    const requestBody = await bodyOf(request);
    const payload = validResponse(requestBody);
    if (mode === "unknown") payload.extra = true;
    if (mode === "provenance") (payload.provenance as Record<string, unknown>).bundle_id = "other-bundle";
    if (mode === "profile") payload.calibration_profile_id = "unbound-profile";
    const body = JSON.stringify(payload);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(body);
  });
  try {
    const provider = new PrivateHttpSemanticRouterProvider(config(stub.endpoint));
    for (const expected of ["PROVIDER_RESPONSE_SCHEMA", "PROVIDER_PROVENANCE_MISMATCH", "PROVIDER_CALIBRATION_MISMATCH"] as const) {
      await assert.rejects(() => provider.match(input(), new AbortController().signal), (error: unknown) => error instanceof ProviderProtocolError && error.code === expected);
      mode = mode === "unknown" ? "provenance" : "profile";
    }
  } finally { await stub.close(); }
});

test("provider fails closed for response size, timeout, expired profile, and bundle mismatch", async () => {
  let slow = false;
  const stub = await listen(async (request, response) => {
    const requestBody = await bodyOf(request);
    if (slow) await new Promise((resolve) => setTimeout(resolve, 100));
    const payload = JSON.stringify(validResponse(requestBody));
    response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
    response.end(payload);
  });
  try {
    const provider = new PrivateHttpSemanticRouterProvider(config(stub.endpoint, { maxResponseBytes: 10 }));
    await assert.rejects(() => provider.match(input(), new AbortController().signal), (error: unknown) => error instanceof ProviderProtocolError && error.code === "PROVIDER_RESPONSE_TOO_LARGE");
    const expired = new PrivateHttpSemanticRouterProvider(config(stub.endpoint, { calibrationExpiresAt: Date.now() - 1 }));
    assert.deepEqual(await expired.readiness(), { ready: false, reason: "CALIBRATION_PROFILE_EXPIRED" });
    await assert.rejects(() => expired.match(input(), new AbortController().signal), (error: unknown) => error instanceof ProviderProtocolError && error.code === "PROVIDER_CALIBRATION_EXPIRED");
    await assert.rejects(() => provider.match(input({ bundleId: "wrong-bundle" }), new AbortController().signal), (error: unknown) => error instanceof ProviderProtocolError && error.code === "PROVIDER_BUNDLE_MISMATCH");
    slow = true;
    const timeoutProvider = new PrivateHttpSemanticRouterProvider(config(stub.endpoint, { timeoutMs: 10 }));
    await assert.rejects(() => timeoutProvider.match(input(), new AbortController().signal), (error: unknown) => error instanceof ProviderProtocolError && error.code === "PROVIDER_TIMEOUT");
  } finally { await stub.close(); }
});
