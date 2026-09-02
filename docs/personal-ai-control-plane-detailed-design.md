# Personal AI Control Plane v2 — Detailed Design

狀態：v2 實作基準（2026-09-02）

上位設計：[v2 HLD](personal-ai-control-plane-hld.md)。本文件對應 `/Users/tim_hong/Downloads/v2_Detailed_design.md`，並記錄已落地的 repository contract。

## 1. Repository layout

```text
apps/control-plane/src/
  index.ts                 單一 process、loops、shutdown
  server.ts                HTTP、SSE、static Control Web、Worker artifact API
  db/database.ts           fresh SQLite schema
  tasks/                   state machine、task/attempt/event service
  scheduler/               capability/resource/load filtering + deterministic score
  workers/                 registration、token hash、registry、WebSocket coordinator
  artifacts/               task-scoped file storage
  callbacks/               Hermes at-least-once outbox dispatcher
  systems/                 Hermes / ContextHub health monitor
  settings/                owner-editable runtime settings
apps/control-web/          React/Vite static management UI
apps/worker/               enrollment、outbound runtime、local DB、executors
packages/contracts/        API/protocol types and strict request parsers
packages/worker/           capability/path/shell safety helpers
schemas/                   v2 task、worker message、health、release schemas
```

## 2. SQLite authority

v2 啟動只建立一個 `controlplane.db`，WAL、foreign keys、busy timeout、trusted schema 關閉。主要 tables：

`tasks`、`task_attempts`、`task_events`、`workers`、`worker_tokens`、`worker_registration_requests`、`worker_capabilities`、`worker_models`、`artifacts`、`task_artifacts`、`callback_outbox`、`systems`、`system_health`、`settings`。

所有時間在資料庫以 Unix milliseconds 儲存，API 回傳 RFC 3339 UTC。task ID、attempt ID、event ID、worker ID 使用 UUIDv7。v2 沒有 v1 migration；若 production 需要保留舊檔，先由 operator 封存至 `/data/legacy/v1/`，新 runtime 不讀取。

## 3. Task contract

`POST /api/v2/tasks` 使用 snake_case：

```json
{
  "source": "hermes",
  "correlation_id": "conversation-or-work-id",
  "title": "Summarize files",
  "task_type": "llm.inference",
  "instruction": "Summarize the supplied context.",
  "context": {"summary": "...", "items": []},
  "payload": {"prompt": "..."},
  "execution": {
    "capabilities": ["llm.inference"],
    "worker_id": null,
    "runtime": "auto",
    "model": {"name": "qwen3.5-27b", "mode": "preferred"},
    "resources": {"min_ram_mb": 16384, "gpu_required": false}
  },
  "limits": {"timeout_seconds": 900, "max_attempts": 2},
  "priority": "normal",
  "input_artifact_ids": []
}
```

支援 task type：`llm.inference`、`codex`、`python`、`command`、`generic`。合法 state：`QUEUED → ASSIGNED → RUNNING → SUCCEEDED/FAILED/CANCELLED`；infrastructure failure 可回到 `QUEUED`，人工 retry 只允許 `FAILED → QUEUED`。每個 attempt 都以 `current_attempt_id` fence；late result 只建立 `LATE_ATTEMPT_RESULT` event。

## 4. Worker enrollment and protocol

1. Worker `POST /api/v2/worker/registration`，送出 name、platform、hostname、agent version、hardware 和一次性 registration secret。
2. Owner 在 Control Web 的 Workers 頁 approve/reject。
3. Worker poll registration，approved 時只取得一次長期 bearer token；server 只保留 SHA-256 hash。
4. Worker 使用 `Authorization: Bearer` 建立 outbound `ws(s)://.../worker/ws`，先送 `hello`（`protocol_version: 2`），再送 capabilities/models discovery。
5. task offer 落地到 Worker local SQLite assignment 後才 accept；result 先落地 local `results`，重連時重送，直到收到 `task.result.ack`。

Heartbeat interval 是 30 秒，stale threshold 是 90 秒。Worker restart 時 RUNNING assignment 不會假設成功；server 以 disconnect/timeout 重新判定。每個 Worker 可 enable/disable、drain/resume、remove；remove 會撤銷 token 並保留歷史 attempt。

## 5. Scheduler

Scheduler 每秒掃描 queued tasks，依 priority、created time、ID 決定順序。候選 Worker 必須同時滿足：

- online、enabled、非 drain、WebSocket connected、尚有 concurrency slot；
- capability 與 task type 相符；
- runtime、required/preferred model 符合；
- minimum RAM、GPU、logical workspace 符合；
- explicit `worker_id` 存在且可用時只使用該 Worker，沒有候選則保持 queued。

score 依 exact model、runtime、idle/slots、memory headroom，再以 last assignment 和 worker ID 作 deterministic tie-break。scheduler 不根據 AI 品質自行 retry；provider/AI quality failure 由 Hermes 決定是否重建 task。

## 6. Executors and safety

Worker 內建：

- OpenAI-compatible `oMLX` / `LM Studio`；
- Ollama；
- local Codex executable；
- workspace-bound Python；
- disabled-by-default static command profiles。

所有 coding/python/command 請求只能以 logical `workspace_id` 對應本機設定 root，不接受任意 host path。command profile 使用 `shell: false`，檢查 executable allowlist、參數 shell metacharacter、cwd root、environment allowlist、runtime/output limit；未通過時回報 unavailable/failed。

## 7. Artifact and callback

artifact 寫入 `/data/artifacts/<year>/<month>/<task-id>/`，filename sanitized，server 計算 `sha256:` digest 並以 task/attempt 關聯。輸入 artifact 只能引用已存在的 server record；Worker output artifact 需 bearer authentication，不能跳出 task/worker 關聯。

terminal task 會寫入 callback outbox。Dispatcher 對固定 `PAI_HERMES_URL + PAI_HERMES_TASK_EVENT_PATH` 以 at-least-once POST、claim lease、bounded retry 和 last error 執行；不接受 task payload 內的 arbitrary callback URL，也不使用額外 service token。

## 8. Health and Web

`/healthz` 是 process liveness；`/readyz` 檢查 SQLite 可寫、artifact root、scheduler/coordinator loop。Hermes、ContextHub 和 Worker 狀態是 Systems 顯示資料，不會因外部服務暫時離線而把 Control Plane readiness 判為 false。

Control Web 只有 Dashboard、Tasks、Workers、Models、Systems、Settings。REST 是 authority，SSE `/api/v2/events` 只作即時 refresh hint。

## 9. Verification targets

本 repo 的 test suite 覆蓋 state transition、registration/token hash、scheduler filtering/scoring、retry/fencing/late result、stale requeue、artifact upload/download、settings/health、Worker local assignment/result resend/ack、release manifest。正式 acceptance 仍需在實際 NAS、Hermes、ContextHub、Mac/Windows worker 與 local model runtime 上做 live evidence。
