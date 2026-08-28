# Personal AI Control Plane

Design documents:

1. [Requirement Definition](docs/personal-ai-control-plane-requirements.md)
2. [High-Level Design](docs/personal-ai-control-plane-hld.md)
3. [Detailed Design](docs/personal-ai-control-plane-detailed-design.md)
4. [Implementation Status](docs/implementation-status.md)

The repository implements the locally verifiable detailed-design contracts. Design documents and local tests do not by themselves authorize production deployment.

## Local foundation slice

Requires Node.js 22.19+.

```bash
npm run check
npm test
npm start
```

The development server listens on `127.0.0.1:9085` and permits local unauthenticated goal admission. Production mode fails closed until the Identity Gateway is connected.

Implemented locally: goal admission/idempotency, plan DAG validation and activation, SQLite migrations, task transitions, leases/fencing and reconciliation, transactional outbox claim/retry, audit-chain verification, pure hard-stop policy evaluation, health endpoints, identity/session/CSRF/recovery contracts, approvals and bounded grants, signed worker enrollment and capability profiles, scheduling/proactive gates, Archive/artifact/credential contracts, typed adapters, configuration/observability/checkpoints/quota/backup contracts, release artifacts, and policy-checked production Compose.

Not enabled: real WebAuthn RP/origin integration, enrolled physical workers, Codex/local-model providers, live ContextHub/Hermes/AIHomePlatform connectors, CUA/wake adapters, and production NAS promotion. Those capabilities remain behind the evidence gates in the [Implementation Status](docs/implementation-status.md) and [Detailed Design](docs/personal-ai-control-plane-detailed-design.md); no API-key fallback or unvalidated production mutation is available.
