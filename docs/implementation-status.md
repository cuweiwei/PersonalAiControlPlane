# v2 實作狀態與證據

更新：2026-09-09

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
| Local checks | `implemented_local` | 本次執行 `npm run check`、strict `npm run typecheck`、38 Node tests、`npm run build:web` 與 AiSecretaryChloe CI dependency 下的 24 Python tests |
| NAS release | `live_verified` | allowlist、staging validate、gateway deploy/status、loopback、Tailscale、cross-service health 與 live task state smoke 均通過（2026-09-02） |
| Real Mac/Windows enrollment | `provider_verified` pending | repository tests 不等於實體裝置 enrollment、OS vault 或 WSS/TLS evidence |
| Local model/Codex execution | `provider_verified` pending | executor code 已提供；實際 runtime/model inventory 與品質證據尚未宣告 |
| Personal Agent Work durable domain | `implemented_local` | migration 13、`AgentWorkService`、Skill immutable version／artifact pin／static validation、Routine binding／receipt fence／occurrence dedup、Goal／milestone／budget、Attention projection、Artifact view、Browser/Teaching fail-closed routes；`test/agent-work.test.ts` |
| Personal Agent Work external lanes | `implemented_local` with capability gates | Hermes native scheduler、ContextHub memory authority、browser broker 與 teaching executor 尚未在本 repository 驗證；未收到 typed receipt 時維持 `PENDING`／`CAPABILITY_UNAVAILABLE`，不宣稱 live/provider 完成 |

## 明確未宣告的事項

本文件不把 UI 顯示、health、executor flag 或 unit/integration tests 誤當成 production、provider、memory authority、backup/restore 或實體 worker acceptance。ContextHub 仍是記憶 authority；Control Plane 沒有 memory projection 或 conversation archive。Virtual Office 的本機實作已涵蓋 durable wake-up contract、Coordinator、Worker mission path、UI 與 recovery gates；尚不代表真實 Hermes provider turn、實體 Worker 執行、跨服務重啟、備份還原或 Mission 可跨日完成。

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
