# Implementation Status

This document is the implementation companion to the [Detailed Design](personal-ai-control-plane-detailed-design.md). It separates locally verified contracts from capabilities that require owner, machine, provider, or production-gateway evidence.

## Locally implemented and tested

| Detailed-design slice | Local contract | Evidence |
| --- | --- | --- |
| Foundation | SQLite authorities, migrations, goal admission, idempotency, plan DAG validation, task state transitions, outbox, audit chain, restart behavior | `test/task-engine.test.ts`, `test/outbox.test.ts`, `test/fault-injection.test.ts` |
| Identity boundary | One-time challenges, credential counters, secure sessions, rotation/revocation, CSRF, fresh step-up, recovery-code revocation, forward-auth header sanitization | `test/identity-gateway.test.ts`, `test/identity-http.test.ts` |
| Action grants | Ed25519 compact JWS, exact task/attempt/plan/policy/fence bindings, bounded lifetime, key rotation, one-time JTI replay protection | `test/identity.test.ts` |
| Approval and execution safety | Immutable approval decisions, expiry/revocation, lease fencing/reaping, reconciliation records, retry containment | `test/approval.test.ts`, `test/reconciliation.test.ts`, `test/fault-injection.test.ts` |
| Scheduling and proactive control | Eligibility filtering, route ranking, backoff, timezone-aware interval firing, trigger dedupe, separated capability proposal gates | `test/scheduler.test.ts`, `test/proactive-schedule.test.ts` |
| Worker and capability mesh | Signed frames, sequence/replay/clock checks, enrollment proof binding, capability allowlist/digest, filesystem and shell profiles, exact job offers | `test/worker.test.ts` |
| Archive and data plane | Normalized idempotent ingestion, conflict detection, retention precedence, future-block tombstones, checksummed exports, extraction records, content-addressed artifacts, metadata-only credential leases | `test/archive.test.ts` |
| Adapters and operations | Typed disabled adapters, deterministic Hermes classification, strict configuration gates, redacted bounded observability, checkpoints, quota broker, backup/restore-drill manifest, release artifact and production Compose policy | `test/adapters.test.ts`, `test/foundation-ops.test.ts`, `scripts/check.mjs` |

The HTTP surface exposes durable goal/plan/task/event and control-plane read projections. Conversation reads remain an explicit `503 ARCHIVE_NOT_CONNECTED` until the Archive authority is connected; this is intentional fail-closed behavior.

## Evidence-gated capabilities

The following remain disabled even though their contracts and gates are implemented:

| Gate | Missing evidence | Disabled behavior |
| --- | --- | --- |
| `DD-01` | Canonical tailnet origin, RP ID, migration and real WebAuthn RP adapter | Identity routes report not-ready/not-wired; production auth rejects missing forward-auth headers |
| `DD-02` / `DD-03` | Per-device CUA isolation and safe wake/sleep proof | No CUA, wake, or automatic sleep grant |
| `DD-04` | Live local-model inventory and benchmark quality floors | No local-model provider is registered or selected |
| `DD-05` | Supported external AI connector contracts and deletion semantics | Typed adapters stay disabled; no external side effect is attempted |
| `DD-06` | Measured NAS pressure thresholds, backup destination and restore drill | Production retention/backup acceptance remains unverified |
| `DD-07` | Owner-approved Codex human-priority policy and observed quota behavior | Codex execution adapter is not enabled and API-key fallback is prohibited |
| `DD-08` | Exact AIHomePlatform manifest and NAS deployment allowlist project ID | Compose is policy-checked locally; production promotion is not claimed |

## Verification commands

```bash
npm run check
npm test
npm run release:artifact -- --commit <full-commit-sha> --image-digest sha256:<64-hex-digest>
```

Production promotion additionally requires an immutable CI-published image, staging upload and gateway validation, deployment-gateway status, loopback/tailnet health, and expected protected-API `401` behavior. Missing gateway registration or external owner evidence is a hard stop, not a reason to bypass the boundary.
