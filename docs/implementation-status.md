# v2 實作狀態與證據

更新：2026-10-26

## 本機 repository evidence

| 區域 | 狀態 | 證據 |
| --- | --- | --- |
| Unified Control Plane process | `implemented_local` | `apps/control-plane/src/index.ts` 建立單一 server、scheduler、health、callback loops |
| Fresh SQLite authority | `implemented_local` | `apps/control-plane/src/db/database.ts` 只建立 v2 `controlplane.db` schema |
| Task lifecycle/fencing | `implemented_local` | task service、state machine、attempt/event tables 與 `test/v2-core.test.ts` |
| Worker enrollment/token hash | `implemented_local` | registration phase/expiry、OS credential backend、removed terminal state、reset 與 SHA-256 token hash |
| Worker management projection | `implemented_local` | connection/dispatch/activity/credential/provider/diagnostics aggregate、search/filter/detail、rename、drain/resume、capability revoke |
| Worker purge/audit | `implemented_local` | busy-safe idempotent purge、credential/inventory cleanup、minimal tombstone、append-only audit chain |
| Worker WS/runtime durability | `implemented_local` | hello acknowledgement、outbound WS、local assignment/result persistence、cancel fencing、result ack/resend、artifact protocol |
| Worker CUA Computer Use | `implemented_local` with live gates | `computer.use` capability/feature negotiation、長駐 Cua Driver MCP adapter、opaque window refs、session scope/revision/lease、desktop lock、UNKNOWN effect 對帳、24 小時 observation artifact、Hermes computer tools；實體 Worker/VM、OS permission、vision provider 與 NAS live E2E 尚未宣告 |
| Scheduler filtering/scoring | `implemented_local` | capability/runtime/model/resource/load rules 與 core tests |
| Artifact storage | `implemented_local` | task-scoped storage、digest、worker-authenticated upload/download 與 HTTP test |
| Hermes callback outbox | `live_verified` | claim、at-least-once POST、bounded retry；live Hermes callback receiver 回 `202 accepted` |
| Systems health | `live_verified` | NAS shared network 上 Hermes/ContextHub 均回 `HEALTHY HTTP_200` |
| Control Web | `implemented_local` | React/Vite Dashboard、Tasks、Workers、Models、Systems、Settings |
| Virtual Office domain | `implemented_local` | Office/Mission schema migrations 7–10、strict Mission/Plan contracts、role/member configuration、idempotent intake、transactional Plan validation/activation、Mission Coordinator DAG execution、pause/cancel、resource/limit gates、Office/Mission HTTP projection；`test/virtual-office*.test.ts` |
| Hermes wake-up and recovery contract | `implemented_local` | Durable command dispatcher、transport lease recovery、authority epoch/fencing、CP admission/progress/stop/result/delivery receipts；Hermes-side `services/hermes_office_adapter/` durable inbox、bounded fixed HTTP BrainDriver、idempotent command receive；provider turn execution remains unverified |
| Worker mission execution | `implemented_local` | Mission task ownership、protocol negotiation、mission context、workspace `WRITE_EXCLUSIVE` exclusion、conservative stop evidence and cross-restart result durability |
| Virtual Office UI | `implemented_local` | `/office`、`/office/members`、`/missions`、`/missions/new`、`/missions/:id` routes with intake, plan/run projection, controls, timeline and results |
| Cross-service recovery and acceptance probe | `implemented_local` | Recovery mode/authority epoch API and fail-closed `scripts/production-acceptance.mjs`; live restart, real Worker, Hermes provider and backup/restore evidence remain required |
| CI/release compose | `implemented_local` | immutable image workflow、digest-pinned compose、`/healthz`/`/readyz` |
| Local checks | `implemented_local` | 本次分支驗證：`npm run check`、`npm run typecheck`、`npm test`（151 tests：150 pass、1 environment-gated skip、0 fail）、`npm run build:web`；Vite reports the existing >500 kB scene chunk warning |
| NAS release | `live_verified` | allowlist、staging validate、gateway deploy/status、loopback、Tailscale、cross-service health 與 live task state smoke 均通過（2026-09-02） |
| Real Mac/Windows enrollment | `provider_verified` pending | repository tests 不等於實體裝置 enrollment、OS vault 或 WSS/TLS evidence |
| Local model/Codex execution | `provider_verified` pending | executor code 已提供；實際 runtime/model inventory 與品質證據尚未宣告 |
| Personal Agent Work durable domain | `implemented_local` | migration 13、`AgentWorkService`、Skill immutable version／artifact pin／static validation、Routine binding／receipt fence／occurrence dedup、Goal／milestone／budget、Attention projection、Artifact view、Browser/Teaching fail-closed routes；`test/agent-work.test.ts` |
| Personal Agent Work external lanes | `implemented_local` with capability gates | Hermes native scheduler、ContextHub memory authority、browser broker 與 teaching executor 尚未在本 repository 驗證；未收到 typed receipt 時維持 `PENDING`／`CAPABILITY_UNAVAILABLE`，不宣稱 live/provider 完成 |
| Multi-Orchestrator / resumable execution P0-A | `implemented_local` compatibility decision; native runtime support `NOT_VERIFIED` | ADR records read-only Windows OpenCode CLI v2.1.4 help (`--session` can create if missing); same-session, restart, quota and duplicate-turn behavior were not exercised; no Codex CLI/Mac host was available |
| Resumable execution flags and ledger schema P0-B/P1-A | `implemented_local`; execution routes remain gated OFF | Additive schema migration 16, durable Work/session/quota/recovery tables, local native-session journal tables, typed Work/session contracts; no resume dispatcher or native adapter is enabled |
| Worker Auto Resume policy P1-B | `implemented_local`; actual automatic continuation `UNSUPPORTED` | Global default ON, emergency stop OFF, per-Worker nullable override, pure eligibility policy, versioned/idempotent API, audit chain and Workers UI; recovery engine and runtime adapters stay OFF |
| Quota pool persistence P2-A | `implemented_local` domain groundwork; no live quota verification or Worker adapter | Migration 17 deduplicates confirmed account fingerprints; typed bounded observations, explicit shared Worker bindings, freshness/weekly gates, evidence-hash requirement and audit events; readiness rejects stale, low-confidence and 100%-used allowance; ingress remains gated OFF and pool readiness never dispatches a model turn |
| Durable quota-block ledger P2-B | `implemented_local` persistence, gated negotiated report ingress and policy reconciliation; recovery dispatch/Worker adapter not implemented | Migrations 18–19 persist resume policy and report idempotency hash; reports require runtime gates, negotiated feature, current attempt and held workspace fence, retain the Task as RUNNING, omit native session IDs from projections/audit, and reject conflicting duplicate generations; a 15s reconciler applies OFF/ON/emergency changes but never sends a continuation |
| Recovery status API | `implemented_local`, read-only internal-peer projection | `GET /api/v2/recovery/intents[/:id]` and `GET /api/v2/quota-pools[/:poolId]` are limited to trusted internal peers; browser-origin reads are rejected; account fingerprint and native session ID are never returned; no write/mutation facade is enabled |
| Orchestration Work facade P0 | `implemented_local`, HTTP/MCP gateway remains gated OFF | `OrchestrationService` implements owner-scoped Work create/read, bounded revision-CAS delegation, pause/cancel/unpause control, evidence-backed acceptance, artifact/recovery projections, and durable cursor events; `pai_*` MCP methods call the same domain service. Pausing blocks queued Work tasks but does not stop already-running tasks; native manual/same-session resume is explicitly unsupported. Routes require trusted-peer and explicit-actor checks, then fail closed while `orchestration_gateway_enabled=false`; no live orchestrator identity/token verification evidence exists |
| Quota/reset recovery scheduler | `implemented_local`, dispatch intentionally absent | Due intents use durable leases, verified pool readiness, reset-aware jitter/backoff, shared pool cooldown and a bounded probe counter; policy changes cannot erase the scheduled backoff; scheduler only reads local evidence and persists conditions/events, always returns `dispatched: 0`, and never probes a model |

