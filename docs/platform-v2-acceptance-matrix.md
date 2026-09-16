# Platform v2 A01–A16 與功能歸屬驗收矩陣

更新：2026-09-16
適用範圍：PersonalAiControlPlane、Hermes、Worker、ContextHub、Information Radar 的整合驗收

本文件是目前可稽核的驗收盤點，不是完成宣告。每一列分開記錄：

- `implemented_local`：原始碼、資料模型或本機測試已具備。
- `ci_verified`：對應 commit 的 CI check、typecheck、tests、build 已通過。
- `live_verified`：已在部署環境以正式 API、Portal 或 deployment gateway 觀測到。
- `provider_verified`：真實 provider、實體 Worker、外部通道或使用者操作已完成且有可追溯證據。

健康、工具清單、HTTP 202、Worker ONLINE、Portal 顯示或 callback `DELIVERED` 都不能單獨提升到 `provider_verified`。

## 最新整合基線

| 項目 | 證據 | 狀態 |
| --- | --- | --- |
| Control Plane source | `999e1c1` — typed task/capability guard、codex workspace contract、Ollama bounded generation options、artifact manifest hash/bytes integrity gate、fault regressions；Compose pin `f1313b0` | `implemented_local` |
| Control Plane CI/image | CI `35038128737` 全部通過；image `sha256:5a9f4fb3a689762bd2ec69b6337b42117e64a7e4ef73053482ceeaeb8f60831e` | `ci_verified` |
| Control Plane production | Compose pin `f1313b0`；PersonalAiControlPlane gateway validate/deploy/status 通過；running digest 與 image 一致；`/readyz`、`/healthz` 200（2026-09-16 08:08–08:09 CST） | `live_verified` |
| CP typed rejection live proof | synthetic `codex` + `llm.inference` request 回 `HTTP 400 TASK_TYPE_CAPABILITY_MISMATCH`，probe key 未建立 Task | `live_verified` |
| CP capability query live proof | snapshot `94e360f9-f09b-4cd2-938d-bfc8f03557a3`：正確 `llm.inference`/`ollama`/`llama3:latest` tuple matched `tw-timhong`；GoosePC 因 unverified/model unavailable 被排除 | `live_verified` |
| Hermes source/runtime | closed-schema/runtime validation fix 已部署；-04 的拒答結果保留為 validation failed，-05 已以新 key 完成 Work/Task/Run/Attempt 與 criteria PASS；ContextHub 未 configured | source `implemented_local`；provider `部分 live_verified` |
| ContextHub | source `c6b168c`；live digest `sha256:ef1cb95cd81c888c2b4abfcc51164ed33de5c433a596b441016dffb7be9dbcff`、health/migrations/retrieval projection 通過；personal secret adapter 尚未可用 | `live_verified` 部分完成 |
| Information Radar | candidate source/CI 已有；gateway health attempts 1–12 全 failed 後 rollback，候選容器與人工 health endpoints 曾 200/healthy；`/api/v2/radar/projection` 503 `PROJECTION_AUTH_UNAVAILABLE` 屬 fail-closed；production 保留舊 healthy digest，root-owned probe 細節待 owner 提供 | `implemented_local` / `live_verified`（舊版） |
| Hermes fresh typed text acceptance | Work `work-11badd7667874f469aabee05621db9b9`、criteria hash `sha256:c8b3e86e217e1573a2d0b757727a1e6806cc42fed12d5e2261aa9513c3f7d4a6`；Task `01a0a768-a097-7bd0-b7be-ab95cf80ae1b`、Run `01a0a768-a098-7701-a71d-e6345cea1824`、Attempt `01a0a768-a2fe-7752-b293-460b4ad1c5fe`；result 原樣回傳安全拒答，validation `FAILED`，無 artifact、delivery 未請求 | `live_verified`（transport/execution/validation persistence）；content acceptance `未通過` |
| Hermes fresh typed text acceptance -05 | Work `work-bde480f811cc450da6cb111739007d74`、criteria hash `sha256:566fe6b0f14066d841bca6f124733eb0583a1decb7678dacfcf73b6eb33d0488`；Task `01a0a776-6f9d-7413-b59a-334604c9da7a`、Run `01a0a776-6f9e-70ab-891e-8083b99fa55a`、Attempt `01a0a776-70b5-70c3-871a-51d9d2483508`；raw result `text="2"`、model `llama3:latest`，validation `validation-d01fa83cf7114361b0be56f51886a03a` expected=2/actual=2 `PASSED`；artifact manifest AVAILABLE 且 artifacts=[]、delivery 未請求 | `live_verified`（typed transport/execution/raw result/criteria persistence）；delivery `未驗證` |

