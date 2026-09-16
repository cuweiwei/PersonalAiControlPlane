# Worker CUA Computer Use

狀態：已實作本機垂直切片；實體 Worker、Hermes provider 與 NAS live 驗收仍須另行完成。

## Worker 設定

Worker 使用已安裝的 Cua Driver。CUA 預設關閉，啟用時設定：

```bash
PAI_CUA_ENABLED=true
PAI_CUA_DRIVER_EXECUTABLE=/absolute/path/to/cua-driver
# 長駐 MCP stdio proxy 使用明確設定的本機 daemon endpoint
PAI_CUA_DRIVER_SOCKET=/absolute/path/to/driver.sock
# 只供隔離診斷測試；正式模式固定使用長駐 MCP stdio client
PAI_CUA_DRIVER_MODE=mcp
```

Windows 安裝器會把上述環境變數寫入 Worker 的 scheduled-task launcher。啟用 CUA 時，`PAI_CUA_DRIVER_EXECUTABLE` 必須是 `cua-driver doctor` 顯示的絕對 `cua-driver.exe` 路徑；MCP 模式預設使用 Cua Driver 的 Windows named pipe `\\.\pipe\cua-driver`，也可用 `PAI_CUA_DRIVER_SOCKET` 明確覆寫。安裝器不會讓模型或任務提供 endpoint。設定環境變數後重新執行 `packaging/windows/install-worker.ps1`，它會沿用既有 Worker identity 並重啟工作。

Worker 以固定 executable 與 argv 啟動一個長駐 `cua-driver mcp --socket <configured-endpoint>` stdio client，並在該 process 生命週期內重用 MCP session；不接受任務提供 executable、socket 或任意 tool。`PAI_CUA_DRIVER_MODE=cli` 僅供隔離測試的 bounded one-shot fallback。支援 `observe`、`list_windows`、`click`、`move`、`drag`、`scroll`、`type_text`、`press_key`、`hotkey`、`launch_app`、`focus_window`。shell、clipboard、recording、replay、driver 設定和任意 MCP passthrough 不在能力範圍內。

正式 MCP 模式必須設定 `PAI_CUA_DRIVER_SOCKET`；缺少 endpoint 時執行會回報 `DRIVER_ENDPOINT_REQUIRED`，不會自行啟動未受控 daemon。`list_windows` 的 driver PID/window ID 只在 Worker 內轉換成帶 session 綁定的 `window_ref`；Hermes 後續只能提交該 opaque reference。

CUA capability 只有在 driver manifest 可讀、且本機 permission probe 回報 Accessibility 與 Screen Recording 均已授權時才是 `READY/VERIFIED`；否則保留 `DEGRADED/ADVERTISED` 或 `UNAVAILABLE`。必須先在 Control Web 對 `computer.use` capability 執行 Grant，才可建立 session。

## Control Plane API

- `GET /api/v2/computers`：Worker、CUA capability、桌面與目前占用。
- `POST /api/v2/computer-sessions`：建立 `PENDING_APPROVAL` session；需要 `Idempotency-Key`。
- `POST /api/v2/computer-sessions/:id/approve`：以 `scope_hash` 核准並取得桌面鎖。
- `GET /api/v2/computer-sessions/:id`：session、lock、operation、observation 證據。
- `POST /api/v2/computer-sessions/:id/control`：以 `expected_revision` 執行 `pause`、`resume`、`close` 或 `revoke`。
- `GET /api/v2/computer-sessions/:id/observations/:observation_id` 與 `/download`：讀取仍在 TTL 內的 observation metadata/bytes；下載回應為 `no-store`。
- `POST /api/v2/computer-sessions/:id/operations/:sequence/reconcile`：以操作後 observation 對帳一筆 `UNKNOWN` effect，解除後續寫入阻擋。
- `POST /api/v2/tasks`：`task_type: "computer.use"`；每個 Task 只執行一個 primitive，payload 必須含 `session_id`、`session_revision`、`desktop_epoch`、`sequence`、`operation`。

輸入操作必須引用最近 10 秒內同一 session 的 observation。Hermes 對送出訊息、提交表單、刪除資料等外部變更標記 `sensitive=true` 並提供既有 approval reference；CP 與 Worker 都會拒絕缺少 reference 的請求。相同 idempotency key 會重播既有 Task；相同 sequence 的不同內容會拒絕。driver timeout、Worker crash 或停止未確認時，effect/lock 保持 `UNKNOWN`，不會自動重做輸入。

畫面 artifact 只給授權 session 使用，暫存 24 小時；授權也固定 model provider/id 與 data policy。稽核保留操作 hash、狀態與證據 reference，不記錄明文輸入。Hermes 必須自行判斷操作後狀態，Task `SUCCEEDED` 不代表使用者目標已完成。

## 驗證

```bash
npm run typecheck
npm run build:web
npm test
```

Hermes `chloe_v2` MCP server 提供 `computer_list`、`computer_session_open`、`computer_observe`、`computer_act`、`computer_reconcile` 與 `computer_session_control`；`computer_observe` 會驗證 SHA-256 後回傳 MCP image content。尚未完成的 live gate 是目標 Worker 的實際 Cua Driver daemon、OS 權限、指定 Hermes vision model provider receipt，以及實體桌面／VM 的 end-to-end 操作證據。

`test/computer-use.test.ts` 涵蓋 driver allowlist、截圖 artifact、capability grant、桌面獨占、observation 綁定與 stale rejection。
