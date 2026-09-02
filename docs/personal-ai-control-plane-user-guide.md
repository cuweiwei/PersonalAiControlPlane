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

```bash
npm run worker:cli -- enroll --origin http://127.0.0.1:8080
# 在 Control Web → Workers → Pending Registration 按 Approve
npm run worker:cli -- enroll --origin http://127.0.0.1:8080
npm run worker:cli -- status --origin http://127.0.0.1:8080
npm run worker:cli -- start --origin http://127.0.0.1:8080
```

registration secret 與 bearer token 都寫入 worker data directory 的 mode `0600` 檔案；正式 macOS/Windows packaging 應將 token data directory 放在使用者 session 的受保護位置。`reset` 會清除本地 enrollment，之後必須重新 owner approve：

```bash
npm run worker:cli -- reset
```

## 啟用執行能力

Worker 預設只會啟用明確設定的 executor：

```bash
PAI_OLLAMA_ENABLED=true \
PAI_OLLAMA_BASE_URL=http://127.0.0.1:11434 \
npm run worker:cli -- start
```

OpenAI-compatible runtime 使用 `PAI_OMLX_ENABLED`、`PAI_OMLX_BASE_URL` 或 `PAI_LMSTUDIO_ENABLED`、`PAI_LMSTUDIO_BASE_URL`。Codex、Python 需要 `PAI_CODEX_ENABLED` / `PAI_PYTHON_ENABLED` 和 logical workspace map；command executor 預設關閉，只有靜態 `PAI_COMMAND_PROFILES_JSON` 且 owner 明確啟用時才會接受。

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
