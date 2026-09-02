import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";

const installer = new URL("../packaging/macos/install-worker.sh", import.meta.url);

test("macOS Worker installer is a self-bootstrapping shell script", () => {
  const path = installer.pathname;
  const source = readFileSync(path, "utf8");
  assert.equal(spawnSync("bash", ["-n", path]).status, 0);
  for (const marker of ["archive_url=", "nodejs.org/dist", "shasum -a 256 -c", "ci --prefix", "launchctl bootstrap", "com.personal-ai.worker"]) {
    assert.match(source, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
