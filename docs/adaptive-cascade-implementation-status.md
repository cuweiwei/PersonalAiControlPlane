# Adaptive Cascade Dispatch Engine：實作與驗收狀態

日期：2026-09-21。此表依本機 source／tests 維護，不代表 NAS 已部署。設計基準：[HLD](adaptive-cascade-dispatch-engine-hld.md)、[Detailed Design](adaptive-cascade-dispatch-engine-detailed-design.md)。

## 本輪補齊範圍

前一輪 CP foundation 與 Hermes boundary 已有 prepare/commit、durable owner journal、唯讀 health adapter 及 rule state tables。本輪繼續處理真實 Hermes gateway 接線、跨 repository wire contract、可选 HTTP semantic provider 與規則管理缺陷。

本輪新增 CP Settings 與 Hermes 的單一開關 authority：`dispatch_enabled`（預設 `false`）位於 `/settings`，可透過 `PATCH /api/v2/settings` 即時切換；Hermes 每次 Telegram／Web pre-reasoning ingress 讀取 `GET /api/v2/dispatch/effective`，不需手動修改 Hermes env 或因切換而重啟。Hermes 的 `HERMES_ADAPTIVE_DISPATCH_ENABLED=true` 只是已部署 hook 的常駐 guard，CP effective setting 才決定是否建立 dispatch intake；CP 關閉時維持原 Hermes model flow。`dispatch_semantic_enabled` 仍是獨立的進階 provider gate，預設關閉。

已確認的 registry 修復：`list()` 讀 immutable revision 的 body；release ID 保留完整 UUID；拒絕未實作 renderer、缺失 slot extractor、重複 placeholder；停用舊 revision 不會移除 active 新版；learned rule 在獨立評估尚未實作前禁止升級 Active。CP contract 另已固定 subject binding、release calibration profile/provenance、Promise deadline、snake_case result wire 與 RELEASED tombstone replay。

## 驗收邊界

| 領域 | 本機程式狀態 | 尚需證據 |
| --- | --- | --- |
| CP Tier 0 | typed health operation、prepare/commit、source key 與持久 receipt | NAS 真實服務、running digest 與權限边界驗收 |
| Hermes boundary | journal、CP client、固定 renderer、reconciliation、CP effective toggle consumer | gateway hook 接線測試與正式頻道 delivery receipt |
| CP/Hermes contract | 跨程序測試以真 CP HTTP server 與 Hermes Python client 執行 | fixture health result 不等於真實服務 health；沒有發 Telegram |
| Semantic provider | 可選 HTTP provider 的私有 endpoint、固定 bundle/rule provenance、response schema、deadline 與 calibration binding 已實作並有 targeted tests；模型仍可替換 | 真實 inference bundle、校準 corpus/profile、precision、CPU/RSS |
| Rule lifecycle | curated rule 的人工狀態與 release 切換可測 | curated 人工操作不是自動學習或統計品質證明 |
| Learned rule | `DispatchLearningService` 可保存 prediction-only shadow、以 structured observation join/replay 比對、保存獨立 label，並產生 evidence-gated promotion report；registry 仍對 learned Active fail closed | 真正 semantic candidate 來源、完整 replay corpus／precision CI、owner 審核與 production promotion 接線 |
| 自動降級／audit holdout | evaluator 可依 confirmed false dispatch 與近 20 筆 failure 產生 `DISABLE`／`SHADOW` 建議；不在 background timer 自動改 rule state | correction/drift/failure 的持久 worker、audit holdout 抽樣接線、實際狀態變更與通知 |
| 模型記憶體／NAS | 未進行本輪 production 測試 | cold/warm/idle 同負載測試、實際 RSS/cgroup/swap |

BGE-small 是可選 reference implementation，沒有把它設成 CP dependency；HTTP provider 支援是 transport/contract 能力，不能宣稱 BGE runtime 或 semantic precision 已驗收。

## 可重現檢查

```bash
npm run check
npm run typecheck
npm test
npm run build:web
HERMES_SOURCE_ROOT=/absolute/path/to/AiSecretaryChloe \
  node --experimental-strip-types --test test/dispatch-hermes-contract.test.ts
```

跨 repository test 未設定 `HERMES_SOURCE_ROOT` 時明確 skip；指定錯誤路徑則 fail。使用 in-memory CP DB、臨時 Hermes ledger、loopback server 與 typed fixture health adapter，不連 NAS 或使用者頻道。它檢查 Telegram/Web envelope 的 wire 相容性、固定回覆、重送不重做及複雜請求 fallback，不是 gateway channel E2E。

## Toggle／recovery 檢查

已以 targeted tests 驗證 off → on → off 不需 Hermes restart；切回 off 不會刪除或重做既有 `CASCADE` pending，restart 後仍由 `reconcile_pending()` 對帳。Web sync／SSE hook 要求 retry-stable `X-Request-ID`／`Idempotency-Key`，並接受 body `request_id`；pinned patch 同時把 `X-Request-ID` 加入 CORS allowlist。沒有穩定 identity 時安全回原 Hermes flow。

## 後續正式啟用順序

先完成本機 gateway hook與restart/reconcile測試，再走資料＋secret/config備份、immutable CI image、deployment gateway 與真實 Telegram/Web驗收。部署需獨立授權，本輪不執行。語意層與自動學習須各自通過品質 gate 才啟用；不能因 Tier 0 已通而一起打開。
