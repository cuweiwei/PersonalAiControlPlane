# v2 實作狀態與證據

更新：2026-09-02

## 本機 repository evidence

| 區域 | 狀態 | 證據 |
| --- | --- | --- |
| Unified Control Plane process | `implemented_local` | `apps/control-plane/src/index.ts` 建立單一 server、scheduler、health、callback loops |
| Fresh SQLite authority | `implemented_local` | `apps/control-plane/src/db/database.ts` 只建立 v2 `controlplane.db` schema |
| Task lifecycle/fencing | `implemented_local` | task service、state machine、attempt/event tables 與 `test/v2-core.test.ts` |
| Worker enrollment/token hash | `implemented_local` | registration approve/poll、SHA-256 token hash 與 HTTP tests |
| Worker WS/runtime durability | `implemented_local` | outbound WS、local assignment/result persistence、result ack/resend 與 `test/v2-worker.test.ts` |
| Scheduler filtering/scoring | `implemented_local` | capability/runtime/model/resource/load rules 與 core tests |
| Artifact storage | `implemented_local` | task-scoped storage、digest、worker-authenticated upload/download 與 HTTP test |
| Hermes callback outbox | `implemented_local` | claim、at-least-once POST、bounded retry；live Hermes delivery 未驗證 |
| Systems health | `implemented_local` | Hermes/ContextHub checks；實際 container network 狀態未驗證 |
| Control Web | `implemented_local` | React/Vite Dashboard、Tasks、Workers、Models、Systems、Settings |
| CI/release compose | `implemented_local` | immutable image workflow、digest-pinned compose、`/healthz`/`/readyz` |
| Local checks | `implemented_local` | `npm run check`、strict `npm run typecheck`、13 tests、`npm run build:web` 全部通過；尚待 main CI run |
| NAS release | `live_verified` pending | 必須另行完成 allowlist、staging validate、gateway deploy/status 與 loopback/tailnet checks |
| Real Mac/Windows enrollment | `provider_verified` pending | repository tests 不等於實體裝置 enrollment、OS vault 或 WSS/TLS evidence |
| Local model/Codex execution | `provider_verified` pending | executor code 已提供；實際 runtime/model inventory 與品質證據尚未宣告 |

## 明確未宣告的事項

本文件不把 UI 顯示、health、executor flag 或 unit/integration tests 誤當成 production、provider、memory authority、backup/restore 或實體 worker acceptance。ContextHub 仍是記憶 authority；Control Plane 沒有 memory projection 或 conversation archive。

## 驗證命令

```bash
npm run check
npm run typecheck
npm test
npm run build:web
npm run release:artifact -- --commit <40-char-sha> --repository <owner/repo> --image <commit-bound-image> --digest sha256:<64-hex>
```
