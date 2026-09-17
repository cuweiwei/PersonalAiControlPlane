import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";

const installer = new URL("../packaging/macos/install-worker.sh", import.meta.url);
const windowsInstaller = new URL("../packaging/windows/install-worker.ps1", import.meta.url);

test("macOS Worker installer is a self-bootstrapping shell script", () => {
  const path = installer.pathname;
  const source = readFileSync(path, "utf8");
  assert.equal(spawnSync("bash", ["-n", path]).status, 0);
  for (const marker of ["archive_url=", "PAI_OMLX_ENABLED", "PAI_OMLX_API_KEY_FILE", "PAI_LMSTUDIO_ENABLED", "PAI_OLLAMA_ENABLED", "refresh_source", "nodejs.org/dist", "shasum -a 256 -c", "ci --prefix", "launchctl bootstrap", "com.personal-ai.worker", "PAI_CUA_ENABLED:-true", "cua.ai/driver/install.sh", "com.trycua.cua-driver", "CuaDriver.app/Contents/MacOS/cua-driver", "System Settings"]) {
    assert.match(source, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  const plist = readFileSync(new URL("../packaging/macos/com.personal-ai.worker.plist", import.meta.url), "utf8");
  assert.match(plist, /PAI_OMLX_ENABLED/);
  assert.match(plist, /PAI_OMLX_API_KEY_FILE/);
  assert.match(plist, /PAI_LMSTUDIO_ENABLED/);
  assert.match(plist, /PAI_OLLAMA_ENABLED/);
  const driverPlist = readFileSync(new URL("../packaging/macos/com.trycua.cua-driver.plist", import.meta.url), "utf8");
  assert.match(driverPlist, /REPLACE_CUA_DRIVER_APP_EXECUTABLE/);
  assert.match(readFileSync(installer, "utf8"), /CuaDriver\.app\/Contents\/MacOS\/cua-driver/);
  assert.match(driverPlist, /REPLACE_CUA_DRIVER_SOCKET/);
});

test("Windows Worker installer bootstraps source, Node.js, launcher, and Scheduled Task", () => {
  const source = readFileSync(windowsInstaller, "utf8");
  for (const marker of ["source.zip", "nodejs.org/dist", "Get-FileHash", "Expand-Archive", "npm.cmd", "pai-worker.cmd", "pai-worker-scheduled.ps1", "worker.log", "2>&1", "Get-ScheduledTaskInfo", "New-ScheduledTaskAction", "powershell.exe", "-WindowStyle Hidden", "New-ScheduledTaskTrigger", "Register-ScheduledTask", "Start-ScheduledTask", "Get-ActiveWorkerAttemptCount", "pai-worker-journal-", ".cjs", "process.argv[2]", "Start-Process", "-RedirectStandardOutput", "-RedirectStandardError", "worker.db", "ACCEPTED", "RUNNING", "taskkill.exe", "PAI_OMLX_ENABLED", "PAI_LMSTUDIO_ENABLED", "PAI_OLLAMA_ENABLED", "PAI_CUA_ENABLED", "PAI_CUA_DRIVER_EXECUTABLE", "PAI_CUA_DRIVER_SOCKET", "PAI_CUA_DRIVER_MODE", "else { \"true\" }", "cua.ai/driver/install.ps1", "autostart enable", "autostart kick", "interactive-user autostart task", "default named pipe", "status"]) {
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

test("Linux Worker installer bootstraps CUA Driver and user services", () => {
  const path = new URL("../packaging/linux/install-worker.sh", import.meta.url).pathname;
  const source = readFileSync(path, "utf8");
  assert.equal(spawnSync("bash", ["-n", path]).status, 0);
  for (const marker of ["PAI_CUA_ENABLED:-true", "cua.ai/driver/install.sh", "CUA_DRIVER_RS_VERSION", "libxi6", "at-spi2-core", "graphical-session.target", "systemctl --user import-environment", "systemctl --user enable --now", "PAI_CUA_DRIVER_SOCKET", "personal-ai-worker.service", "journalctl --user", "supported CUA Driver Linux desktop", "refusing to replace live Worker files"]) {
    assert.match(source, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(source, /enable-linger|sudo\s+systemctl/);
});

test("Windows Worker journal probe reads active attempts from a .cjs script file", () => {
  const source = readFileSync(windowsInstaller, "utf8");
  const match = source.match(/\$probe = @'\r?\n([\s\S]*?)\r?\n'@/);
  assert.ok(match, "installer must define a standalone journal probe script");
  const directory = mkdtempSync(join(tmpdir(), "pai-worker-journal-test-"));
  const probePath = join(directory, "probe.cjs");
  const databasePath = join(directory, "worker.db");
  try {
    writeFileSync(probePath, match[1]);
    const db = new DatabaseSync(databasePath);
    db.exec("CREATE TABLE assignments(status TEXT NOT NULL); INSERT INTO assignments VALUES ('RUNNING'), ('COMPLETED')");
    db.close();
    const result = spawnSync(process.execPath, [probePath, databasePath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "1");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
