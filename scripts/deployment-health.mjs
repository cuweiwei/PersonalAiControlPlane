export function acceptanceHealthy(health, readiness, acceptance, office) {
  return health?.status === 'ok' && readiness?.status === 'ok'
    && acceptance?.service === 'personal-ai-control-plane' && acceptance.ready === true
    && acceptance.office?.id === 'office-1' && acceptance.coordinator?.recoveryMode === false
    && ['unknownExecutions', 'unknownAttempts', 'unknownSlots'].every((key) => acceptance.coordinator[key] === 0)
    && office?.id === 'office-1' && office.workflowHealth?.schemaReady === true;
}
export async function probeDeployment(fetcher, origin = 'http://127.0.0.1:9084') {
  const results = await Promise.all(['/healthz', '/readyz', '/api/v2/acceptance', '/api/v2/offices/office-1'].map(async (path) => {
    const response = await fetcher(`${origin}${path}`, { signal: AbortSignal.timeout(5000), redirect: 'error', headers: { accept: 'application/json' } });
    if (response.status !== 200) throw Error('HTTP contract mismatch');
    return response.json();
  }));
  return acceptanceHealthy(...results);
}
