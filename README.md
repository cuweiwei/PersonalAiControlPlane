# Personal AI Control Plane

## System architecture at a glance

[![Personal AI Control Plane system architecture and entry points](docs/assets/personal-ai-control-plane-architecture-zh-TW.svg)](docs/assets/personal-ai-control-plane-architecture-zh-TW.svg)

The diagram distinguishes locally verified capabilities from integrations that still require external or production evidence.

Start here: [Traditional Chinese User Guide](docs/personal-ai-control-plane-user-guide.md)

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
npm run build:web
npm start
```

Worker device bootstrap (development/local channel):

```bash
npm run worker:cli -- enroll
# approve the displayed fingerprint in Control Web; a running worker auto-finalizes from its saved local challenge
npm run worker:cli -- enroll-finalize
npm run worker:cli -- rotate
npm run worker:cli -- status
npm run worker:cli -- start --repo-id <logical-id> --repo-path <git-repository>
# optional: --origin https://<private-control-plane-origin> --data-dir <worker-data-dir>
```

`start` is now bootstrap-aware: it creates an enrollment request when no credential exists, waits for the owner approval, automatically completes proof/finalize, and then starts the WSS worker runtime. `enroll`/`enroll-finalize` remain explicit recovery commands. The current local CLI uses a `0600` file fallback for the device key and credential so the protocol can be exercised. It is intentionally reported as `file-fallback`; the signed production packages must replace it with the native macOS Keychain/Windows Credential Manager helper before production acceptance.

For a resident user-session install, macOS can register the LaunchAgent with `packaging/macos/install-worker.sh <repo-id> <repo-path> [origin] [worker-executable] [log-directory]`; Windows can register the equivalent limited Scheduled Task with `packaging/windows/install-worker.ps1 -RepoId <repo-id> -RepoPath <repo-path> [-Origin <private-origin>]`. Both keep the worker outbound-only and restart it at login; after installation, only the owner fingerprint approval is required.

`npm start` launches one local Node process with Control Web on `127.0.0.1:8080`, the private edge on `127.0.0.1:8081`, Identity on `127.0.0.1:9084`, and Orchestrator on `127.0.0.1:9085`. It opens independent Identity, Orchestrator, and Conversation Archive databases and permits local unauthenticated goal admission. Run `npm run build:web` first so the unified process can serve the static portal. Production mode fails closed until the Identity module is ready.

Implemented locally: goal admission/idempotency, plan DAG validation and activation, SQLite migrations, continuous planner/outbox/scheduler/reconciliation loops, atomic dispatch with lease/fence checks, durable result verification, audit-chain verification, pure hard-stop policy evaluation, WebAuthn with secure sessions, canonical-origin/CSRF enforcement and refresh, Passkey step-up/recovery, non-secret forward-auth, workload-authenticated action grants through opaque key handles, server-derived approval grants, outbound replay-safe worker execution, Archive durable export/delete/purge jobs, owner management APIs and SSE, a responsive single-entry Portal with a Personal AI-owned private edge and read-only ContextHub Memory projection, typed adapters, configuration/observability/checkpoint/quota/backup contracts, single-image release evidence, and policy-checked production Compose. Hermes remains an independently released conversational site and is opened from its Portal status card.

The live private owner edge is `https://gnest.taila77e5f.ts.net/`: an existing Passkey session enters Control Web at `/home` and `/goals`, while unauthenticated and spoofed-identity requests fail with `401 AUTH_REQUIRED`. The Personal AI container owns this edge on loopback `127.0.0.1:9084`; AI Home Platform runtime, its shared edge, and its `:9443` route are retired but remain recoverable in their independent repository and deployment assets. ContextHub Memory is reached through its safe-method projection only. Infrastructure operations are performed by the owner/operator through the root-owned deployment gateway; Orchestrator has no Docker socket, NAS root, or gateway access. Provider-backed execution remains evidence-gated: an owner-selected opaque signing-key authority and workload enrollment, physical-worker OS-vault proof/finalization and capability adapters, Codex/local-model provider evidence, live ContextHub/Hermes connector operations, CUA/wake adapters, backup/restore proof, and provider acceptance are still required. The current source packages Control Web, Identity, and Orchestrator into one non-root runtime process and one container with independent databases. Production registration requires the root-controlled one-time `PAI_BOOTSTRAP_TOKEN`. No API-key fallback, embedded production key, fake readiness flag, or unvalidated production mutation is available.
