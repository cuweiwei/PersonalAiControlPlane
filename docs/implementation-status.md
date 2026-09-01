# Implementation Status

This document is the implementation companion to the [Detailed Design](personal-ai-control-plane-detailed-design.md). It separates locally verified contracts from capabilities that require owner, machine, provider, or production-gateway evidence.

## Separation update (2026-08-31)

Personal AI now owns its complete private edge inside the single non-root container: Tailscale HTTPS `:443` continues to target NAS loopback `127.0.0.1:9084`, which publishes the edge listener on container port `8081`. Identity, Control Web, Orchestrator/SSE, Worker WSS, and the safe-method ContextHub Memory projection are routed without AI Home Platform runtime dependencies, shared networks, aliases, or Traefik. ContextHub keeps its `:8788` Tailscale/loopback listener private and provides a Docker host-bridge-only `:18788` ingress for the Personal AI container. AI Home Platform is a stopped, recoverable system of record for its own data and release assets; its runtime, `:9443` Serve route, Portal infrastructure projection, and Personal AI service registration are retired. Deployment and infrastructure operations remain owner/operator actions through the root-owned deployment gateway; Orchestrator has no Docker socket, NAS root, or gateway access.

## Locally implemented and tested

| Detailed-design slice | Local contract | Evidence |
| --- | --- | --- |
| Foundation and runtime | SQLite authorities, migrations, goal admission, idempotency, plan DAG validation, planner/outbox/scheduler loops, atomic task dispatch, lease fencing/reaping, durable result verification, goal projection, restart behavior, retry/DLQ, and reconciliation | `test/task-engine.test.ts`, `test/outbox.test.ts`, `test/runtime.test.ts`, `test/fault-injection.test.ts` |
| Identity boundary | WebAuthn RP registration/authentication, one-time hashed challenges, credential counters, secure sessions, rotation/revocation, canonical-origin enforcement, session-bound CSRF refresh, Passkey step-up, recovery-code login with prior-session revocation, session-backed forward-auth (`GET /api/v1/auth/forward`), and header sanitization | `test/identity-gateway.test.ts`, `test/identity-http.test.ts`, `test/identity-webauthn.test.ts` |
| Approval and action grants | Server-derived immutable approval grants, fresh edge-authenticated step-up, expiry/revocation, Ed25519 compact JWS, opaque key handles, signed workload requests, exact task/attempt/plan/policy/fence/approval/budget/sandbox binding, bounded lifetime, key rotation, and durable one-time JTI protection | `test/approval.test.ts`, `test/http.test.ts`, `test/identity.test.ts`, `test/identity-grants.test.ts`, `test/worker-runtime.test.ts` |
| Scheduling and proactive control | Eligibility filtering, route ranking, backoff, timezone-aware interval firing, trigger dedupe, separated capability proposal gates | `test/scheduler.test.ts`, `test/proactive-schedule.test.ts` |
| Worker and capability mesh | Signed frames, sequence/replay/clock checks, staged enrollment lifecycle with expiry, Passkey enrollment-request cleanup, short-lived credential rotation, authenticated HTTP poll/events channel, durable connection/message queue, aggregated connection/dispatch/activity/credential/capability/provider/diagnostic projections, atomic permanent Worker purge with minimal tombstone and historical task/audit retention, Drain/Resume offer gating, capability revoke and descriptor supersession, signed bounded heartbeat runtime reports, terminal `WORKER_REMOVED` Agent behavior with explicit `pai-worker reset`, filesystem and shell profiles including absolute-path privilege-command rejection, exact job offers, outbound polling, durable accept-before-execute, local concurrency, checkpoint/result persistence, replay-safe result resend, Worker daemon/CLI and Codex exec adapter skeleton | `test/worker.test.ts`, `test/worker-runtime.test.ts`, `test/worker-channel.test.ts`, `test/http.test.ts`, `apps/worker/src/*` |
| Archive and data plane | Normalized idempotent ingestion, conflict detection, retention precedence, future-block tombstones, owner read projections, durable export/delete jobs, content-addressed export bundles, retry/DLQ, cross-authority live-reference checks, and artifact-authority-gated verified purge | `test/archive.test.ts`, `test/archive-runtime.test.ts`, `test/http.test.ts` |
| Owner API and Portal | Owner-safe goal/plan/DAG/attempt/checkpoint/reconciliation, approval, schedule, Worker lifecycle and enrollment projections with explicit status/action conditions, compute/quota, conversation/job, connector, credential, policy, audit and system projections; single `/home` entry; `/systems` for Personal AI and independent external links; read-only ContextHub `/memory` projection; Hermes status plus independent-site link; durable local Orchestrator mutations; SSE cursor snapshots; keyboard/mobile/reduced-motion support; immutable static asset caching with SPA fallback | `test/http.test.ts`, `test/control-web.test.ts`, `test/private-edge.test.ts`, `npm run build:web` |
| Delivery | One non-root Linux/amd64 image and container for built Control Web assets, Identity, Orchestrator, and Archive; one commit-bound release digest | `test/control-plane.test.ts`, `test/release-artifact.test.ts`, `.github/workflows/ci.yml` |
| Adapters and operations | Typed ContextHub HTTP adapter (compile/propose/successor/outcome/change cursor), deterministic Hermes classification, detached Ed25519 Hermes workload ingress, strict configuration gates, redacted bounded observability, checkpoints, quota broker, and backup/restore-drill manifest | `test/adapters.test.ts`, `test/workload-auth.test.ts`, `test/foundation-ops.test.ts`, `scripts/check.mjs` |

