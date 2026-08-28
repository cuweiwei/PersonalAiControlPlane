# Personal AI Control Plane

Design documents:

1. [Requirement Definition](docs/personal-ai-control-plane-requirements.md)
2. [High-Level Design](docs/personal-ai-control-plane-hld.md)
3. [Detailed Design](docs/personal-ai-control-plane-detailed-design.md)

The repository is implementing the foundation slice locally. Design documents do not by themselves authorize production deployment.

## Local foundation slice

Requires Node.js 22.19+.

```bash
npm run check
npm test
npm start
```

The development server listens on `127.0.0.1:9085` and permits local unauthenticated goal admission. Production mode fails closed until the Identity Gateway is connected.

Implemented in this slice: goal admission/idempotency, plan DAG validation and activation, SQLite migrations, task transitions, lease/fencing schema, transactional outbox claim/retry, audit-chain verification, pure hard-stop policy evaluation, health endpoints, restart-safe tests, and an EdDSA action-grant contract with exact task/attempt/plan/fence binding and one-time replay checks.

Not enabled yet: the WebAuthn/Passkey Identity Gateway (including sessions and step-up), real LLM planner, enrolled workers, Codex/Local LLM providers, ContextHub/Hermes/AIHomePlatform adapters, production Compose, and NAS deployment. The action-grant contract is a local prerequisite, not a production authentication implementation. Remaining work stays behind the separate implementation and evidence gates described in the [Detailed Design](docs/personal-ai-control-plane-detailed-design.md).