## A01–A16 驗收矩陣

| ID | 驗收要求 | 已實作與測試依據 | Live／provider 證據 | 尚缺工作與 owner |
| --- | --- | --- | --- | --- |
| A01 | 簡單文字路由不強制 discovery；無 CP Task | Hermes/CP 分工與 adapter contract 已定義；CP 不把一般對話自動建立 Task | 尚未取得一筆可追溯的「直接回覆且無 CP Task」live transcript | Hermes 需提供一次不涉及背景工作的對話證據；owner：Hermes |
| A02 | typed input、workspace、criteria、artifact hash；真 Codex Worker 修改 repo 並驗收 | CP v2 parser、workspace lock、attempt fence、artifact manifest、result/delivery 分離；`test/platform-v2-contract.test.ts`、`test/v2-core.test.ts`、`test/v2-worker.test.ts`、artifact tests；本輪新增 task type guard regression | live text Task 已能建立／執行／持久化 validation，但不代表 Codex；`tw-timhong` workspace inventory 為空、Codex executor 未啟用，沒有真 Codex diff/test/artifact | 需 owner-approved Codex executor、明確 workspace、真實 bounded change、diff、tests、artifact、Hermes criteria acceptance 與 Portal 對照；owner：Worker + Hermes + CP |
| A03 | GPU/runtime/model hard match；忙碌回 CAPACITY；真實批次輸入／輸出與資源觀測 | scheduler runtime/model/resource/load rules；`test/functional-ux.test.ts`、`test/v2-core.test.ts`；不存在模型與 unavailable runtime 會排除；Ollama executor 現明確傳 bounded temperature/num_predict | live capability snapshot 正確匹配 Ollama；GoosePC unverified/model unavailable 明確被排除；fresh text Task 的實際 model identity 為 `llama3:latest`；尚無 GPU batch | 需真 GPU Worker、批次 workload、capacity wait、CPU/RAM/I/O 與 scheduler latency 量測；owner：Worker + CP |
| A04 | accepted/ACL/revision 過濾；candidate/expired/revoked/conflict 排除；新對話 recall | Agent Work/approval/goal tests、CAS/idempotency services；CP capability/worker grant filters | 未完成 Hermes 新對話 recall 的 provider evidence；ContextHub secret adapter 尚未可用 | 需 Hub owner acceptance、source/version recall、ACL/revision 負向 live case；owner：ContextHub + Hermes |
| A05 | insight version 去重、candidate→review→accepted、未來對話引用 | Radar source/insight/publication domain 與 Hub candidate/review model 已有本機實作／測試 | Radar candidate 未升版 production；Hub 人工採納與新對話引用尚未取得 | 需 owner 在 Hub 採納一筆 Radar candidate，驗證 revision/hash 與後續 Hermes recall；owner：Radar + ContextHub + Hermes |
| A06 | event 重送／亂序／過期、publication 未完成；不重複 Work、不誤批准 | callback/outbox、event cursor、idempotency 與 publication state tests；`test/v2-callback.test.ts`、agent-work tests | 尚無跨 Radar publication 與 Hermes Work 的 live duplicate/reorder evidence | 需使用固定 event id 注入重送、亂序、過期與 publication failure，驗證同一 logical Work；owner：Radar + Hermes + CP |
| A07 | 同 key 同內容重送、不同內容 conflict、舊 attempt/fence 回報 | Task service idempotency/CAS、attempt fencing、late result audit；`test/platform-v2-contract.test.ts`、`test/v2-core.test.ts` | live 舊 task `01a0a590-415e-7e0f-9f39-b0ecac5fd2b9` 保留單一 run/attempt；fresh -05 Work 回報 `replayed=false`、CP `deduplicated=false`，projection `replayed=true` 先原樣保留；synthetic mismatch 未持久化 | 尚缺 production 同 key replay/conflict 與舊 attempt 回報案例，並需釐清 projection replay metadata 是否符合定義；owner：CP + Hermes |
| A08 | 失聯、timeout、cancel ack 無 children evidence；UNKNOWN 仍占用，對帳後才重派 | UNKNOWN/effect/stop receipt、workspace lock release tests；`test/platform-v2-contract.test.ts`、`test/v2-core.test.ts`、`test/v2-worker.test.ts`（新增實際 child timeout/crash/cancel） | live acceptance counters `unknownExecutions=0`、`unknownAttempts=0`、`unknownSlots=0`；這不是 Worker process crash proof | 需真 Worker process crash、cancel 無 children evidence、保留 UNKNOWN、完成 stop/reconciliation 後才 release；owner：Worker + CP |
| A09 | Hermes/CP/Worker 各 crash window；Task/result/delivery 不遺失、不重做 effect | durable DB/outbox/local Worker journal、restart-related tests；recovery mode/authority epoch/fencing 已實作 | 尚無本輪跨三服務的 production restart drill；未宣稱 NAS restart proof | 需逐一執行 §6.3 crash matrix，記錄 Task/run/attempt/event/artifact/delivery IDs 與 effect non-duplication；owner：Hermes + CP + Worker |
| A10 | provider 已接收但 ack 遺失、明確失敗；原 Task 不重跑，delivery UNKNOWN 可見 | callback outbox、delivery receipt/retry state machine；`test/v2-callback.test.ts`、virtual-office delivery tests | 舊 task failure callback `DELIVERED`，但 `replyState=UNKNOWN`；fresh -04 validation failure 與 -05 validation pass 的 delivery 都未請求；兩者都不是 provider success ack | 需真 provider accepted/ack-loss/explicit-failure case，證明不觸發 Task retry 且 delivery 可對帳；owner：Hermes + external provider |
| A11 | 假能力、過期驗證、撤銷 credential、缺 workspace 不派工 | capability grant/evidence TTL/revocation/workspace filters；`test/v2-core.test.ts`、`test/office-scene.test.ts`、worker tests | live snapshot 將 GoosePC unverified、tw-timhong unavailable runtimes、absent oMLX models 分開呈現；Codex workspace 缺失未被假裝可用 | 需實體 Worker capability revoke/expiry/credential rotation 與 Codex workspace negative case；owner：CP + Worker |
| A12 | approval 內容／目標變更、錯 reply、重播、越權；有效批准沿用 | Hermes brain v2、approval/CAS、agent-work tests；CP 不保存 memory authority | 尚無 live Telegram approval/reply receipt；ContextHub provider secret 仍未配置 | 需 owner-approved Telegram approval replay/changed-target/invalid-reply cases；owner：Hermes + ContextHub |
| A13 | artifact missing/hash mismatch/expired、假 progress；真檔可下載，異常阻止成功交付 | ArtifactStorage digest/upload/download、result manifest、實體檔案 hash 驗證；`test/v2-http.test.ts`、`test/v2-e2e.test.ts`（新增 missing/bytes corruption/claimed hash mismatch）、`test/v2-worker.test.ts`、release/result tests | live 舊 failure 無 artifact，Portal 只顯示失敗；尚無真 Codex artifact | 需真 Codex diff/test artifact、hash expiry/false progress injection 與 download verification；owner：Worker + CP + Hermes |
| A14 | dependencies unavailable、projection stale；Portal 不造健康或進度，browser/API 對照 | systems/office projection、freshness/evidence states、fail-closed dependency routes；`test/office-scene.test.ts`、`test/hermes-capabilities.test.ts`、HTTP tests | `/api/v2/acceptance` ready、recovery false、unknown counters 0；Portal `/tasks`、`/models`、`/office` 已與 API 對照；role/Worker binding mismatch 如實顯示；Hub/Radar 各自證據分開 | 尚缺實際 browser operation 與 dependency outage/stale window 的完整 live case；owner：CP + browser broker + Hub/Radar |
| A15 | reader-first migration、legacy routing、升降版與 mapping；Goal/Skill/Schedule restart、occurrence 唯一、舊 loop 不接新版、Office 保留、restore drill | versioned CP contract、legacy parser preservation、ownership/operation catalogs、Agent Work tests、Office persistence；Hermes audit 確認 live MCP 不做 task type mapping；closed-schema/runtime payload guard 已部署 | CP deployment/Portal/Office 保留已 live verified；Hermes fresh Task/validation persistence 已 live；Goal/Skill/Schedule restart、跨 repo restore 尚未 provider verified | 需 Hermes native scheduler/Goal/Skill/Work restart、occurrence dedup、legacy/new loop fence、各 repo rollback/restore drill；owner：Hermes + CP + ContextHub + Radar |
| A16 | measured/estimated/unavailable、provider record overlap；無偽零／重複加總、coverage 正確 | resource/evidence projections、usage/agent-work domain tests；未知值保留 null/UNKNOWN 的 UI/API 規則 | Portal/CP live 只可見 Worker inventory 與 `NOT_TRACKED/provider_verified=false` cost status；尚無 provider usage record | 需收集各 provider 原始計量、區分 measured/estimated/unavailable、去重 overlap 並產出 coverage；owner：CP + Hermes + provider owners |