The unified Control Plane startup opens the independent `identity.db`, `orchestrator.db`, and `conversation.db` authorities, serves the built portal, runs the Archive durable-job loop, and exposes owner-scoped conversation read/export/delete/job projections. Embedders that omit `ArchiveService` still receive explicit `503 ARCHIVE_NOT_CONNECTED`; no implicit fallback or cross-database write is used.

The 2026-09-01 adapter slice is locally implemented but intentionally not
activated in production. `ContextHubHttpAdapter` uses the namespace-bound API
key supplied through the root-controlled environment and remains behind
`PAI_CONTEXT_HUB_ADAPTER_ENABLED=false`; a goal with `memoryRequirement=required`
fails closed when that adapter is unavailable. Hermes has a small Python client
that signs each `/api/v1/*` request with a root-controlled Ed25519 private key.
The Personal AI edge forwards only requests carrying the workload marker to
Orchestrator, where the signature, timestamp, body digest, nonce, owner mapping,
and Hermes operation allowlist are checked. This is an implementation and CI
claim, not live connector or owner-enrollment evidence. When the public key is
passed through a Compose environment file, encode PEM line breaks as `\\n`;
startup normalizes them without writing the key to logs or the repository.

The single-container topology is `live_verified` for the Personal AI edge: source, tests, Docker build definition, Compose shape, and single-image CI contract are promoted through the NAS deployment gateway. The ContextHub Memory transport is live-reachable over its Docker host-bridge ingress, while owner projection remains fail-closed until a registered `personal-ai` web principal is linked to a human client.

The local fake-provider path now verifies `goal -> plan -> approval when required -> action grant -> outbound worker -> durable result -> verification -> completion`. Goal detail reconstructs immutable plans, task dependencies, attempts, checkpoints, evidence and reconciliation from REST. Browser mutations obtain a fresh session-bound CSRF token; sensitive approval, policy, capability, worker-revoke and conversation-delete actions perform Passkey step-up. Missing external ports do not consume command outbox rows, and production readiness stays false rather than substituting a permissive fake adapter.

The Worker management slice now supports explicit `PENDING → OWNER_APPROVED → PROOF_COMPLETED → REGISTERED → ONLINE` projection, expiry of stale approved requests, Passkey idempotent request cleanup, aggregated status/action views, atomic permanent purge with a non-display tombstone, Drain/Resume offer gating, descriptor-bound capability revoke/supersession, and signed bounded runtime heartbeats. Purged channel identities receive `410 WORKER_REMOVED`; the Agent enters a terminal state until an operator runs `pai-worker reset --confirm`, which creates a new key before re-enrollment. `start` remains bootstrap-aware and `enroll`/`enroll-finalize` remain recovery commands. The current development CLI deliberately reports `file-fallback` for key/credential storage and uses the Codex CLI adapter; neither is production evidence for native OS-vault storage, signed desktop packages, production edge WSS/TLS acceptance, or provider acceptance.

The self-edge integration is `live_verified`. Personal AI strips client-supplied `x-pai-*` identity claims, cookie, CSRF, authorization, and hop-by-hop headers at the edge, runs its Identity forward-auth subrequest for browser routes, and injects only verified non-secret identity headers. The separate workload route preserves only the `x-pai-workload-*` proof headers so Orchestrator can verify them; it never trusts client-supplied owner claims. Internal Control Web, Identity, and Orchestrator listeners bind to container loopback; only the edge is host-published. Worker HTTP/WebSocket routes use signed worker credentials and never browser sessions. Audit-chain verification runs at startup and on a bounded interval, while readiness serves the cached fail-closed result. ContextHub maps the forwarded owner UUID only when an enrolled `personal-ai` web principal is linked to a human client, and only safe methods reach the Memory projection. `/infrastructure` and its Portal API return `404`; no Portal request reaches AI Home Platform.

## Live production evidence (2026-09-01)

