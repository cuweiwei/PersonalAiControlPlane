# Personal AI Control Plane v2

NAS 上的 execution control plane：Hermes 負責思考與規劃，ContextHub 負責長期語意記憶，Control Plane 管理 Task/Worker/dispatch/result，Worker 執行具體工作。

設計文件：

- [Requirements](docs/personal-ai-control-plane-requirements.md)
- [HLD](docs/personal-ai-control-plane-hld.md)
- [Detailed Design](docs/personal-ai-control-plane-detailed-design.md)
- [使用說明](docs/personal-ai-control-plane-user-guide.md)
- [Implementation Status](docs/implementation-status.md)

## Local development

需要 Node.js 22.19+：

```bash
npm ci
npm run check
npm run typecheck
npm test
npm run build:web
npm start
```

本機 Control Web 預設在 `http://127.0.0.1:8080/`；health 是 `/healthz`，readiness 是 `/readyz`。

## Worker

macOS 可直接執行一鍵安裝腳本；它會自動準備 Worker source、Node.js 22.19+、依賴與登入後常駐的 LaunchAgent：

```bash
curl -fsSL https://raw.githubusercontent.com/cuweiwei/PersonalAiControlPlane/main/packaging/macos/install-worker.sh | bash
```

安裝完成後，到 Control Web → Workers 按 Approve。腳本會使用使用者層級的 Keychain 保存 credential，不需要先手動 clone repo、安裝 Node.js 或建立 `pai-worker`。若已在 repo 目錄內執行腳本，則會直接使用目前 checkout；可用第一個參數覆寫 Control Plane origin。

手動啟動與診斷仍可使用：

```bash
npm run worker:cli -- enroll --origin http://127.0.0.1:8080
# 在 Control Web → Workers → Pending Registration 按 Approve
npm run worker:cli -- enroll --origin http://127.0.0.1:8080
npm run worker:cli -- start --origin http://127.0.0.1:8080
npm run worker:cli -- status
```

Worker 以 outbound WebSocket 連線，預設在 macOS 使用 Keychain、Windows 使用目前登入使用者的 DPAPI 保護 credential；`PAI_WORKER_CREDENTIAL_BACKEND=file` 僅供本機測試。Workers 管理頁會聚合連線、heartbeat、派工/Drain、活動、credential、capability、provider evidence 與診斷，並支援搜尋、篩選、Rename、Grant/Revoke、Resume 與永久 Remove。Worker 被 Control Plane 移除後會進入 terminal removed 狀態，必須明確執行 `reset` 才會清除本機身分、registration 與 runtime DB，再重新 owner approval。oMLX 會由 macOS 一鍵安裝預設啟用，並讀取使用者的 `~/.omlx/settings.json` API key（只留在本機，不會上報）；也可用 `PAI_OMLX_ENABLED=false` 關閉。LM Studio、Ollama、Codex、Python 和 command executor 仍以明確設定控制，command 預設關閉。

## Architecture boundary

v2 使用一個 Control Plane process/container、一個 fresh `controlplane.db` 和一個 `/data` artifact root。沒有 v1 API compatibility 或 database migration；cutover 時可停止舊服務，舊資料若需保留則由 operator 獨立封存後再啟動新版本。Production image 必須經 CI immutable publish 與 NAS deployment gateway。
