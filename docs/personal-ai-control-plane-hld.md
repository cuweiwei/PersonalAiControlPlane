# Personal AI Control Plane v2 — HLD

狀態：v2 實作基準（2026-09-02）

本文件與 `/Users/tim_hong/Downloads/v2_HLD.md` 對應。實作以 v2 的架構邊界為準；目前 repository 已依使用者要求直接改版，不保留 v1 runtime 相容層，也不執行資料 migration。

## 1. 核心決策

```text
Hermes       = 唯一的大腦：對話、意圖、推理、規劃、分解、結果評估與回覆
ContextHub   = 唯一的長期語意記憶 authority
Control Plane= Task persistence、Worker registry、scheduler、dispatch、結果、artifact、callback、health
Worker       = 具體執行節點，不自行規劃、不管理長期記憶、不委派其他 Worker
```

Control Plane 是 NAS 上的單一 Node process / container。Control Web、Task API、Worker WebSocket、SSE、health endpoints 共用同一個 listener；Hermes 與 ContextHub 保持獨立服務和資料 authority。

## 2. 主要流程

1. Hermes 直接使用 ContextHub 的正式 API 取得記憶，依自己的 reasoning 決定是否建立 execution task。
2. Hermes 以 `POST /api/v2/tasks` 送出具備 task type、instruction、capability、model、resource、timeout 與 retry limit 的 task。
3. Control Plane 將 task 寫入新的 `controlplane.db`，scheduler 只依 capability、runtime、model、resource、load、availability 做候選篩選與 deterministic scoring。
4. 已註冊且 owner-approved 的 Worker 透過 outbound WebSocket 收到 task offer，持久化 assignment 後回覆 accept，執行並回傳 progress、log、result 或 failure。
5. Control Plane 以 task/attempt fence 接受結果；過期、斷線與 infrastructure failure 可重排，late result 只記錄不覆寫新 attempt。
6. terminal result 透過 callback outbox 至 Hermes，直到成功或進入 retention；Hermes 以 `correlation_id` 對應自己的對話/工作狀態。

## 3. 私有部署與安全邊界

- 對外只暴露 Tailscale/private ingress；container 內部使用 `8080`，NAS host 只 publish `127.0.0.1:9084`。
- 不在 Control Plane 建立 identity listener、browser login、OAuth/JWT/JWS、mTLS、service-to-service token 或 workload identity。
- Worker 一次 owner approval 後取得長期 bearer token；server 只保存 SHA-256 hash。Worker token 應放在 macOS Keychain / Windows Credential Manager；本地 fallback 僅用於開發驗證。
- Worker 連線只接受 protocol version 2；每 30 秒 heartbeat，90 秒未更新視為 stale。
- command execution 預設關閉；啟用時只能使用靜態 profile、允許 executable、workspace root 與輸出/時間上限。
- artifact 全部寫入 `/data/artifacts`，以 task 關聯並限制大小；不接受任意 host path。
- production image 以 CI commit-bound immutable image 發佈，compose 只經 staging + deployment gateway promotion。

## 4. API / protocol surface

HTTP：`/`、`/api/v2/tasks`、`/api/v2/workers`、`/api/v2/models`、`/api/v2/systems`、`/api/v2/settings`、`/api/v2/events`、`/healthz`、`/readyz`。

Worker WebSocket：`/worker/ws`。Worker → server 支援 `hello`、`heartbeat`、`capabilities.update`、`models.update`、`task.accept`、`task.reject`、`task.started`、`task.progress`、`task.log`、`task.result`、`task.failed`、`task.cancelled`；server → Worker 支援 `hello.ack`、`task.offer`、`task.cancel`、`task.result.ack`。

## 5. v2 不包含的責任

Control Plane 不再是 Hermes 的 planner，不保存 conversation/archive/semantic-memory projection，不實作 owner identity、approval policy、credential vault、quota authority、proactive planner 或 deployment runtime。這些需求由 Hermes、ContextHub 或 owner/operator 的既有 authority 負責。

## 6. Cutover

本次改版不考慮 migration：停止現有服務後，將舊資料放在 `/data/legacy/v1/`（若需保留），以全新的 `/data/controlplane.db` 啟動；所有 Worker 重新 enrollment。舊 DB 不由 v2 開啟，舊 API 也不提供相容路由。
