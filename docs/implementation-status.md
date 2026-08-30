# Implementation Status

This document is the implementation companion to the [Detailed Design](personal-ai-control-plane-detailed-design.md). It separates locally verified contracts from capabilities that require owner, machine, provider, or production-gateway evidence.

## Locally implemented and tested

| Detailed-design slice | Local contract | Evidence |
| --- | --- | --- |
| Foundation and runtime | SQLite authorities, migrations, goal admission, idempotency, plan DAG validation, planner/outbox/scheduler loops, atomic task dispatch, lease fencing/reaping, durable result verification, goal projection, restart behavior, retry/DLQ, and reconciliation | `test/task-engine.test.ts`, `test/outbox.test.ts`, `test/runtime.test.ts`, `test/fault-injection.test.ts` |
| Identity boundary | WebAuthn RP registration/authentication, one-time hashed challenges, credential counters, secure sessions, rotation/revocation, canonical-origin enforcement, session-bound CSRF refresh, Passkey step-up, recovery-code login with prior-session revocation, session-backed forward-auth (`GET /api/v1/auth/forward`), and header sanitization | `test/identity-gateway.test.ts`, `test/identity-http.test.ts`, `test/identity-webauthn.test.ts` |
| Approval and action grants | Server-derived immutable approval grants, fresh edge-authenticated step-up, expiry/revocation, Ed25519 compact JWS, opaque key handles, signed workload requests, exact task/attempt/plan/policy/fence/approval/budget/sandbox binding, bounded lifetime, key rotation, and durable one-time JTI protection | `test/approval.test.ts`, `test/http.test.ts`, `test/identity.test.ts`, `test/identity-grants.test.ts`, `test/worker-runtime.test.ts` |
| Scheduling and proactive control | Eligibility filtering, route ranking, backoff, timezone-aware interval firing, trigger dedupe, separated capability proposal gates | `test/scheduler.test.ts`, `test/proactive-schedule.test.ts` |
| Worker and capability mesh | Signed frames, sequence/replay/clock checks, hashed-challenge enrollment request/owner approval, capability discovery/grant separation, filesystem and shell profiles including absolute-path privilege-command rejection, exact job offers, drain/revoke state, outbound polling, durable accept-before-execute, local concurrency, checkpoint/result persistence, and replay-safe result resend | `test/worker.test.ts`, `test/worker-runtime.test.ts`, `test/http.test.ts` |
| Archive and data plane | Normalized idempotent ingestion, conflict detection, retention precedence, future-block tombstones, owner read projections, durable export/delete jobs, content-addressed export bundles, retry/DLQ, cross-authority live-reference checks, and artifact-authority-gated verified purge | `test/archive.test.ts`, `test/archive-runtime.test.ts`, `test/http.test.ts` |
| Owner API and Control Web | Owner-safe goal/plan/DAG/attempt/checkpoint/reconciliation, approval, schedule, worker/capability/enrollment, compute/quota, conversation/job, connector, credential, policy, audit and system projections; durable local mutations; SSE cursor snapshots; React/TypeScript/Vite management routes with exact-bound approval editing, Passkey-sensitive actions, confirmation, REST reconstruction, loading/error/empty states, keyboard/mobile/reduced-motion support | `test/http.test.ts`, `test/control-web.test.ts`, `npm run build:web` |
| Delivery | Unprivileged static Control Web image plus dual commit-bound Linux/amd64 server/web image build and release-digest contract | `test/release-artifact.test.ts`, `.github/workflows/ci.yml` |
| Adapters and operations | Typed disabled adapters, deterministic Hermes classification, strict configuration gates, redacted bounded observability, checkpoints, quota broker, and backup/restore-drill manifest | `test/adapters.test.ts`, `test/foundation-ops.test.ts`, `scripts/check.mjs` |

The production Orchestrator startup opens the independent `conversation.db` authority, runs the Archive durable-job loop, and exposes owner-scoped conversation read/export/delete/job projections. Embedders that omit `ArchiveService` still receive explicit `503 ARCHIVE_NOT_CONNECTED`; no implicit fallback or cross-database write is used.

The local fake-provider path now verifies `goal -> plan -> approval when required -> action grant -> outbound worker -> durable result -> verification -> completion`. Goal detail reconstructs immutable plans, task dependencies, attempts, checkpoints, evidence and reconciliation from REST. Browser mutations obtain a fresh session-bound CSRF token; sensitive approval, policy, capability, worker-revoke and conversation-delete actions perform Passkey step-up. Missing external ports do not consume command outbox rows, and production readiness stays false rather than substituting a permissive fake adapter.

## External integration and acceptance gates

These adapters cannot be selected or accepted honestly from repository-only evidence. Their absence is reflected in readiness/disabled states; it is not replaced with environment booleans or embedded credentials.

