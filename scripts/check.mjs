import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const required = [
  "package.json",
  "tsconfig.json",
  "Dockerfile",
  "compose.prod.yml",
  ".github/workflows/ci.yml",
  "apps/control-plane/src/index.ts",
  "apps/control-plane/src/server.ts",
  "apps/control-plane/src/db/database.ts",
  "apps/control-plane/src/tasks/task-service.ts",
  "apps/control-plane/src/tasks/task-state-machine.ts",
  "apps/control-plane/src/scheduler/scheduler.ts",
  "apps/control-plane/src/workers/worker-service.ts",
  "apps/control-plane/src/workers/worker-channel.ts",
  "apps/control-plane/src/callbacks/outbox.ts",
  "apps/control-plane/src/systems/health-monitor.ts",
  "apps/worker/src/cli.ts",
  "apps/worker/src/service.ts",
  "apps/worker/src/enrollment.ts",
  "apps/worker/src/runtime.ts",
  "apps/worker/src/transport.ts",
  "apps/worker/src/local-db.ts",
  "packages/contracts/src/index.ts",
  "packages/worker/src/index.ts",
  "packaging/macos/com.personal-ai.worker.plist",
  "packaging/macos/install-worker.sh",
  "packaging/windows/install-worker.ps1",
  "apps/control-web/index.html",
  "apps/control-web/src/app.ts",
  "apps/control-web/src/main.ts",
  "apps/control-web/src/styles.css",
  "apps/control-web/vite.config.ts",
  "scripts/release-artifact.mjs",
  "docs/implementation-status.md",
  "schemas/api/v2/task-create.schema.json",
  "schemas/worker/v2/message.schema.json",
  "schemas/system/v2/health.schema.json",
  "schemas/release/v1/release-manifest.schema.json",
];
for (const relative of required) {
  if (!existsSync(resolve(root, relative))) throw new Error(`missing required file: ${relative}`);
}

const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
if (packageJson.name !== "personal-ai-control-plane") throw new Error("unexpected package name");
for (const script of ["test", "start", "build:web", "typecheck"]) {
  if (!packageJson.scripts?.[script]) throw new Error(`required script is missing: ${script}`);
}

const forbidden = /(WebAuthn|Passkey|ActionGrant|WorkloadIdentity|CredentialLease|JWS|GoalPlanner|Replanner|ConversationArchive)/i;
const sourceFiles = [
  "apps/control-plane/src/index.ts",
  "apps/control-plane/src/server.ts",
  "apps/control-web/src/app.ts",
  "apps/worker/src/service.ts",
  "apps/worker/src/runtime.ts",
  "apps/worker/src/transport.ts",
  "packages/contracts/src/index.ts",
  "packages/worker/src/index.ts",
];
for (const relative of sourceFiles) {
  if (forbidden.test(readFileSync(resolve(root, relative), "utf8"))) throw new Error(`v1 identity/planning concept remains in ${relative}`);
}

const schemas = [
  "schemas/api/v2/task-create.schema.json",
  "schemas/worker/v2/message.schema.json",
  "schemas/system/v2/health.schema.json",
  "schemas/release/v1/release-manifest.schema.json",
];
for (const relative of schemas) {
  const schema = JSON.parse(readFileSync(resolve(root, relative), "utf8"));
  if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema") throw new Error(`${relative} must declare JSON Schema 2020-12`);
}

console.log(`checked ${required.length} implementation files, ${sourceFiles.length} v2 source files, and ${schemas.length} canonical schemas`);