## 明確未宣告的事項

本文件不把 UI 顯示、health、executor flag 或 unit/integration tests 誤當成 production、provider、memory authority、backup/restore 或實體 worker acceptance。ContextHub 仍是記憶 authority；Control Plane 沒有 memory projection 或 conversation archive。Virtual Office 的本機實作已涵蓋 durable wake-up contract、Coordinator、Worker mission path、UI 與 recovery gates；尚不代表真實 Hermes provider turn、實體 Worker 執行、跨服務重啟、備份還原或 Mission 可跨日完成。

本次 Multi-Orchestrator/resumable execution 變更已加入受閘門保護的 Orchestration Work HTTP/MCP facade：能力快照、owner-scoped Work 建立/讀取、bounded Task delegation、revision-CAS control/acceptance、durable event cursor、artifact/recovery projections；Task/Work 關聯、取消與 receipt 使用同一 DB transaction。Pause 只阻止尚未派送的 queued Work Task，不會停止已執行中的 Task；native manual/same-session resume 明確回報 unsupported。`orchestration_gateway_enabled` 仍為 OFF，且沒有 live orchestrator identity/token 驗證證據，不能把此本機 domain 實作視為可用的 live Orchestrator API。另有 DB-only quota/reset scheduler，具 durable claim、pool cooldown、reset-aware backoff 和有限檢查次數；它不執行 provider probe、不發 Worker resume、不建立新 Attempt，dispatch count 固定為 0。尚未完成 quota/reset recovery dispatcher、Worker native-session adapter、OpenCode same-session continuation 或 Codex Managed Host；目前 Worker 不會宣告新報告 feature，PAICP 不會自動 Resume，也沒有 live E2E 證據。`auto_resume_default_enabled=true` 不會改變此限制。Migrations 17–20 僅新增 quota-pool identity、recovery policy/report idempotency 與 Work event cursor metadata，不修改既有 Work/Worker/Task authority。

Personal Agent Work 的本機 domain 已可保存可追溯的技能、例行 binding、Goal／budget、Attention 與成果投影；技能 `VALIDATE_ONLY` 只代表靜態核對，不能直接升成 READY。Hermes／ContextHub／browser broker 的 receipt、provider、重啟與實體 Worker 證據仍須在各自 repository／部署環境完成。

## 驗證命令

```bash
npm run check
npm run typecheck
npm test
npm run build:web
npm run acceptance:production
npm run release:artifact -- --commit <40-char-sha> --repository <owner/repo> --image <commit-bound-image> --digest sha256:<64-hex>
```
