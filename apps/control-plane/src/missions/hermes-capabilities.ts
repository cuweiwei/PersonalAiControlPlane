/** Read the deployed adapter rather than trusting an operator's boolean flag. */
export async function readHermesCapabilities(origin = process.env.PAI_HERMES_OFFICE_URL) {
  const unavailable = (reason: string) => ({ executorKind: "HERMES_TOOL", available: false, supervisorReadOnly: false, tools: [] as string[], unavailableReasons: [reason] });
  if (!origin) return unavailable("HERMES_ADAPTER_NOT_CONFIGURED");
  try {
    const response = await fetch(new URL("/api/internal/office/capabilities", origin), { signal: AbortSignal.timeout(3000), redirect: "error" });
    if (!response.ok) return unavailable("HERMES_CAPABILITY_PROBE_FAILED");
    const body = await response.json() as any;
    if (body.service !== "hermes-office-adapter" || !body.brain_protocol_versions?.includes(2)) return unavailable("HERMES_PROTOCOL_UNSUPPORTED");
    if (body.supervisor_read_only !== true) return unavailable("SUPERVISOR_READ_ONLY_NOT_VERIFIED");
    if (body.driver?.available !== true) return unavailable("HERMES_BRAIN_UNAVAILABLE");
    return { executorKind: "HERMES_TOOL", available: true, supervisorReadOnly: true, tools: [] as string[], unavailableReasons: [] as string[] };
  } catch {
    return unavailable("HERMES_CAPABILITY_PROBE_FAILED");
  }
}