## 功能歸屬與移交矩陣

| 功能／資料 authority | Owner | CP 的責任 | 目前狀態與移交證據 | 不可越界事項 |
| --- | --- | --- | --- | --- |
| 對話分類、策略決策、Goal、Plan、Skill、Routine、背景續接 | Hermes | 提供 typed Task、狀態／結果／delivery 查詢與 bounded receipts | Hermes v2 MCP tools/source 已存在；provider turn/原生 scheduler restart 尚未完成驗收 | CP 不替 Hermes 產生策略、Plan 或下一步決策 |
| Task contract、scheduler、Worker registry、attempt/run/fence | Control Plane | 版本化 parser、capability all-of、resource／workspace gate、歷史與 reconciliation | CP `999e1c1` + digest `5a9f4fb...831e` live；錯誤 tuple 已 pre-dispatch reject；artifact manifest 會驗證 declared hash、DB digest 與實體 bytes；Compose `f1313b0` | 不把 generic 轉 shell；不以 Worker ONLINE 代替 executor/result |
| 實際 typed execution、workspace、process/effect evidence | Worker | 提供 offer、attempt evidence、result manifest、artifact refs | Ollama executor live inventory；`999e1c1` 延續明確傳 generation options；新增 actual command child timeout/crash/cancel 隔離測試；Codex executor/workspace 尚未 provider verified；fresh -05 text result 原樣保存且 validation PASSED（-04 失敗歷史仍保留） | 不把 Ollama inference 當 Codex workspace/diff/test |
| 共享記憶、candidate、review、accepted、recall | ContextHub | 僅保存必要 refs／狀態與 dependency evidence | ContextHub source/health live；personal secret adapter 尚未 available | CP 不成為 memory authority，不複製 conversation archive |
| 資訊來源、insight version、publication ledger | Information Radar | 顯示 dependency／publication 狀態與來源 evidence | 舊 production 版本 healthy；candidate rollout 的 gateway health gate 未通過 | CP 不代替 Radar 採集、判斷 insight 或發布 |
| 外部通知／Telegram／provider delivery | Hermes／各 provider | 保存 delivery state、receipt、UNKNOWN 與 retry boundary | failure callback delivery 有 live evidence；成功 provider ack 未驗證 | SENT/DELIVERED 不等於已閱讀或使用者已接受 |
| Portal／Virtual Office presentation | Control Plane | 只讀取 API authority，分開 configured／observed／activity | `/tasks`、`/models`、`/office` live rendered/API 對照；binding mismatch 如實呈現 | 動畫、heartbeat、health badge 不授予執行或成功語意 |
| Secrets、backup/restore、NAS deployment | 各 repo／root-owned gateway | 只能透過 allowlisted gateway 與 public API | CP immutable deployment 已完成；Hub secret、Radar root probe、跨 repo restore 尚缺 | 不讀取／複製 secret，不直接改 root-owned Compose／gateway |

## Closure order

1. typed text 的新 operation key 已完成正確 `llm.inference + ollama + llama3:latest` tuple、raw result 與 criteria PASS；下一步是另行驗證 delivery receipt，不能把未請求 delivery 當完成，也不能重用 `01a0a590-415e-7e0f-9f39-b0ecac5fd2b9`。
2. A02 另行使用 owner-approved Codex Worker、明確 workspace 與 bounded change；必須產生可下載 diff/test artifact，並由 Hermes criteria acceptance 關閉，不能用 Ollama 代替。
3. 執行 A07–A10、A13 的 crash／receipt／artifact 負向案例，再執行 A09/A15 的跨服務 restart/rollback/restore drill。
4. ContextHub secret adapter、Radar root-owned probe、provider usage／delivery evidence 由各 owner 在其 authority 內完成；CP 只收 typed receipt 與 projection。

在上述 evidence 尚未取得前，整合狀態應標示為「CP contract/scheduler/Portal 已部署；Hermes typed text 已完成實際 Task/Run/raw result/criteria validation PASS，但 delivery 未請求；跨 provider 真實閉環與 A02/A03/A05/A06/A09/A10/A12–A16 的部分驗收未完成」，不能宣稱全案完成。
