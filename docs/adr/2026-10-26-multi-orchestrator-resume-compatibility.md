# ADR: Multi-Orchestrator and resumable execution compatibility gate

**Status:** Accepted for staged implementation; native runtime compatibility is not verified.
**Baseline:** repository HEAD `3487625b51a8a90fed526c900343dc1a607b520c` (2026-10-26).
**Decision owners:** implementation owner; runtime claims remain subject to Mac/Windows evidence.

## Repository observations

- `apps/worker/src/executors/opencode.ts` executes the existing one-shot CLI path. It does not persist or continue a native OpenCode session, classify structured quota evidence, or reconcile an uncertain native turn.
- `apps/worker/src/executors/codex.ts` executes the existing one-shot Codex CLI path. It does not own a Managed App Server thread lease or expose a supported Codex Desktop takeover contract.
- `apps/worker/src/runtime.ts` negotiates the existing worker protocol feature list. There are no `agent.session.report`, `agent.resume.request`, or resume-operation journal handlers in the baseline.
- The current PAICP Task/Attempt, Worker, Settings, SQLite, and outbound WebSocket remain the authorities. Existing Hermes Mission state must not be copied into a second Work authority.

## Compatibility result

| Capability | Result | Evidence / consequence |
|---|---|---|
| OpenCode CLI/API native session create, inspect, continue, quota evidence | **NOT VERIFIED** | No native session adapter exists in the checked-out implementation. Windows runtime probing is required before enabling the adapter flag. |
| Codex Managed App Server thread ownership, resume, quota evidence | **NOT VERIFIED** | No Managed Host adapter exists. Do not infer Desktop Thread takeover from `codex exec` or CLI syntax. |
| Native Codex parent/child tree | **NOT VERIFIED / PARTIAL** | No observer exists. PAICP must not create child identities or resume native children. |
| Worker protocol support for recovery messages | **NOT IMPLEMENTED** | The existing feature negotiation is retained; recovery messages must only be introduced with versioned feature negotiation and durable reconciliation. |
| Physical Mac/Windows or production evidence | **NOT AVAILABLE IN THIS SPIKE** | No device-level or production claim is made. No live test or deployment was performed. |

## Decisions

1. Keep the existing OpenCode and Codex executors unchanged as the compatibility fallback.
2. Add settings flags for the future Gateway, session adapters, quota recovery, and native tree observation; initialize all unproven execution routes to `false`.
3. `auto_resume_default_enabled=true` expresses user policy only. It is not an execution capability or authorization; until a supported adapter and recovery engine are verified, automatic resume eligibility remains false.
4. Preserve quota-blocked and ambiguous native side effects as durable conditions in the new schema; do not convert them to generic task failure or retry against another worker.
5. Preserve the legacy Bridge and all current deployment barriers. No cutover is part of this change.

## Required follow-up evidence before enabling flags

- OpenCode versions in scope: documented capability probe, session ID continuity, process restart, authentication presence without token export, structured quota evidence, and duplicate/unknown ACK behavior.
- Mac Codex: supported App Server/SDK protocol version, Managed-only thread lease, Desktop writer collision, parent-first continuation, and partial child-tree observability.
- Cross-service: persistent journal reconciliation, workspace fence behavior, quota-pool identity/fairness, authenticated WS negotiation, and review/PR evidence.

Until each gate has reviewed evidence, report `UNSUPPORTED`/`NOT_ELIGIBLE`; do not issue a model continuation.
