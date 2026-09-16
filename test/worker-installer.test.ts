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
  for (const marker of ["source.zip", "nodejs.org/dist", "Get-FileHash", "Expand-Archive", "npm.cmd", "pai-worker.cmd", "pai-worker-scheduled.ps1", "worker.log", "2>&1", "Get-ScheduledTaskInfo", "New-ScheduledTaskAction", "powershell.exe", "-WindowStyle Hidden", "New-ScheduledTaskTrigger", "Register-ScheduledTask", "Start-ScheduledTask", "Get-ActiveWorkerAttemptCount", "worker.db", "ACCEPTED", "RUNNING", "taskkill.exe", "PAI_OMLX_ENABLED", "PAI_LMSTUDIO_ENABLED", "PAI_OLLAMA_ENABLED", "PAI_CUA_ENABLED", "PAI_CUA_DRIVER_EXECUTABLE", "PAI_CUA_DRIVER_SOCKET", "PAI_CUA_DRIVER_MODE"]) {
    assert.match(source, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(source, /shell\.Run/);
  const safeStop = source.indexOf("function Stop-ExistingWorkerSafely");
  const activeAttemptGuard = source.indexOf("if ($activeAttempts -gt 0)", safeStop);
  const scheduledTaskStop = source.indexOf("Stop-ScheduledTask", safeStop);
  const postStopJournalCheck = source.indexOf("$activeAttempts = Get-ActiveWorkerAttemptCount $NodePath $Directory", scheduledTaskStop);
  const sourceReplacement = source.indexOf("Move-Item -LiteralPath $sourceCandidate -Destination $sourceCache");
  assert.ok(safeStop >= 0 && activeAttemptGuard > safeStop && scheduledTaskStop > activeAttemptGuard);
  assert.ok(postStopJournalCheck > scheduledTaskStop, "journal must be checked again after stopping the Scheduled Task and before killing processes");
  assert.ok(sourceReplacement > scheduledTaskStop, "source replacement must happen after idle journal verification and process cleanup");
});