- Personal AI gateway status is healthy on image `ghcr.io/cuweiwei/personal-ai-control-plane@sha256:392d741bae25f95b825240a4791607289191ff9fc47cd9785be110e98e0c458b`; its self-edge publishes `127.0.0.1:9084 -> 8081` and keeps `:9083`/`:9085` internal service ports.
- ContextHub gateway status is healthy on image `ghcr.io/cuweiwei/contexthub@sha256:c3058728d278856e9402a43d1cc51dc877a4cf94ce77c171b88e4bbb8ffed523`; `127.0.0.1:8788` remains the Tailscale-facing port and `172.17.0.1:18788` is the Docker host-bridge-only Personal AI ingress.
- Passkey authenticated browser acceptance reached `/home`, `/goals`, `/approvals`, `/schedules`, `/workers`, and `/systems`. Systems shows Personal AI, ContextHub, and Hermes as independent; no AI Home Platform projection or navigation remains. The Memory page reaches ContextHub but correctly reports `control_unauthorized` because the `personal-ai` web principal is not yet linked to a human namespace client.
- AI Home Platform gateway status has no running container; `/health/live` and `/health/ready` return `200`, protected goals and unauthenticated Memory return `401 AUTH_REQUIRED`, infrastructure paths return `404`, and `:9443` is closed. This is edge/separation evidence, not provider or ContextHub owner-enrollment evidence.

## Live production evidence (2026-08-30)

- Personal AI source commit `060c7ce2580d961a86af70cbd314dec4a14fd9b1` passed CI run `33308375983`. Its commit-bound server image is `sha256:700ffe6275452205efc7fcc36486ef7852b6733bd0cdcf67e5bece0d9354d6dd`, and Control Web is `sha256:e6511fc0ce98ca1a8a6a956ee6bf185d2c4d154fc715f0e84ae46310512a7dc8`. Pin-only commit `014d7616223bcd2e195d84589791fc421880eb3a` passed run `33308589867`.
- AIHomePlatform edge source commit `67c281554eedaa417154b712c08feb30aee52e2d` passed CI run `33308376916` and release run `33308376939`, publishing `sha256:7ea9bf59182f083ebe5591f46497ea49defb4e2067326760c343635639b5e52e`. Pin-only commit `86a14cfb928101f5f7ab03a7c12a0c25bda8afb0` passed run `33308542614`.
- The previous Personal AI and AIHomePlatform releases passed root-owned deployment-gateway allowlist lookup, staging validation, deploy, and status. The separation release must repeat Personal AI and ContextHub gateway evidence; AIHomePlatform is intentionally staged/validated only and must remain stopped.
- Loopback and tailnet `/health/ready` returned `200`; unauthenticated `/api/v1/goals`, direct `/goals`, and spoofed `x-pai-*` identity headers returned `401 AUTH_REQUIRED`. In the owner's existing Passkey browser session, `/` redirected to `/goals`; Goals and System completed their REST authority synchronization without browser errors.
- This proves the private owner edge is `live_verified`. It does not promote execution adapters to `provider_verified`: production still reports `providers=not_configured`, `workers=not_configured`, `runtime=not_required` under the compatibility profile, and `backupRestore=not_verified`.

## External integration and acceptance gates

These adapters cannot be selected or accepted honestly from repository-only evidence. Their absence is reflected in readiness/disabled states; it is not replaced with environment booleans or embedded credentials.

| Gate | Missing external evidence or owner choice | Fail-closed behavior |
| --- | --- | --- |
| `DD-01` identity/edge | Production opaque signing-key provider/key handles, Orchestrator workload enrollment, Hermes private-key installation, and any live credential migration source inspection | The Personal AI-owned edge routes the canonical origin to login, Control Web, Orchestrator API/SSE, Worker WSS, and forward-auth; optional workload ingress fails closed until its owner mapping and public key are installed; no raw session secret, cookie, CSRF token, or client identity header is forwarded |
| `DD-02` / `DD-03` machine control | Native Keychain/Credential Manager signer, signed desktop installers, production edge WSS/TLS acceptance, physical-device capability/provider evidence, per-device CUA isolation, and safe wake/sleep proof | Device enrollment, HTTP fallback, and a WSS-primary transport are locally implemented, but production readiness remains false while the native vault, signed packages, edge acceptance, and physical/provider evidence are absent |
| `DD-04` / `DD-07` compute | Selected planner/executor adapters, live local-model inventory/quality floors, Codex ChatGPT-login worker, owner human-priority policy, and observed quota behavior | Production Orchestrator runtime readiness remains false; no provider is registered and API-key fallback is prohibited |
| `DD-05` connectors | ContextHub namespace-bound client enrollment, Hermes workload enrollment/private-key installation, supported connector versions, and provider deletion semantics | Typed adapters and Hermes request policy are present locally; runtime activation remains disabled or `401` until the owner-controlled enrollment and live acceptance gates pass; no external side effect is attempted |
| `DD-06` data operations | Production Artifact root/ACL, measured NAS pressure thresholds, backup destination, pinned-artifact snapshot, and isolated restore/purge evidence | Archive jobs fail visibly when artifact authority is unavailable; production retention/backup acceptance is not claimed |
| `DD-08` future release/NAS | Every later release still needs a commit-bound CI run, the unified immutable image digest, the PersonalAiControlPlane gateway allowlist ID, gateway validation/deploy/status, and live auth/health/rollback evidence; ContextHub follows its own gateway | The prior owner edge release is historical; no later source or pin is promoted from repository evidence alone |

