import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

export class ProcessLock {
  private held = false;
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  acquire(): void {
    try {
      mkdirSync(this.path);
      writeFileSync(`${this.path}/pid`, `${process.pid}\n`, { encoding: "utf8" });
      this.held = true;
      return;
    } catch (error) {
      if (!existsSync(`${this.path}/pid`)) throw error;
      const pid = Number.parseInt(readFileSync(`${this.path}/pid`, "utf8"), 10);
      // Container PID namespaces commonly reuse PID 1 after a recreate. A lock
      // that names this fresh process cannot have been acquired by this
      // ProcessLock instance, so treat it as stale instead of self-blocking.
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
        try {
          process.kill(pid, 0);
          throw new Error(`ORCHESTRATOR_ALREADY_RUNNING:${pid}`);
        } catch (probeError) {
          if (probeError instanceof Error && probeError.message.startsWith("ORCHESTRATOR_ALREADY_RUNNING:")) throw probeError;
          if ((probeError as NodeJS.ErrnoException).code !== "ESRCH") throw probeError;
        }
      }
      rmSync(this.path, { recursive: true, force: true });
      mkdirSync(this.path);
      writeFileSync(`${this.path}/pid`, `${process.pid}\n`, { encoding: "utf8" });
      this.held = true;
    }
  }

  release(): void {
    if (!this.held) return;
    try {
      if (existsSync(`${this.path}/pid`)) {
        const pid = Number.parseInt(readFileSync(`${this.path}/pid`, "utf8"), 10);
        if (pid === process.pid) rmSync(this.path, { recursive: true, force: true });
      }
    } finally {
      this.held = false;
    }
  }
}
