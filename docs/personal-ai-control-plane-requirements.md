# Personal AI Control Plane v2 — Requirements

## 1. 目標

提供一個由 Hermes 驅動、部署於 NAS 的 execution control plane：保存可追蹤的 Task、管理受 owner 核准的 Worker、依實際 capability/model/resource dispatch，可靠地回傳 progress/result/artifact。

## 2. 必須滿足

- Hermes 是唯一的 reasoning / planning / decision-maker；Control Plane 不接管對話、規劃或 semantic memory。
- ContextHub 是長期語意記憶唯一 authority；Control Plane 只保留 task context/reference 和 health。
- NAS 使用一個 Control Plane process/container、一個 fresh SQLite DB、一個 unified HTTP/SSE/Worker WS listener。
- Task 支援 `llm.inference`、`codex`、`python`、`command`、`generic`，具備 deterministic state transition、attempt fencing、timeout、retry、cancel、late-result handling。
- Worker 支援 owner approval、token hash storage、outbound WebSocket、heartbeat/stale、capability/model discovery、drain/disable/remove。
- Scheduler 必須依能力、runtime、model、RAM/GPU、workspace、concurrency 和 availability 過濾，且 scoring 可重現。
- Worker 必須持久化 assignments/results；重啟後對未確認 result 重送，不能把本地 RUNNING 假設為成功。
- artifact 必須 task-scoped、受大小限制、具 SHA-256 digest；callback 必須固定 Hermes endpoint 且至少一次投遞。
- `/healthz` 與 `/readyz` 可被 container healthcheck 使用；外部 Hermes/ContextHub outage 不可偽造為 process not-ready。
- Control Web 僅提供 Dashboard、Tasks、Workers、Models、Systems、Settings。

## 3. 不在 v2 範圍

Owner identity/login、approval policy、credential vault、conversation archive、proactive planner、quota authority、deployment runtime、service-to-service secret、multi-tenant authorization 和跨版本 DB migration 都不屬於 Control Plane v2。

## 4. Cutover 原則

改版可以停止現有服務並換上新版本。舊 DB 不轉換；operator 如需保留，將其獨立封存至 `/data/legacy/v1/`，新版本從乾淨 `controlplane.db` 啟動，Worker 重新 enrollment。所有 production promotion 仍須經 CI immutable image 與 NAS deployment gateway。
