import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexExecutor } from "../apps/worker/src/executors/codex.ts";

const execFileAsync = promisify(execFile);

test("Codex executor captures untracked diff and test log artifacts and separates runner from command status", async () => {
  const root = await mkdtemp(join(tmpdir(), "pai-codex-executor-"));
  const workspace = join(root, "workspace");
  const executable = join(root, "fake-codex.sh");
  try {
    await execFileAsync("mkdir", [workspace]);
    await execFileAsync("git", ["init", "-q"], { cwd: workspace });
    await writeFile(join(workspace, "smoke.txt"), "bounded smoke\n", "utf8");
    await writeFile(executable, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo codex-cli-test; exit 0; fi\nprintf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"type\":\"command_execution\",\"command\":\"npm test -- test/v2-http.test.ts\",\"aggregated_output\":\"TAP test failed\",\"exit_code\":1,\"status\":\"failed\"}}'\n", "utf8");
    await chmod(executable, 0o700);
    const executor = new CodexExecutor({ smoke: workspace }, executable, true);
    assert.equal((await executor.discover()).capabilities?.[0]?.status, "READY");
    const task = {
      task_id: "task-codex-test",
      attempt_id: "attempt-codex-test",
      task_type: "codex",
      instruction: "run bounded smoke",
      payload: { workspace_id: "smoke", expected_test_command: "npm test -- test/v2-http.test.ts" },
      execution: { workspace_id: "smoke", worker_id: "worker-codex-test", runtime: "codex" },
      limits: { timeout_seconds: 60 },
    } as any;
    const events: any[] = [];
    for await (const event of executor.execute(task)) events.push(event);
    const artifacts = events.filter((event) => event.type === "artifact");
    assert.deepEqual(artifacts.map((event) => event.artifact.artifact_key), ["codex.diff.v1", "codex.test-log.v1"]);
    const diffText = Buffer.from(artifacts[0].artifact.data_base64, "base64").toString("utf8");
    const logText = Buffer.from(artifacts[1].artifact.data_base64, "base64").toString("utf8");
    assert.match(diffText, /smoke\.txt/);
    assert.match(logText, /runner_exit_code=0/);
    assert.match(logText, /TAP test failed/);
    const resultEvent = events.find((event) => event.type === "result");
    assert.equal(resultEvent.result.runnerExitCode, 0);
    assert.equal(resultEvent.result.userCommandExitCode, 1);
    assert.deepEqual(resultEvent.result.commandExitCodes, [1]);
    assert.equal(resultEvent.result_manifest.validation.state, "FAILED");
    assert.deepEqual(resultEvent.result_manifest.changes.files, ["smoke.txt"]);
    assert.equal(resultEvent.result_manifest.artifacts[0].sha256, artifacts[0].artifact.sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
