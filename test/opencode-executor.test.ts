import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeExecutor } from "../apps/worker/src/executors/opencode.ts";

const execFileAsync = promisify(execFile);

test("OpenCode executor runs in the selected workspace and returns output/diff artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "pai-opencode-executor-"));
  const workspace = join(root, "workspace");
  const executable = join(root, "fake-opencode.sh");
  try {
    await execFileAsync("mkdir", [workspace]);
    await execFileAsync("git", ["init", "-q"], { cwd: workspace });
    await writeFile(join(workspace, "smoke.txt"), "opencode smoke\n", "utf8");
    await writeFile(executable, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo opencode-test-1.0; exit 0; fi\nprintf '%s\\n' '{\"type\":\"tool_use\",\"item\":{\"command\":\"npm test -- smoke\",\"exit_code\":0,\"status\":\"completed\"}}'\n", "utf8");
    await chmod(executable, 0o700);
    const executor = new OpenCodeExecutor({ smoke: workspace }, executable, true);
    assert.equal((await executor.discover()).capabilities?.[0]?.status, "READY");
    const task = { task_id: "task-opencode-test", attempt_id: "attempt-opencode-test", task_type: "opencode", instruction: "run bounded smoke", payload: { workspace_id: "smoke", expected_test_command: "npm test -- smoke" }, execution: { workspace_id: "smoke", worker_id: "worker-opencode-test", runtime: "opencode" }, limits: { timeout_seconds: 60 } } as any;
    const events: any[] = [];
    for await (const event of executor.execute(task)) events.push(event);
    const artifacts = events.filter((event) => event.type === "artifact");
    assert.deepEqual(artifacts.map((event) => event.artifact.artifact_key), ["opencode.output.v1", "opencode.diff.v1"]);
    assert.match(Buffer.from(artifacts[0].artifact.data_base64, "base64").toString("utf8"), /npm test -- smoke/);
    assert.match(Buffer.from(artifacts[1].artifact.data_base64, "base64").toString("utf8"), /smoke\.txt/);
    const result = events.find((event) => event.type === "result");
    assert.equal(result.result.runnerExitCode, 0);
    assert.equal(result.result.userCommandExitCode, 0);
    assert.equal(result.result_manifest.kind, "OPENCODE");
    assert.equal(result.result_manifest.validation.state, "PASSED");
    assert.equal(result.result_manifest.artifacts[0].sha256, artifacts[0].artifact.sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
