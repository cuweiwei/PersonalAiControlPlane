import type { NormalizedMatch, ProviderDescriptor, RouteInput, SemanticRouterProvider } from "../dispatch-types.ts";

export class FakeSemanticRouterProvider implements SemanticRouterProvider {
  private readonly descriptor: ProviderDescriptor;
  private readonly handler: (input: RouteInput) => NormalizedMatch;
  constructor(handler: (input: RouteInput) => NormalizedMatch, descriptor: Partial<ProviderDescriptor> = {}) {
    this.handler = handler;
    this.descriptor = {
      providerId: "fake",
      protocolVersion: 1,
      modelRevision: "fake-model-v1",
      runtimeRevision: "fake-runtime-v1",
      bundleId: "fake-bundle-v1",
      bundleHash: "sha256:fake",
      supportedLanguageClasses: ["ZH_DOMINANT"],
      maxBytes: 8 * 1024,
      maxTokens: 128,
      privacyLocality: "LOCAL_ONLY",
      ...descriptor,
    };
  }
  describe(): ProviderDescriptor { return this.descriptor; }
  async readiness(): Promise<{ ready: boolean; reason: string }> { return { ready: true, reason: "FAKE_PROVIDER_READY" }; }
  async match(input: RouteInput, signal: AbortSignal): Promise<NormalizedMatch> {
    if (signal.aborted) throw new Error("PROVIDER_ABORTED");
    return this.handler(input);
  }
  async close(): Promise<void> {}
}
