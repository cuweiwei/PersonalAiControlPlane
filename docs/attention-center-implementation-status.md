# 待處理中心實作狀態

日期：2026-10-03。範圍是 Attention 列表／詳情／READ／SNOOZE／UNSNOOZE、到期投影與 Routine 列表 endpoint 修正。

## 已完成

- 列表與詳情使用持久化 Attention；支援狀態、嚴重度、已載入結果搜尋與未讀篩選，詳情顯示證據、期限及固定站內工作連結。
- READ 依 `changeRevision` 更新閱讀進度；SNOOZE／UNSNOOZE 使用 CAS、嚴格期限驗證、operation idempotency 與 durable event，成功後發布 SSE invalidation。
- 到期只影響 `effectiveState` 投影。讀取不改寫 DB；已到期與舊的空期限暫緩項目投影為 OPEN，SQL 在 LIMIT 前套用有效狀態篩選。
- 修正 Attention episode 以同 subject/reason 的歷史最大值遞增，且相同活動 fingerprint 保持冪等。
- Routine 列表改讀 `/api/v2/routine-bindings`。UI 不使用或執行 `actionRef` 內容；任何其中的 URL 均視為不可信資料。
- 不新增 migration、排程器、provider 或通知發送。

## 驗證證據

本機 checks：

- `npm run check` 通過：46 個 implementation files、8 個 v2 source files、5 個 canonical schemas。
- `npm run typecheck` 通過。
- `npm test`：119 tests，118 pass、0 fail、1 skip。唯一 skip 是 Hermes source boundary 測試，因 `HERMES_SOURCE_ROOT` 未設定。
- `npm run build:web` 成功。Vite 顯示 scene chunk 大於 500 kB 的提醒。
- `git diff --check` 通過。
- 新增 11 個 Attention service、HTTP 與 Web helper 測試，全部通過；包含過期投影與 LIMIT、READ/changeRevision、SNOOZE 時間界線、CAS/idempotency、feature gate、SSE replay、歷史 episode、SQLite 重開持久化及列表／詳情 HTTP 驗證。

主 agent 另以暫存 SQLite fixture 執行 browser smoke：列表與詳情正常；開詳情不會自動已讀；READ、SNOOZE、UNSNOOZE 後顯示符合投影。任意 `javascript:` actionRef 未被顯示或執行，只顯示固定站內連結。Response-loss 測試中，操作已 APPLIED 後 proxy 回 503；頁面保留相同操作並禁止新 command，重試使用相同 idempotency key 與 request body，取得原 APPLIED 結果且沒有重複套用 revision。

## 尚未驗證

設計／本機實作階段沒有部署；2026-10-04 已依使用者後續部署要求完成下述 NAS release。Telegram 投遞、mobile、真實 Attention producer 及正式資料的 READ／SNOOZE／UNSNOOZE 仍未驗證。暫存 browser fixture 不代表外部整合已驗收。

## 2026-10-04 NAS release

- Source commit：`7571a47525b539e95d1b08043048ed41cf4b0496`。
- [GitHub Actions 37160628398](https://github.com/cuweiwei/PersonalAiControlPlane/actions/runs/37160628398)：check、Windows installer 與 image jobs 全部成功。
- Production digest：`ghcr.io/cuweiwei/personal-ai-control-plane@sha256:8e85a266c743e3a130a2aace0363493a620010c52931b65fdb52b327efed913b`。
- Staged Compose SHA-256：`3b9e9f5e5bfd0632bf1c006065b11129d0737eecc1bbe634666d865140a902b7`。
- `/usr/local/bin/deployment PersonalAiControlPlane validate/deploy/status` 成功。Gateway 沒有設定 HTTP health probe，因此另行核對容器 health 與下列 HTTP endpoints。
- 2026-10-04 07:13:53（Asia/Taipei）核對：實際 container `running/healthy`、restartCount=0；RepoDigest 與上述 digest 相同，OCI revision label 與 source commit 相同。
- `/healthz`、`/readyz`、Attention OPEN 列表、Routine binding 列表回 200；不存在的 Attention detail 回 404；非法 state filter 回 400。正式 DB `PRAGMA integrity_check` 回 `ok`。
- 正式 HTML 使用 `/assets/index-1gowMUDJ.js`，bundle 包含待處理中心與 UNSNOOZE。Mac 透過 [正式入口](https://gnest.taila77e5f.ts.net/attention) HTTP smoke 回 200。
- 內建瀏覽器的正式入口因 tunnel 連線失敗未完成視覺／互動驗證；NAS 自身無法解析該 Tailscale hostname，但 Mac HTTP smoke 成功。沒有為此改 DNS／網路設定。
- `agent_work_attention_enabled` 保留既有 `false`，capability 回 `FEATURE_DISABLED`。本次部署未啟用其他 Agent Work flags，也未建立正式測試 Attention 或發送外部訊息。

### 資料／設定備份與回滾

備份目錄：`/volume1/docker/PersonalAiControlPlane/backups/attention-predeploy-20261003T230926Z`。
`data-config.tar.gz` 包含 SQLite backup API 產生的一致 `identity/data/controlplane.db` snapshot、其餘 data／artifacts、正式 `.env` 與舊 Compose；`running-image.txt` 保存舊映像與 mount metadata。SQLite snapshot integrity、`SHA256SUMS` 和 archive listing 全部通過。沒有把 secrets 或備份內容提交到 Git；本次未做獨立 restore drill。

線上備份原始預設分批方式未及時完成，改用每批 10,000 頁完成一致 snapshot。備份完成後才部署；未新增 migration。舊 rollback digest 為 `sha256:9a90b0c40d2ff1fb5fe71fc121d8dec17958cca22b96270641d7da294a7bcf82`。

如新版本 health／readiness 或 API contract 失敗，將上述 backup 的 `snapshot/compose.prod.yml` 複製至 `/volume1/docker-deploy/staging/PersonalAiControlPlane/compose.prod.yml`，再使用 shared gateway validate／deploy／status 回滾，並重查 running digest 與 health。一般 image 回滾不還原 DB；資料還原需要另行確認資料版本與停止寫入，不能直接覆盖運行中的 DB。
