# Worker CUA Computer Use

狀態：session 直接建立與手動撤銷已實作；實體 Worker、Hermes provider 與 NAS live 驗收仍須另行完成。

## Worker 安裝與桌面需求

Windows、macOS、Linux 安裝器預設會安裝缺少的 Cua Driver、設定本機 endpoint，並啟動對應使用者工作階段中的 driver service 與 Worker。若不需要 computer use，可在執行安裝器前設定 `PAI_CUA_ENABLED=false`。既有 driver 會沿用；只有 driver 不存在時才會安裝。可選擇以 `PAI_CUA_DRIVER_VERSION` 指定 driver 發行版本。

安裝器使用者態安裝 Cua Driver，不會替 driver 放寬權限政策或自動授與 CP capability。Windows 必須從已登入的互動桌面執行，driver 以互動式登入工作啟動；macOS 由 `CuaDriver.app` LaunchAgent 啟動以保留 TCC 身分，使用者仍須在系統設定核准 Accessibility 與 Screen Recording。Linux 安裝器支援 Worker x64/arm64；CUA Driver Linux 圖形桌面目前以 x86_64 為支援基線，需要登入中的 X11/XWayland 或 driver 支援的 Wayland session、AT-SPI 2 與 systemd user manager。Debian/Ubuntu 缺少 `libxi6` 或 `at-spi2-core` 時，安裝器會使用 sudo 安裝套件。

Linux 可直接執行：

```bash
curl -fsSL https://raw.githubusercontent.com/cuweiwei/PersonalAiControlPlane/main/packaging/linux/install-worker.sh | bash
```

Linux CUA daemon 與 Worker 都使用 user-level systemd services；安裝器不啟用 linger、不以 root 執行 CUA，也不把 headless server 假報成可用桌面。狀態與日誌可用 `systemctl --user status cua-driver.service personal-ai-worker.service` 及 `journalctl --user -u cua-driver.service -u personal-ai-worker.service` 檢查。

若需覆寫預設值，可在執行安裝器前設定：

```bash
PAI_CUA_ENABLED=true
PAI_CUA_DRIVER_EXECUTABLE=/absolute/path/to/cua-driver
# 長駐 MCP stdio proxy 使用明確設定的本機 daemon endpoint
PAI_CUA_DRIVER_SOCKET=/absolute/path/to/driver.sock
# 只供隔離診斷測試；正式模式固定使用長駐 MCP stdio client
PAI_CUA_DRIVER_MODE=mcp
```

Windows 一鍵安裝固定使用 Cua Driver 預設 named pipe `\\.\pipe\cua-driver`；自訂 Windows daemon endpoint 必須另外管理，安裝器會拒絕不相符的 endpoint。Linux 預設使用 `$XDG_RUNTIME_DIR/cua-driver.sock`；macOS 預設使用 `~/Library/Caches/cua-driver/cua-driver.sock`，這兩個平台可用 `PAI_CUA_DRIVER_SOCKET` 覆寫，Worker 與 daemon 會共用該值。安裝器不會讓模型或任務提供 executable 或 endpoint。

Worker 以固定 executable 與 argv 啟動一個長駐 `cua-driver mcp --socket <configured-endpoint>` stdio client，並在該 process 生命週期內重用 MCP session；不接受任務提供 executable、socket 或任意 tool。`PAI_CUA_DRIVER_MODE=cli` 僅供隔離測試的 bounded one-shot fallback。支援 `observe`、`list_windows`、`click`、`move`、`drag`、`scroll`、`type_text`、`press_key`、`hotkey`、`launch_app`、`focus_window`。shell、clipboard、recording、replay、driver 設定和任意 MCP passthrough 不在能力範圍內。

正式 MCP 模式必須有明確 endpoint；安裝器會建立並啟動受控本機 daemon service。缺少 endpoint 時執行會回報 `DRIVER_ENDPOINT_REQUIRED`，不會自行啟動未受控 daemon。`list_windows` 的 driver PID/window ID 只在 Worker 內轉換成帶 session 綁定的 `window_ref`；Hermes 後續只能提交該 opaque reference。

