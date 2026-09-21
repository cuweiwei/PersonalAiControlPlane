import type { DispatchRequestEnvelope } from "../../../../packages/contracts/src/dispatch.ts";
import { classifyDispatchLanguage, matchDeterministic } from "./deterministic-router.ts";
import type { DispatchEvaluation, DispatchRule, RouteInput, SemanticRouterProvider } from "./dispatch-types.ts";

export type CascadeSnapshot = { rules: readonly DispatchRule[]; bundleId: string; semanticEnabled: boolean; provider?: SemanticRouterProvider };

/** Pure tier orchestration. It never commits, invokes an adapter, or changes durable state. */
export class CascadeEngine {
  async evaluate(input: RouteInput & { request?: DispatchRequestEnvelope }, snapshot: CascadeSnapshot, deadlineAt: number): Promise<DispatchEvaluation | null> {
    const deterministic = matchDeterministic({ text: input.text, languageClass: input.context.languageClass || classifyDispatchLanguage(input.text) }, snapshot.rules);
    if (deterministic) return deterministic;
    if (!snapshot.semanticEnabled || !snapshot.provider || input.context.languageClass !== "ZH_DOMINANT") return null;
    const descriptor = snapshot.provider.describe();
    if (descriptor.bundleId !== snapshot.bundleId || !descriptor.supportedLanguageClasses.includes(input.context.languageClass)) return null;
    const remaining = Math.max(1, Math.floor(deadlineAt - Date.now()));
    const match = await snapshot.provider.match({ ...input, bundleId: descriptor.bundleId, deadlineAt }, AbortSignal.timeout(remaining));
    if (match.abstain || match.assurance !== "HIGH" || !match.intent || !match.calibrationProfileId) return null;
    const rule = snapshot.rules.find((candidate) => candidate.intent === match.intent);
    if (!rule) return null;
    return { tierId: "semantic-v1", rule, intent: rule.intent, action: null, assurance: match.assurance, calibratedProbability: match.calibratedProbability, reason: "CALIBRATED_MATCH", provenance: match.provenance };
  }
}
