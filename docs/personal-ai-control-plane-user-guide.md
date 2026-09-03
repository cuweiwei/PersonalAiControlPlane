# Personal AI Control Plane v2 — 使用說明

## 啟動 Control Plane

需要 Node.js 22.19+：

```bash
npm ci
npm run build:web
npm start
```

本機預設入口是 `http://127.0.0.1:8080/`。健康檢查為 `/healthz`，可寫 readiness 為 `/readyz`。Control Web 提供 Dashboard、Tasks、Workers、Models、Systems、Settings。

## Worker enrollment

Worker 由裝置主動連到 Control Plane；server 不主動連入裝置。

macOS Worker 可直接使用一鍵安裝腳本。腳本會在使用者目錄準備 source 與 Node.js 22.19+，安裝依賴，建立 LaunchAgent 並立即啟動，不需要先手動執行其他準備指令：

```bash
curl -fsSL https://raw.githubusercontent.com/cuweiwei/PersonalAiControlPlane/main/packaging/macos/install-worker.sh | bash
```

預設連線到 `https://gnest.taila77e5f.ts.net`；若要指定其他 origin，可在同一個腳本命令後以 `bash -s -- "https://example.invalid"` 傳入。啟動後到 Control Web → Workers → Pending enrollment 按 Approve。重跑腳本是冪等的，會重新載入 LaunchAgent。

```bash
npm run worker:cli -- enroll --origin http://127.0.0.1:8080
# 在 Control Web → Workers → Pending Registration 按 Approve
npm run worker:cli -- enroll --origin http://127.0.0.1:8080
npm run worker:cli -- status --origin http://127.0.0.1:8080
npm run worker:cli -- start --origin http://127.0.0.1:8080
```

正式 Worker 預設將 bearer token 放在 macOS Keychain，Windows 使用目前登入使用者的 DPAPI；`PAI_WORKER_CREDENTIAL_BACKEND=file` 僅供本機測試。registration secret 也使用相同 credential backend。若 Control Plane 移除 Worker，Agent 會進入 terminal removed 狀態，不會用舊 token 重連；明確執行 `reset` 會清除本地 credential、enrollment 與 runtime DB，之後必須重新 owner approve：

```bash
npm run worker:cli -- reset
```

Workers 頁將 enrollment 與已註冊 Worker 分開，提供 Online／Needs attention／Drained 篩選、詳細連線/派工/活動投影、Rename、Drain/Resume、能力 Grant/Revoke 與永久 Remove。Remove 會在仍有活動中的 attempt 時回 `409 WORKER_BUSY`，並保留 task/attempt 歷史；重試是冪等的。若部署環境將 `PAI_REQUIRE_STEP_UP=true`，Remove、能力變更與 enrollment 清除需由前置身份層帶入短期 `x-step-up-assertion`，Control Plane 不自行保存 assertion。

## 啟用執行能力

Worker 會自動探測 oMLX、LM Studio 與 Ollama 的本機標準 API；未安裝或尚未啟動的 runtime 只會回報 `UNAVAILABLE`，不會產生模型或接收該 runtime 的工作。若要停用探測，可在啟動前設定：

```bash
PAI_OMLX_ENABLED=false \
PAI_LMSTUDIO_ENABLED=false \
PAI_OLLAMA_ENABLED=false \
npm run worker:cli -- start
```

oMLX 預設連到 `http://127.0.0.1:8000/v1`，並從使用者的 `~/.omlx/settings.json` 讀取 API key（只用於本機請求，不會送到 Control Plane）。可用 `PAI_OMLX_BASE_URL`、`PAI_OMLX_API_KEY_FILE` 覆寫。若 oMLX API 仍要求 key 但 key file 不可讀，Worker 會以 `/health` 顯示已載入的 default model，但 capability 與 model 會標記為 `UNAVAILABLE`，避免誤派工。LM Studio 可用 `PAI_LMSTUDIO_BASE_URL` 覆寫；Ollama 可用 `PAI_OLLAMA_BASE_URL` 覆寫。Codex、Python 需要 `PAI_CODEX_ENABLED` / `PAI_PYTHON_ENABLED` 和 logical workspace map；command executor 預設關閉，只有靜態 `PAI_COMMAND_PROFILES_JSON` 且 owner 明確啟用時才會接受。

## Hermes task API

Hermes 建立 task 時送 snake_case payload：

```bash
curl -X POST http://127.0.0.1:8080/api/v2/tasks \
  -H 'content-type: application/json' \
  -d '{"source":"hermes","title":"Local inference","task_type":"llm.inference","instruction":"Summarize this","context":{},"payload":{"prompt":"hello"},"execution":{"capabilities":["llm.inference"],"runtime":"auto","model":{"mode":"any"},"resources":{}},"limits":{"timeout_seconds":900,"max_attempts":2},"priority":"normal","input_artifact_ids":[]}'
```

查詢：`GET /api/v2/tasks`、`GET /api/v2/tasks/:id`、`GET /api/v2/tasks/:id/events`。可對 `QUEUED` / `ASSIGNED` / `RUNNING` task cancel，對 `FAILED` task retry。結果會透過設定好的 `PAI_HERMES_URL` 和 `PAI_HERMES_TASK_EVENT_PATH` callback；Control Plane 不代替 Hermes 解析或決定結果。

## Production cutover

production compose 是單一 service，使用 immutable image digest、單一 `/data` bind root 和 external `personal-ai-network`。正式操作順序：

1. CI 通過 check、typecheck、test、web build 並 publish image。
2. 將 repository `compose.prod.yml` 上傳至 deployment gateway 的 staging directory。
3. `validate` 成功後才 `deploy`，再以 `status`、`/healthz`、`/readyz` 驗證。
4. 改版沒有 migration；舊資料若需保留，先由 owner/operator 封存至 `/data/legacy/v1/`，新版本使用全新的 `controlplane.db`，所有 Worker 重新 enrollment。

不要把 production secret 寫入 repository 或 compose；不要直接呼叫 NAS Docker、root filesystem 或修改 root-owned compose。
