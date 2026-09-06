import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";

const installer = new URL("../packaging/macos/install-worker.sh", import.meta.url);
const windowsInstaller = new URL("../packaging/windows/install-worker.ps1", import.meta.url);

test("macOS Worker installer is a self-bootstrapping shell script", () => {
  const path = installer.pathname;
  const source = readFileSync(path, "utf8");
  assert.equal(spawnSync("bash", ["-n", path]).status, 0);
  for (const marker of ["archive_url=", "PAI_OMLX_ENABLED", "PAI_OMLX_API_KEY_FILE", "PAI_LMSTUDIO_ENABLED", "PAI_OLLAMA_ENABLED", "refresh_source", "nodejs.org/dist", "shasum -a 256 -c", "ci --prefix", "launchctl bootstrap", "com.personal-ai.worker"]) {
    assert.match(source, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  const plist = readFileSync(new URL("../packaging/macos/com.personal-ai.worker.plist", import.meta.url), "utf8");
  assert.match(plist, /PAI_OMLX_ENABLED/);
  assert.match(plist, /PAI_OMLX_API_KEY_FILE/);
  assert.match(plist, /PAI_LMSTUDIO_ENABLED/);
  assert.match(plist, /PAI_OLLAMA_ENABLED/);
});

test("Windows Worker installer bootstraps source, Node.js, launcher, and Scheduled Task", () => {
  const source = readFileSync(windowsInstaller, "utf8");
  for (const marker of ["source.zip", "nodejs.org/dist", "Get-FileHash", "Expand-Archive", "npm.cmd", "pai-worker.cmd", "pai-worker-hidden.vbs", "worker.log", "2>&1", "Get-ScheduledTaskInfo", "New-ScheduledTaskAction", "wscript.exe", "shell.Run", "0, True", "New-ScheduledTaskTrigger", "Register-ScheduledTask", "Start-ScheduledTask", "PAI_OMLX_ENABLED", "PAI_LMSTUDIO_ENABLED", "PAI_OLLAMA_ENABLED"]) {
    assert.match(source, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
