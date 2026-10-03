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

沒有執行 NAS／production deployment、Telegram 投遞或 mobile 驗收；沒有接通或驗證真實 Attention producer。暫存 browser fixture 不代表 production DB 或外部整合已驗收。本輪未 commit、push 或 deploy。
