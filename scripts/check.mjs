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
  "apps/identity-gateway/src/db.ts",
  "apps/identity-gateway/src/service.ts",
  "packages/contracts/src/index.ts",
  "packages/crypto/src/index.ts",
  "packages/policy/src/index.ts",
  "packages/identity/src/index.ts",
  "packages/scheduler/src/index.ts",
  "packages/worker/src/index.ts",
  "apps/orchestrator/src/reconciliation.ts",
  "apps/orchestrator/src/approval-service.ts",
  "schemas/api/v1/goal-create.schema.json",
  "schemas/plan/v1/plan.schema.json",
  "schemas/worker/v1/envelope.schema.json",
];
for (const relative of required) {
  if (!existsSync(resolve(root, relative))) throw new Error(`missing required file: ${relative}`);
}

const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
if (packageJson.name !== "personal-ai-control-plane") throw new Error("unexpected package name");
if (!packageJson.scripts?.test || !packageJson.scripts?.start) throw new Error("required scripts are missing");

const schemas = [
  "schemas/api/v1/goal-create.schema.json",
  "schemas/api/v1/goal-response.schema.json",
  "schemas/plan/v1/plan.schema.json",
  "schemas/worker/v1/envelope.schema.json",
  "schemas/config/v1/system.schema.json",
  "schemas/identity/v1/action-grant.schema.json",
];
for (const relative of schemas) {
  const schema = JSON.parse(readFileSync(resolve(root, relative), "utf8"));
  if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema") throw new Error(`${relative} must declare JSON Schema 2020-12`);
}

console.log(`checked ${required.length} implementation files and ${schemas.length} canonical schemas`);