## Verification commands

```bash
npm run check
npm run typecheck
npm test
npm run build:web
npm run release:artifact -- --commit <full-commit-sha> --repository <owner/repo> --image <unified-commit-bound-image> --digest sha256:<64-hex-digest>
```

Production promotion additionally requires the immutable CI-published unified image, staging upload and gateway validation, deployment-gateway status, all three internal readiness probes, loopback/tailnet health, and expected protected-API `401` behavior. Missing gateway registration or external owner evidence is a hard stop, not a reason to bypass the boundary.

`PAI_OPERATIONAL_PROFILE=compatibility` is the recovery profile for a schema-forward deployment when the opaque action-grant authority and execution providers are not yet wired. It keeps those routes fail-closed and reports them as `not_required` for legacy traffic readiness; it does not mark action grants, providers, workers, or external adapters as available. Remove the profile only after their live evidence gates pass.

## Production owner enrollment

The Identity Gateway's browser entry point is the same HTTPS origin configured as `PAI_CANONICAL_ORIGIN`. The production Compose pins the non-secret canonical origin to the default HTTPS port:

```text
https://gnest.taila77e5f.ts.net/
```

The root-owned production environment must contain `PAI_WEBAUTHN_RP_ID=gnest.taila77e5f.ts.net` and a one-time `PAI_BOOTSTRAP_TOKEN`; the Compose-owned `PAI_CANONICAL_ORIGIN` must match the Tailscale HTTPS route. The token is entered only in the browser enrollment form, then removed or rotated by the owner after the first credential is registered. The gateway stores only a hash of each challenge and recovery code; it never logs the token or raw challenge.

The previous live route acceptance verified the default HTTPS Personal AI entry, authenticated `/home`, `/goals`, and `/systems`, `401 AUTH_REQUIRED` for unauthenticated and spoofed-identity requests, and HTTP 200 readiness. That evidence predates the self-edge image and is not a current production claim. The planned acceptance must verify `443 → 127.0.0.1:9084 → :8081`, the stopped AI Home Platform project, and the retired `:9443` route.

### Personal AI private-edge forward-auth contract

The Personal AI private edge calls `GET /api/v1/auth/forward` as its authentication subrequest before forwarding a browser request to Control Web, Orchestrator, or ContextHub Memory. It sets `x-forwarded-method` to the original uppercase method. For an unsafe method, it also forwards only the browser `Cookie`, `Origin`, and `x-pai-csrf-token` needed by the authentication subrequest; Identity validates them against the session. Before a browser request reaches an upstream, the edge strips the raw cookie, CSRF header, and all client-supplied `x-pai-*` identity claims, then injects only the verified non-secret headers. Workload requests are a separate path: only `x-pai-workload-*` proof headers are retained, and Orchestrator verifies the signature, timestamp, body digest, nonce, owner mapping, and operation policy.

- Valid session: `204 No Content` with gateway-generated `x-pai-verified`, `x-pai-owner-id`, `x-pai-session-id`, `x-pai-auth-time`, and `x-pai-request-id` response headers. `x-pai-session-id` is the non-secret database row ID; the raw `pai_session` cookie value is never forwarded upstream.
- Missing, expired, or revoked session: `401 AUTH_REQUIRED`.
- The edge must copy only those response headers to the upstream request and must strip the same headers supplied by the original client. It must not expose the session header set to the browser or use a static owner token.

Identity browser mutations reject a missing or mismatched canonical `Origin`. `POST /api/v1/auth/step-up/options` and `/step-up/finish` require the current session-bound `x-pai-csrf-token`; successful step-up rotates the session. `POST /api/v1/auth/recovery` consumes a one-time hashed recovery code, revokes prior sessions, and returns a new secure session plus CSRF token. `POST /api/v1/auth/logout` also requires the session-bound CSRF token.

The same-origin portal obtains a fresh token from `GET /api/v1/auth/csrf` before each browser mutation. The endpoint requires the HttpOnly session cookie, rotates the stored CSRF hash, returns `Cache-Control: no-store`, and never returns or forwards the raw session secret.
