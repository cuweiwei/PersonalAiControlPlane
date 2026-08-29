import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("release artifact binds both server and Control Web immutable images to one commit", () => {
  const root = resolve(new URL("..", import.meta.url).pathname);
  const output = mkdtempSync(join(tmpdir(), "pai-release-"));
  const commit = "a".repeat(40);
  const serverDigest = `sha256:${"b".repeat(64)}`;
  const webDigest = `sha256:${"c".repeat(64)}`;
  const additional = JSON.stringify([{ serviceId: "personal-ai-control-web", imageReference: `ghcr.io/example/personal-ai-control-web:sha-${commit}`, imageDigest: webDigest }]);
  const result = spawnSync(process.execPath, ["scripts/release-artifact.mjs", "--commit", commit, "--repository", "example/pai", "--image", `ghcr.io/example/personal-ai-control-plane:sha-${commit}`, "--digest", serverDigest, "--additional-images", additional, "--output", output], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(readFileSync(join(output, `release-manifest-${commit}.json`), "utf8"));
  assert.deepEqual(manifest.images.map((image: { serviceId: string; imageDigest: string }) => [image.serviceId, image.imageDigest]), [["personal-ai-control-plane", serverDigest], ["personal-ai-control-web", webDigest]]);
});

test("release artifact rejects an unbound additional image", () => {
  const root = resolve(new URL("..", import.meta.url).pathname);
  const commit = "a".repeat(40);
  const digest = `sha256:${"b".repeat(64)}`;
  const additional = JSON.stringify([{ serviceId: "personal-ai-control-web", imageReference: "ghcr.io/example/personal-ai-control-web:latest", imageDigest: digest }]);
  const result = spawnSync(process.execPath, ["scripts/release-artifact.mjs", "--commit", commit, "--repository", "example/pai", "--image", `ghcr.io/example/personal-ai-control-plane:sha-${commit}`, "--digest", digest, "--additional-images", additional, "--output", mkdtempSync(join(tmpdir(), "pai-release-invalid-"))], { cwd: root, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be commit-bound or digest-pinned/);
});
