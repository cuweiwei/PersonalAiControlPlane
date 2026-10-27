import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { render, hash, verify } from '../scripts/release-bundle.mjs';
import { promote } from '../scripts/deployment-controller.mjs';
import { acceptanceHealthy, probeDeployment } from '../scripts/deployment-health.mjs';

const commit = 'a'.repeat(40), digest = `sha256:${'b'.repeat(64)}`, previous = `sha256:${'c'.repeat(64)}`;
const repository = 'cuweiwei/PersonalAiControlPlane';
test('real CLI pipeline renders, generates and verifies same candidate bundle', () => {
  const dir = mkdtempSync(join(tmpdir(), 'paicp-release-cli-'));
  const env = { ...process.env, RELEASE_COMMIT: commit, RELEASE_REPOSITORY: repository, RELEASE_IMAGE_DIGEST: digest, RELEASE_IMAGE_REFERENCE: `ghcr.io/cuweiwei/personal-ai-control-plane@${digest}` };
  const run = (name, cwd, args = []) => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL(`../scripts/${name}`, import.meta.url)), ...args], { cwd, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    writeFileSync(join(dir, 'compose.prod.yml'), readFileSync('compose.prod.yml'));
    run('render-release-compose.mjs', dir);
    run('release-artifact.mjs', join(dir, 'release-artifacts'), ['--output', '.']);
    run('verify-release-bundle.mjs', dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('candidate bundle binds exact image and unchanged base policy; tampering fails closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'paicp-cd-'));
  const base = readFileSync('compose.prod.yml', 'utf8');
  const compose = render(base, repository, digest);
  const manifest = { schemaVersion: 1, serviceId: 'personal-ai-control-plane', repository, commitSha: commit, imageDigest: digest, composePath: 'compose.prod.yml', composeSha256: hash(compose), deploymentProjectId: 'PersonalAiControlPlane', health: { path: '/healthz', readinessPath: '/readyz' }, images: [{ serviceId: 'personal-ai-control-plane', imageReference: `ghcr.io/cuweiwei/personal-ai-control-plane@${digest}`, imageDigest: digest }] };
  const path = join(dir, `release-manifest-${commit}.json`);
  const save = () => writeFileSync(path, JSON.stringify(manifest));
  try {
    writeFileSync(join(dir, 'compose.prod.yml'), compose); save();
    assert.equal(verify(dir, repository, commit, digest).commitSha, commit);
    for (const [key, value] of [['composeSha256', '0'.repeat(64)], ['imageDigest', previous], ['repository', 'evil/repo'], ['deploymentProjectId', 'Hermes'], ['commitSha', 'd'.repeat(40)]]) {
      const original = manifest[key]; manifest[key] = value; save();
      assert.throws(() => verify(dir, repository, commit, digest)); manifest[key] = original;
    }
    save(); writeFileSync(join(dir, 'compose.prod.yml'), compose.replace('9084', '9085'));
    assert.throws(() => verify(dir, repository, commit, digest));
    assert.throws(() => render(base, repository, 'latest'));
    assert.equal(readFileSync('compose.prod.yml', 'utf8'), base);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function mock(overrides = {}) {
  const calls = []; let running = previous; let locked = false;
  const adapter = {
    acquireFence: async () => { if (locked) throw Error('busy'); locked = true; return 'lease'; },
    releaseFence: async () => { locked = false; },
    allowlisted: async () => true,
    status: async () => ({ runningImageDigest: running, state: 'healthy' }),
    validate: async () => true,
    backup: async () => ({ reference: 'verified-backup', consistent: true, restoreVerified: true, previousDigest: previous }),
    deploy: async () => { calls.push('deploy'); running = digest; },
    health: async () => true,
    rollbackSafe: async () => true,
    rollback: async () => { calls.push('rollback'); running = previous; },
    ...overrides,
  };
  return { adapter, calls };
}
const release = { commitSha: commit, imageDigest: digest };
test('mock promotion observes running digest and acceptance', async () => {
  const { adapter, calls } = mock();
  assert.equal((await promote(adapter, release, async () => commit)).success, true);
  assert.deepEqual(calls, ['deploy']);
});
for (const [name, overrides, head] of [
  ['stale SHA', {}, 'd'.repeat(40)],
  ['Gateway rejection', { validate: async () => false }, commit],
  ['allowlist rejection', { allowlisted: async () => false }, commit],
  ['backup failure', { backup: async () => ({ reference: 'unsafe-copy' }) }, commit],
  ['unknown status', { status: async () => ({}) }, commit],
]) test(`mock preflight ${name} prevents mutation`, async () => {
  const { adapter, calls } = mock(overrides);
  assert.equal((await promote(adapter, release, async () => head)).success, false);
  assert.deepEqual(calls, []);
});
test('mock health failure rolls back but original promotion remains failed', async () => {
  let probes = 0;
  const { adapter, calls } = mock({ health: async () => ++probes > 1 });
  const result = await promote(adapter, release, async () => commit);
  assert.equal(result.success, false); assert.deepEqual(result.events, ['FAILED', 'ROLLED_BACK']);
  assert.deepEqual(calls, ['deploy', 'rollback']);
});
for (const [name, override] of [
  ['rollback failure', { rollback: async () => { throw Error('refused'); } }],
  ['incompatible schema', { rollbackSafe: async () => false }],
  ['wrong restored digest', { rollback: async () => {} }],
]) test(`mock ${name} requires operator recovery`, async () => {
  const { adapter } = mock({ health: async () => false, ...override });
  assert.ok((await promote(adapter, release, async () => commit)).events.includes('NEEDS_OPERATOR_RECOVERY'));
});
test('mock uncertain deploy result still triggers rollback policy', async () => {
  const { adapter, calls } = mock({ deploy: async () => { throw Error('timeout'); } });
  const result = await promote(adapter, release, async () => commit);
  assert.deepEqual(calls, ['rollback']); assert.equal(result.success, false);
});
test('main advancing while waiting for fence prevents deployment', async () => {
  const { adapter, calls } = mock(); let reads = 0;
  const result = await promote(adapter, release, async () => ++reads === 1 ? commit : 'd'.repeat(40));
  assert.equal(result.success, false); assert.deepEqual(calls, []);
});
test('workflow preserves approval, same-run handoff, stale gate and fail-closed barrier', () => {
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
  const cd = readFileSync('.github/workflows/deploy.yml', 'utf8');
  for (const command of ['npm run check', 'npm run typecheck', 'npm test', 'npm run build:web']) assert.ok(ci.includes(command));
  assert.ok(ci.includes('needs: image')); assert.ok(ci.includes('uses: ./.github/workflows/deploy.yml'));
  assert.ok(cd.includes('environment: production')); assert.ok(cd.includes('cancel-in-progress: false'));
  assert.ok(!cd.includes('run-id:')); assert.ok(!cd.includes('workflow_dispatch:'));
  assert.ok(cd.indexOf('Reject stale approval') < cd.indexOf('tailscale/github-action'));
  assert.ok(cd.indexOf('Gateway integration barrier') < cd.indexOf('tailscale/github-action'));
  assert.ok(cd.includes('StrictHostKeyChecking yes'));
  assert.ok(!readFileSync('scripts/deployment-gateway-adapter.sh', 'utf8').includes('sudo docker'));
});
test('mock Gateway project fence serializes simultaneous promotions', async () => {
  const { adapter, calls } = mock();
  const results = await Promise.all([promote(adapter, release, async () => commit), promote(adapter, release, async () => commit)]);
  assert.equal(results.filter((r) => r.success).length, 1); assert.deepEqual(calls, ['deploy']);
});
test('health requires complete typed contracts, not just HTTP success', async () => {
  const health = { status: 'ok' };
  const acceptance = { service: 'personal-ai-control-plane', ready: true, office: { id: 'office-1' }, coordinator: { recoveryMode: false, unknownExecutions: 0, unknownAttempts: 0, unknownSlots: 0 } };
  const office = { id: 'office-1', workflowHealth: { schemaReady: true } };
  assert.equal(acceptanceHealthy(health, health, acceptance, office), true);
  assert.equal(acceptanceHealthy(health, health, { ...acceptance, coordinator: {} }, office), false);
  assert.equal(acceptanceHealthy(health, health, { ...acceptance, coordinator: { ...acceptance.coordinator, unknownSlots: 1 } }, office), false);
  await assert.rejects(() => probeDeployment(async () => ({ status: 201, json: async () => health })));
});
