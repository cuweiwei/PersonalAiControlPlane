export type DispatchJson = null | boolean | number | string | DispatchJson[] | { [key: string]: DispatchJson };

export type DispatchChannel = "telegram" | "web" | "future";
export type DispatchPrivacyClass = "LOCAL_ONLY" | "TRUSTED_PRIVATE" | "EXTERNAL_ALLOWED";
export type DispatchLanguageClass = "ZH_DOMINANT" | "EN_HEAVY" | "UNKNOWN";

export type DispatchRequestEnvelope = {
  schemaVersion: 1;
  requestId: string;
  ingressKey: string;
  source: { channel: DispatchChannel; conversationRef: string; eventRef: string };
  subjectRef: string;
  text: string;
  receivedAt: string;
  timezone: string;
  locale: string;
  context: { sessionRevision: number; standalone: boolean; pendingInteraction: boolean };
  privacyClass: DispatchPrivacyClass;
  routingBudgetMs: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function stringValue(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) throw new Error(`INVALID_DISPATCH_${field.toUpperCase()}`);
  return value;
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`INVALID_DISPATCH_${field.toUpperCase()}`);
  return value;
}

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`INVALID_DISPATCH_${field.toUpperCase()}_${key.toUpperCase()}`);
}

function boundedInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new Error(`INVALID_DISPATCH_${field.toUpperCase()}`);
  return value;
}

export function parseDispatchRequest(value: unknown): DispatchRequestEnvelope {
  const input = objectValue(value, "request");
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > 16 * 1024) throw new Error("DISPATCH_REQUEST_TOO_LARGE");
  rejectUnknown(input, ["schema_version", "request_id", "ingress_key", "source", "subject_ref", "text", "received_at", "timezone", "locale", "context", "privacy_class", "routing_budget_ms"], "request");
  if (input.schema_version !== 1) throw new Error("DISPATCH_CONTRACT_UPGRADE_REQUIRED");
  const source = objectValue(input.source, "source");
  rejectUnknown(source, ["channel", "conversation_ref", "event_ref"], "source");
  const channel = stringValue(source.channel, "channel", 32) as DispatchChannel;
  if (!["telegram", "web", "future"].includes(channel)) throw new Error("INVALID_DISPATCH_CHANNEL");
  const context = objectValue(input.context, "context");
  rejectUnknown(context, ["session_revision", "standalone", "pending_interaction"], "context");
  if (typeof context.standalone !== "boolean" || typeof context.pending_interaction !== "boolean") throw new Error("INVALID_DISPATCH_CONTEXT_ELIGIBILITY");
  const receivedAt = stringValue(input.received_at, "received_at", 80);
  if (!Number.isFinite(Date.parse(receivedAt))) throw new Error("INVALID_DISPATCH_RECEIVED_AT");
  const timezone = stringValue(input.timezone, "timezone", 80);
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(); } catch { throw new Error("INVALID_DISPATCH_TIMEZONE"); }
  const locale = stringValue(input.locale, "locale", 32);
  const privacyClass = stringValue(input.privacy_class, "privacy_class", 32) as DispatchPrivacyClass;
  if (!["LOCAL_ONLY", "TRUSTED_PRIVATE", "EXTERNAL_ALLOWED"].includes(privacyClass)) throw new Error("INVALID_DISPATCH_PRIVACY_CLASS");
  const text = stringValue(input.text, "text", 8 * 1024);
  if (Buffer.byteLength(text, "utf8") > 8 * 1024 || [...text].length > 160) throw new Error("INVALID_DISPATCH_TEXT_LENGTH");
  const parsed: DispatchRequestEnvelope = {
    schemaVersion: 1,
    requestId: stringValue(input.request_id, "request_id", 300),
    ingressKey: stringValue(input.ingress_key, "ingress_key", 500),
    source: { channel, conversationRef: stringValue(source.conversation_ref, "conversation_ref", 500), eventRef: stringValue(source.event_ref, "event_ref", 500) },
    subjectRef: stringValue(input.subject_ref, "subject_ref", 300),
    text,
    receivedAt: new Date(Date.parse(receivedAt)).toISOString(),
    timezone,
    locale,
    context: {
      sessionRevision: boundedInteger(context.session_revision, "session_revision", 0, Number.MAX_SAFE_INTEGER),
      standalone: context.standalone,
      pendingInteraction: context.pending_interaction,
    },
    privacyClass,
    routingBudgetMs: input.routing_budget_ms === undefined ? 250 : boundedInteger(input.routing_budget_ms, "routing_budget_ms", 1, 5_000),
  };
  return parsed;
}

export type DispatchAction = {
  kind?: "single_operation";
  operation: string;
  operationSchemaVersion: number;
  logicalWorker: string;
  parameters: Record<string, DispatchJson>;
};

export type DispatchDisposition = "FALLBACK" | "PROPOSED";
export type DispatchFallbackReason =
  | "DISPATCH_DISABLED"
  | "NO_MATCH"
  | "LOW_CONFIDENCE"
  | "UNCALIBRATED"
  | "UNSUPPORTED_LANGUAGE"
  | "COMPLEX_REQUEST"
  | "AMBIGUOUS_RULES"
  | "INVALID_SLOTS"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_UNAVAILABLE"
  | "RESOURCE_BUDGET"
  | "PRIVACY_POLICY"
  | "CAPABILITY_UNAVAILABLE"
  | "SESSION_INELIGIBLE"
  | "POLICY_REQUIRES_HERMES";

export type DispatchDecision = {
  schemaVersion: 1;
  decisionId: string;
  disposition: DispatchDisposition;
  reason: string;
  tierId: string | null;
  ruleId: string | null;
  ruleRevision: number | null;
  intent: string | null;
  action: DispatchAction | null;
  assurance: "UNASSESSED" | "HIGH";
  calibratedProbability: number | null;
  releaseId: string | null;
  operationKey: string | null;
  actionHash: string | null;
  proposalId: string | null;
  expiresAt: string | null;
  stageLatencies: Record<string, number>;
};