CUA capability 只有在 driver manifest 可讀、且本機 permission probe 回報 Accessibility 與 Screen Recording 均已授權時才是 `READY/VERIFIED`；否則保留 `DEGRADED/ADVERTISED` 或 `UNAVAILABLE`。必須先在 Control Web 對 `computer.use` capability 執行一次 Grant。Grant 後，Hermes 可直接建立或重用 session，不再逐次等待 CP 核准 scope。

## Control Plane API

- `GET /api/v2/computers`：Worker、CUA capability、桌面與目前占用。
- `GET /api/v2/computer-sessions`：列出目前 principal 的 session，供 Control Web 管理。
- `POST /api/v2/computer-sessions`：以已 Grant 且已驗證的 `computer.use` capability 建立 `ACTIVE` session，並原子取得桌面鎖；需要 `Idempotency-Key`。同桌面已有同 principal、同 scope 的 active session 時會重用；scope 不同時回 `DESKTOP_BUSY`。
- `POST /api/v2/computer-sessions/:id/approve`：保留給升級前留下的舊 `PENDING_APPROVAL` session；新 session 不再使用此步驟。
- `DELETE /api/v2/computer-sessions/:id`：撤銷 session 並要求 Worker 停止；保留稽核與操作證據，未確認停止時繼續隔離桌面，並留在清單顯示停止未確認；停止確認後從活動清單隱藏。
- `GET /api/v2/computer-sessions/:id`：session、lock、operation、observation 證據。
- `POST /api/v2/computer-sessions/:id/control`：以 `expected_revision` 執行 `pause`、`resume`、`close` 或 `revoke`。
- `GET /api/v2/computer-sessions/:id/observations/:observation_id` 與 `/download`：讀取仍在 TTL 內的 observation metadata/bytes；下載回應為 `no-store`。
- `POST /api/v2/computer-sessions/:id/operations/:sequence/reconcile`：以操作後 observation 對帳一筆 `UNKNOWN` effect，解除後續寫入阻擋。
- `POST /api/v2/tasks`：`task_type: "computer.use"`；每個 Task 只執行一個 primitive，payload 必須含 `session_id`、`session_revision`、`desktop_epoch`、`sequence`、`operation`。

Computer session 不設時間或閒置到期；由使用者在 Control Web 刪除／撤銷，或因 Worker/OS 桌面身分變更與控制 lease 中斷而停止。單一桌面仍只准一個 session；Hermes 開啟相同 scope 時重用 session，改變 scope 前需先停止並由使用者刪除舊 session。`max_actions` 未指定時不設動作數上限；若明確指定正數則依該數量限制。

輸入操作必須引用最近 10 秒內同一 session 的 observation。Hermes 對送出訊息、提交表單、刪除資料等外部變更標記 `sensitive=true` 並提供既有 approval reference；CP 與 Worker 都會拒絕缺少 reference 的請求。相同 idempotency key 會重播既有 Task；相同 sequence 的不同內容會拒絕。driver timeout、Worker crash 或停止未確認時，effect/lock 保持 `UNKNOWN`，不會自動重做輸入。

畫面 artifact 只給授權 session 使用，仍暫存 24 小時；session 無期限不延長畫面與 AX 資料保存。授權固定 model provider/id 與 data policy。稽核保留操作 hash、狀態與證據 reference，不記錄明文輸入。Hermes 必須自行判斷操作後狀態，Task `SUCCEEDED` 不代表使用者目標已完成。

## 驗證

```bash
npm run typecheck
npm run build:web
npm test
```

Hermes `chloe_v2` MCP server 提供 `computer_list`、`computer_session_open`、`computer_observe`、`computer_act`、`computer_reconcile` 與 `computer_session_control`；`computer_session_open` 可在 capability Grant 後直接建立或重用無期限 session，並回傳 `nextSequence`；`computer_observe` 會驗證 SHA-256 後回傳 MCP image content。尚未完成的 live gate 是目標 Worker 的實際 Cua Driver daemon、OS 權限、指定 Hermes vision model provider receipt，以及實體桌面／VM 的 end-to-end 操作證據。

`test/computer-use.test.ts` 涵蓋 driver allowlist、截圖 artifact、capability grant、桌面獨占、observation 綁定與 stale rejection。
