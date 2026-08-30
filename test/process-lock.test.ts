import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProcessLock } from "../apps/orchestrator/src/process-lock.ts";

test("process lock reclaims a stale lock after container PID reuse", () => {
  const root = mkdtempSync(join(tmpdir(), "pai-process-lock-"));
  const lockPath = join(root, "orchestrator.lock");
  mkdirSync(lockPath);
  writeFileSync(join(lockPath, "pid"), `${process.pid}\n`, "utf8");
  const lock = new ProcessLock(lockPath);
  try {
    lock.acquire();
    assert.equal(readFileSync(join(lockPath, "pid"), "utf8"), `${process.pid}\n`);
    lock.release();
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
