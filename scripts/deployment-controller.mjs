// Adapter operations run under a Gateway-side project fence held across the
// complete transaction, including rollback. No local lock can replace that fence.
export async function promote(adapter, release, currentHead) {
  let started = false;
  let previous;
  let backup;
  let lease;
  const events = [];
  const record = (state) => events.push(state);
  const healthy = async (digest) => {
    const status = await adapter.status();
    if (status.state !== 'healthy' || status.runningImageDigest !== digest) throw Error('running digest mismatch');
    if (await adapter.health() !== true) throw Error('acceptance failed');
  };
  try {
    if (await currentHead() !== release.commitSha) throw Error('stale SHA');
    lease = await adapter.acquireFence();
    if (!lease) throw Error('project fence unavailable');
    if (await adapter.allowlisted() !== true) throw Error('allowlist rejected');
    previous = (await adapter.status()).runningImageDigest;
    if (!/^sha256:[a-f0-9]{64}$/.test(previous)) throw Error('unknown previous version');
    if (await adapter.validate() !== true) throw Error('Gateway validation rejected');
    backup = await adapter.backup();
    if (!backup?.reference || backup.consistent !== true || backup.restoreVerified !== true || backup.previousDigest !== previous) throw Error('unverified backup');
    if (await currentHead() !== release.commitSha) throw Error('stale SHA');
    started = true;
    await adapter.deploy();
    await healthy(release.imageDigest);
    record('DEPLOYED');
  } catch {
    record('FAILED');
    if (started) {
      try {
        if (await adapter.rollbackSafe(backup, previous) !== true) throw Error('incompatible data');
        await adapter.rollback(previous, backup);
        await healthy(previous);
        record('ROLLED_BACK');
      } catch { record('NEEDS_OPERATOR_RECOVERY'); }
    }
  } finally {
    if (lease) {
      try { await adapter.releaseFence(lease); } catch { record('FAILED'); record('NEEDS_OPERATOR_RECOVERY'); }
    }
  }
  return { success: events.length === 1 && events[0] === 'DEPLOYED', events };
}
