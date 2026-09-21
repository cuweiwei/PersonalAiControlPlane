import { canonicalJson, sha256 } from "../../../../packages/contracts/src/index.ts";
import type { DispatchLanguageClass } from "../../../../packages/contracts/src/dispatch.ts";
import type { DispatchEvaluation, DispatchRule } from "./dispatch-types.ts";

export type DeterministicMatch = DispatchEvaluation & { proof: { pattern: string; serviceRef: string; normalizedText: string } };

const technicalWords = new Set(["status", "health", "check", "context", "hub", "contexthub", "information", "radar", "informationradar", "hermes", "restart"]);
const negativeMarkers = ["不要", "別", "為什麼", "原因", "一直", "如果", "是否因為", "restart", "restarting", "重啟", "重啟嗎", "診斷", "看看為什麼"];
const complexMarkers = ["和", "以及", "然後", "同時", "如果", "並且", "還有"];

export function normalizeDispatchText(value: string): string {
  return value.normalize("NFC").trim().replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[ \t\r\n]+/g, " ").toLocaleLowerCase("zh-TW");
}

export function classifyDispatchLanguage(value: string): DispatchLanguageClass {
  const text = normalizeDispatchText(value);
  let han = 0; let latin = 0;
  for (const char of text) {
    if (/\p{Script=Han}/u.test(char)) han += 1;
  }
  const words = text.match(/[a-z]+/g) ?? [];
  latin = words.filter((word) => !technicalWords.has(word)).join("").length;
  if (han > 0 && han / Math.max(1, han + latin) >= 0.5) return "ZH_DOMINANT";
  if (latin > 0) return "EN_HEAVY";
  return "UNKNOWN";
}

export function isEligibleStandaloneText(value: string): boolean {
  const text = normalizeDispatchText(value);
  if ([...text].length === 0 || [...text].length > 160) return false;
  if (negativeMarkers.some((marker) => text.includes(marker))) return false;
  if (complexMarkers.filter((marker) => text.includes(marker)).length > 0) return false;
  return true;
}

function serviceAliases(allowed: readonly string[]): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const value of allowed) {
    const normalized = normalizeDispatchText(value);
    aliases.set(normalized, value);
    if (normalized === "contexthub") aliases.set("context hub", value);
    if (normalized === "information-radar") {
      aliases.set("information radar", value);
      aliases.set("informationradar", value);
      aliases.set("radar", value);
    }
  }
  return aliases;
}

function expandPattern(pattern: string, allowed: readonly string[]): Array<{ text: string; serviceRef: string }> {
  const marker = "{service}";
  const normalized = normalizeDispatchText(pattern);
  if (!normalized.includes(marker)) return [{ text: normalized, serviceRef: "" }];
  const [prefix, suffix] = normalized.split(marker);
  const aliases = serviceAliases(allowed);
  return [...aliases.entries()].map(([alias, serviceRef]) => ({ text: `${prefix}${alias}${suffix}`.trim(), serviceRef }));
}

function matchRule(text: string, rule: DispatchRule): { pattern: string; serviceRef: string } | null {
  const allowed = Object.values(rule.slots).flatMap((slot) => slot.allowedValues);
  const patterns = [...(rule.match.exact ?? []), ...(rule.match.aliases ?? [])];
  for (const pattern of patterns) {
    for (const expanded of expandPattern(pattern, allowed)) if (text === expanded.text) return { pattern, serviceRef: expanded.serviceRef };
  }
  return null;
}

export function matchDeterministic(input: { text: string; languageClass: DispatchLanguageClass }, rules: readonly DispatchRule[]): DeterministicMatch | null {
  const normalizedText = normalizeDispatchText(input.text);
  if (!isEligibleStandaloneText(normalizedText)) return null;
  const matches = rules.map((rule) => ({ rule, match: matchRule(normalizedText, rule) })).filter((entry): entry is { rule: DispatchRule; match: { pattern: string; serviceRef: string } } => entry.match !== null);
  if (matches.length === 0) return null;
  const distinctActions = new Set(matches.map(({ rule, match }) => sha256(canonicalJson({ action: rule.action, serviceRef: match.serviceRef }))));
  if (distinctActions.size !== 1) return null;
  const { rule, match } = matches[0];
  const serviceRef = match.serviceRef;
  const parameters = Object.fromEntries(Object.entries(rule.action.parameters).map(([key, value]) => [key, value === "$slot.service" ? serviceRef : value]));
  return {
    tierId: "exact-v1",
    rule,
    intent: rule.intent,
    action: { ...rule.action, parameters },
    assurance: "HIGH",
    calibratedProbability: null,
    reason: "DETERMINISTIC_MATCH",
    provenance: { matcher: "bounded-exact-v1", pattern: match.pattern, normalizedText },
    proof: { pattern: match.pattern, serviceRef, normalizedText },
  };
}

export function deterministicAbstainReason(text: string, rules: readonly DispatchRule[]): "AMBIGUOUS_RULES" | "COMPLEX_REQUEST" | null {
  const normalizedText = normalizeDispatchText(text);
  if (!isEligibleStandaloneText(normalizedText)) return "COMPLEX_REQUEST";
  const matches = rules.map((rule) => ({ rule, match: matchRule(normalizedText, rule) })).filter((entry): entry is { rule: DispatchRule; match: { pattern: string; serviceRef: string } } => entry.match !== null);
  if (matches.length < 2) return null;
  const hashes = new Set(matches.map(({ rule, match }) => sha256(canonicalJson({ action: rule.action, serviceRef: match.serviceRef }))));
  return hashes.size > 1 ? "AMBIGUOUS_RULES" : null;
}

export function actionSignature(action: { operation: string; operationSchemaVersion: number; logicalWorker: string; parameters: Record<string, unknown> }): string {
  return sha256(canonicalJson({ operation: action.operation, operationSchemaVersion: action.operationSchemaVersion, logicalWorker: action.logicalWorker, parameterNames: Object.keys(action.parameters).sort() }));
}
