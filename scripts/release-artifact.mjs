import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const flags = new Map();
for (let index = 0; index < process.argv.length; index += 1) {
  if (!process.argv[index].startsWith("--")) continue;
  const key = process.argv[index].slice(2);
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`missing value for --${key}`);
  flags.set(key, value); index += 1;
}
const setting = (flag, env, fallback = "") => flags.get(flag) ?? process.env[env] ?? fallback;
const commit = setting("commit", "RELEASE_COMMIT");
const repository = setting("repository", "RELEASE_REPOSITORY");
const serviceId = setting("service-id", "RELEASE_SERVICE_ID", "personal-ai-control-plane");
const deploymentProjectId = setting("deployment-project", "RELEASE_DEPLOYMENT_PROJECT_ID", "PersonalAiControlPlane");
const composePath = setting("compose", "RELEASE_COMPOSE_PATH", "compose.prod.yml");
const outputDirectory = resolve(setting("output", "RELEASE_OUTPUT_DIR", "release-artifacts"));
const imageReference = setting("image", "RELEASE_IMAGE_REFERENCE");
const imageDigest = setting("digest", "RELEASE_IMAGE_DIGEST");
if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("RELEASE_COMMIT must be a full 40-character commit SHA");
if (!repository) throw new Error("RELEASE_REPOSITORY is required");
if (!/^[a-z][a-z0-9-]{1,62}$/.test(serviceId)) throw new Error("RELEASE_SERVICE_ID must be a valid platform service ID");
if (!/^[A-Za-z][A-Za-z0-9-]{1,62}$/.test(deploymentProjectId)) throw new Error("RELEASE_DEPLOYMENT_PROJECT_ID must be a valid gateway project ID");
if (!existsSync(composePath)) throw new Error(`missing ${composePath}`);
if (!/^sha256:[0-9a-f]{64}$/.test(imageDigest)) throw new Error("RELEASE_IMAGE_DIGEST must be an immutable digest");
if (!imageReference.includes(`:sha-${commit}`) && !imageReference.includes(`@${imageDigest}`)) throw new Error("image reference must be commit-bound or digest-pinned");
const composeSha256 = createHash("sha256").update(readFileSync(composePath)).digest("hex");
const manifest = { schemaVersion: 1, serviceId, repository, commitSha: commit, imageDigest, composePath, composeSha256, deploymentProjectId, health: { path: "/health", readinessPath: "/health/ready" } };
mkdirSync(outputDirectory, { recursive: true });
writeFileSync(join(outputDirectory, `release-manifest-${commit}.json`), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
console.log(JSON.stringify(manifest));
