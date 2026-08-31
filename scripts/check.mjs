import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const required = [
  "package.json",
  "apps/orchestrator/src/index.ts",
  "apps/orchestrator/src/db.ts",
  "apps/orchestrator/src/task-engine.ts",
  "apps/orchestrator/src/http.ts",
  "apps/orchestrator/src/outbox.ts",
  "apps/orchestrator/src/plan-service.ts",
  "apps/orchestrator/src/runtime.ts",
  "apps/orchestrator/src/worker-execution.ts",
  "apps/identity-gateway/src/db.ts",
  "apps/identity-gateway/src/service.ts",
  "apps/identity-gateway/src/http.ts",
  "apps/identity-gateway/src/index.ts",
  "apps/identity-gateway/src/grants.ts",
  "packages/contracts/src/index.ts",
  "packages/crypto/src/index.ts",
  "packages/policy/src/index.ts",
  "packages/identity/src/index.ts",
  "packages/scheduler/src/index.ts",
  "packages/worker/src/index.ts",
  "apps/worker/src/db.ts",
  "apps/worker/src/runtime.ts",
  "apps/worker/src/transport.ts",
  "apps/worker/src/bootstrap.ts",
  "apps/worker/src/daemon.ts",
  "apps/worker/src/cli.ts",
  "apps/worker/src/service.ts",
  "apps/worker/src/codex-adapter.ts",
  "packaging/macos/dev.aihome.personal-ai-worker.plist",
  "packaging/macos/install-worker.sh",
  "packaging/windows/install-worker.ps1",
  "apps/orchestrator/src/worker-channel.ts",
  "apps/orchestrator/src/worker-websocket.ts",
  "apps/orchestrator/src/reconciliation.ts",
  "apps/orchestrator/src/approval-service.ts",
  "apps/orchestrator/src/lease-service.ts",
  "apps/archive/src/db.ts",
  "apps/archive/src/service.ts",
  "apps/archive/src/runtime.ts",
  "packages/artifacts/src/index.ts",
  "packages/credentials/src/index.ts",
  "packages/adapters/src/index.ts",
  "apps/orchestrator/src/proactive.ts",
  "apps/orchestrator/src/schedule-service.ts",
  "packages/config/src/index.ts",
  "packages/observability/src/index.ts",
  "packages/checkpoints/src/index.ts",
  "packages/backup/src/index.ts",
  "packages/compute/src/index.ts",
  "Dockerfile",
  "Dockerfile.control-web",
  "compose.prod.yml",
  ".github/workflows/ci.yml",
  "apps/control-web/index.html",
  "apps/control-web/src/app.ts",
  "apps/control-web/src/main.ts",
  "apps/control-web/src/styles.css",
  "apps/control-web/vite.config.ts",
  "apps/control-web/nginx.conf",
  "scripts/release-artifact.mjs",
  "docs/implementation-status.md",
  "schemas/api/v1/goal-create.schema.json",
  "schemas/plan/v1/plan.schema.json",
  "schemas/worker/v1/envelope.schema.json",
  "schemas/worker/v1/channel.schema.json",
];
for (const relative of required) {
  if (!existsSync(resolve(root, relative))) throw new Error(`missing required file: ${relative}`);
}

const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
if (packageJson.name !== "personal-ai-control-plane") throw new Error("unexpected package name");
if (!packageJson.scripts?.test || !packageJson.scripts?.start || !packageJson.scripts?.["build:web"]) throw new Error("required scripts are missing");

const schemas = [
  "schemas/api/v1/goal-create.schema.json",
  "schemas/api/v1/goal-response.schema.json",
  "schemas/plan/v1/plan.schema.json",
  "schemas/worker/v1/envelope.schema.json",
  "schemas/worker/v1/channel.schema.json",
  "schemas/config/v1/system.schema.json",
  "schemas/identity/v1/action-grant.schema.json",
  "schemas/archive/v1/envelope.schema.json",
  "schemas/release/v1/release-manifest.schema.json",
];
for (const relative of schemas) {
  const schema = JSON.parse(readFileSync(resolve(root, relative), "utf8"));
  if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema") throw new Error(`${relative} must declare JSON Schema 2020-12`);
}

console.log(`checked ${required.length} implementation files and ${schemas.length} canonical schemas`);
