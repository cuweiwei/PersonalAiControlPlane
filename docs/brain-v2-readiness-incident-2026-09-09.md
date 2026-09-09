# Brain v2 Mission 建立與執行阻塞修復

Telegram 回報 `503 BRAIN_V2_DISABLED`、`SUPERVISOR_READ_ONLY_NOT_VERIFIED`。正式環境查證：Brain v2 未啟用，Control Plane 的 supervisor 判斷只讀環境變數；Hermes Office driver 沒有實際工具限制。另外，2026-09-07 失敗主管回合留下 UNKNOWN slot，會阻止後續 admission。

## 修復

- Production Compose 明確啟用 `PAI_HERMES_BRAIN_V2_ENABLED`。
- `/api/v2/capabilities` 即時查詢固定 Hermes adapter 的私有能力端點，探測失敗即回報不可用；不再信任 `PAI_HERMES_SUPERVISOR_READ_ONLY`。
- Hermes immutable image 對 `office:` session 強制 `enabled_toolsets=[]`，並在建立 agent 後檢查工具集合確實為空。其他 session 保持原設定。Build-time patch 不符合 pinned upstream 時建置失敗。
- Adapter 以認證連線查詢實際 Runs API 的 policy，再允許執行；決策提示包含 admission 的 `brain_attempt_id` 與完整 DELEGATE／COMPLETE contract。
- 新增明確的 `POST /api/v2/office/recovery` action `RECONCILE_HERMES_RESTART`。伺服器自行從 adapter 取得 Linux kernel 的容器 PID 1 啟動時間，僅對帳該時間以前、Mission 已 FAILED/CANCELLED 的 UNKNOWN 主管回合。只標示主管已停止並釋放其資源位置，不改 Mission 成功狀態，也不清除 Worker／外部操作的 UNKNOWN 狀態。

## 驗證

- Control Plane：59 tests、typecheck、check、web build 通過。
- Hermes：39 tests 通過；完整 s6 image smoke 實際載入 pinned runtime，確認 Office allowlist 解析出零個可執行工具。
- 部署經各專案 gateway staging → validate → deploy → status；使用 CI 發布的 immutable digest。

## 2026-09-09 live evidence

- Hermes release `0150843ea6210a1261a8e5098c6c0fd06c9f60e6` deployed with image digest `sha256:6ab8519be2f777970f271bf6acf8f0e5cdfc4446babe7abbb00837c97828c596`; `/api/health` reported `status=ok`, Office adapter `status=ok`, and authenticated driver available.
- PersonalAiControlPlane release deployed with image digest `sha256:691db3da2e7fd4626cb23e20435ae96a83a01c7dc87e0b3c946f1caa36b3c740`; `/healthz`, `/readyz`, and gateway status were healthy.
- Capability probe returned `available=true`, `supervisorReadOnly=true`, `tools=[]`, with kernel-backed Hermes container start evidence. Restart reconciliation released the one old UNKNOWN supervisor attempt and slot.
- Real Mission `01a08528-b90f-7226-ab35-3237bdd8fdf3` completed in 16 seconds through `PLANNING → COMPLETED`; the `mission.completed` event and result manifest were read back from the live Control Plane. The result used `waitSummary.mode=HERMES_ONLY` and returned the generated verification code in `finalManifest.summary`.

## 能力界線

唯讀 supervisor 目前不提供 SELF_TOOL；需要實體執行時使用 DELEGATE → WORKER_TASK。這次修復不把未實作的 Skill validation、native routine hook 或 channel delivery 宣告成 ready。2026-09-09 查到 tw-timhong 只公布 llm.inference，沒有 Python/Codex workspace；完整產檔／Skill／排程 E2E 仍須分別驗證。
