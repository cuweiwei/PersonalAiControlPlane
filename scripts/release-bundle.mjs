import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const hash = (value) => createHash('sha256').update(value).digest('hex');
export function render(base, repository, digest) {
  if (!/^[a-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !/^sha256:[a-f0-9]{64}$/.test(digest)) throw Error('invalid image identity');
  const lines = base.match(/^    image: .*$/gm) ?? [];
  if (lines.length !== 1) throw Error('expected exactly one image');
  return base.replace(/^    image: .*$/m, `    image: ghcr.io/${repository.split('/')[0]}/personal-ai-control-plane@${digest}`);
}
export function verify(directory, repository, commit, digest, base = readFileSync('compose.prod.yml', 'utf8')) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw Error('invalid commit');
  const manifest = JSON.parse(readFileSync(`${directory}/release-manifest-${commit}.json`, 'utf8'));
  const compose = readFileSync(`${directory}/compose.prod.yml`, 'utf8');
  const expected = render(base, repository, digest);
  if (compose !== expected || manifest.composeSha256 !== hash(compose)) throw Error('Compose policy/hash mismatch');
  if (manifest.schemaVersion !== 1 || manifest.repository !== repository || manifest.commitSha !== commit || manifest.imageDigest !== digest || manifest.deploymentProjectId !== 'PersonalAiControlPlane' || manifest.serviceId !== 'personal-ai-control-plane' || manifest.composePath !== 'compose.prod.yml') throw Error('release identity mismatch');
  const images = [{ serviceId: 'personal-ai-control-plane', imageReference: `ghcr.io/${repository.split('/')[0]}/personal-ai-control-plane@${digest}`, imageDigest: digest }];
  if (JSON.stringify(manifest.images) !== JSON.stringify(images) || manifest.health?.path !== '/healthz' || manifest.health?.readinessPath !== '/readyz') throw Error('image/service allowlist mismatch');
  return manifest;
}