| Gate | Missing external evidence or owner choice | Fail-closed behavior |
| --- | --- | --- |
| `DD-01` identity/edge | Production opaque signing-key provider/key handles, Orchestrator workload enrollment, and any live credential migration source inspection | The checked-in AIHomePlatform edge contract routes the canonical origin to login, Control Web, Orchestrator API/SSE, and forward-auth; no raw session secret or client identity header is forwarded |
| `DD-02` / `DD-03` machine control | Approved enrollment request still needs physical-device OS-vault proof/finalization, outbound transport, approved capability adapters, per-device CUA isolation, and safe wake/sleep proof | Enrollment stops at `AWAITING_WORKER_PROOF`; no physical job, CUA, wake, or automatic sleep grant is issued |
| `DD-04` / `DD-07` compute | Selected planner/executor adapters, live local-model inventory/quality floors, Codex ChatGPT-login worker, owner human-priority policy, and observed quota behavior | Production Orchestrator runtime readiness remains false; no provider is registered and API-key fallback is prohibited |
| `DD-05` connectors | Supported ContextHub, Hermes, external-AI connector versions and provider deletion semantics | Connector list/status is visible; run/reauthorize remain explicit `CONNECTOR_NOT_CONFIGURED`, their outbox topics are not consumed, and no external side effect is attempted |
| `DD-06` data operations | Production Artifact root/ACL, measured NAS pressure thresholds, backup destination, pinned-artifact snapshot, and isolated restore/purge evidence | Archive jobs fail visibly when artifact authority is unavailable; production retention/backup acceptance is not claimed |
| Control Web edge | CI-published server/web image digests and live tailnet acceptance | The service joins only the AIHomePlatform edge network and the login page redirects authenticated sessions to `/goals`; repository evidence alone does not claim the owner portal is reachable |
| `DD-08` release/NAS | CI run for the current commit, both immutable image digests, exact AIHomePlatform manifest, exact NAS deployment allowlist ID, gateway validation/deploy/status, and live auth/health/rollback evidence | Compose and the multi-image manifest contract are checked locally; production promotion is blocked |

## Verification commands

```bash
npm run check
npm test
npm run build:web
npm run release:artifact -- --commit <full-commit-sha> --repository <owner/repo> --image <server-commit-bound-image> --digest sha256:<64-hex-digest> --additional-images '<control-web-image-json>'
```

Production promotion additionally requires both immutable CI-published images, staging upload and gateway validation, deployment-gateway status, loopback/tailnet health, and expected protected-API `401` behavior. Missing gateway registration or external owner evidence is a hard stop, not a reason to bypass the boundary.

`PAI_OPERATIONAL_PROFILE=compatibility` is the recovery profile for a schema-forward deployment when the opaque action-grant authority and execution providers are not yet wired. It keeps those routes fail-closed and reports them as `not_required` for legacy traffic readiness; it does not mark action grants, providers, workers, or external adapters as available. Remove the profile only after their live evidence gates pass.

## Production owner enrollment

The Identity Gateway's browser entry point is the same HTTPS origin configured as `PAI_CANONICAL_ORIGIN`. The URL must include the port when the Tailscale route uses a non-default HTTPS port; for example:

```text
https://gnest.taila77e5f.ts.net:9084/
```

The root-owned production environment must contain matching non-secret configuration (for the example route, `PAI_CANONICAL_ORIGIN=https://gnest.taila77e5f.ts.net:9084` and `PAI_WEBAUTHN_RP_ID=gnest.taila77e5f.ts.net`) and a one-time `PAI_BOOTSTRAP_TOKEN`. The token is entered only in the browser enrollment form, then removed or rotated by the owner after the first credential is registered. The gateway stores only a hash of each challenge and recovery code; it never logs the token or raw challenge.

### Forward-auth contract

The AIHomePlatform-owned private edge calls `GET /api/v1/auth/forward` as its authentication subrequest before forwarding a browser request to the portal or Orchestrator. It sets `x-forwarded-method` to the original uppercase method. For an unsafe method, it also forwards only the browser `Cookie`, `Origin`, and `x-pai-csrf-token` needed by the authentication subrequest; the gateway validates them against the session. Before the original request reaches Control Web or Orchestrator, the edge strips the raw cookie and CSRF header and replaces any client-supplied `x-pai-*` identity claims with gateway response headers.

- Valid session: `204 No Content` with gateway-generated `x-pai-verified`, `x-pai-owner-id`, `x-pai-session-id`, `x-pai-auth-time`, and `x-pai-request-id` response headers. `x-pai-session-id` is the non-secret database row ID; the raw `pai_session` cookie value is never forwarded upstream.
- Missing, expired, or revoked session: `401 AUTH_REQUIRED`.
- The edge must copy only those response headers to the upstream request and must strip the same headers supplied by the original client. It must not expose the session header set to the browser or use a static owner token.

Identity browser mutations reject a missing or mismatched canonical `Origin`. `POST /api/v1/auth/step-up/options` and `/step-up/finish` require the current session-bound `x-pai-csrf-token`; successful step-up rotates the session. `POST /api/v1/auth/recovery` consumes a one-time hashed recovery code, revokes prior sessions, and returns a new secure session plus CSRF token. `POST /api/v1/auth/logout` also requires the session-bound CSRF token.

The same-origin portal obtains a fresh token from `GET /api/v1/auth/csrf` before each browser mutation. The endpoint requires the HttpOnly session cookie, rotates the stored CSRF hash, returns `Cache-Control: no-store`, and never returns or forwards the raw session secret.
