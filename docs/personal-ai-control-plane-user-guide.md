# Personal AI Control Plane — 使用說明書

適用對象：第一次使用本系統的 owner，以及需要從功能角度了解 Control Web 的使用者。

本文件依目前 repository 的 Control Web 與 API 行為編寫。功能是否已接上正式環境、實體 worker 或外部 provider，請以 [Implementation Status](implementation-status.md) 與頁面中的即時狀態為準。

目前 repository 版 CLI 以 `file-fallback` 保存裝置 key/credential，僅供本地協定測試；正式簽署套件必須改用 macOS Keychain 或 Windows Credential Manager，並重新完成實體裝置 evidence。

![Personal AI Control Plane 系統架構與使用入口](assets/personal-ai-control-plane-architecture-zh-TW.svg)

## 1. 這套系統可以幫你做什麼

Personal AI Control Plane 用來接收一個高階目標，將它保存成可追蹤的 Goal，再規劃成多個工作、判斷是否需要核准、選擇合適的運算資源、執行、驗證並保存結果。

適合交給系統的工作包括：

- 需要多個步驟或較長時間完成的工作。
- 需要定時執行、失敗重試或中斷後恢復的工作。
- 需要跨 NAS、Mac、Windows 或不同 AI provider 的工作。
- 需要使用 Codex、Local LLM 或 deterministic tools 的工作。
- 需要在執行前確認風險、預算、權限或影響範圍的工作。
- 需要保留 task、checkpoint、artifact、audit 與驗證證據的工作。

如果只是單次、無副作用的簡短聊天，未來可由 Hermes 直接回答；需要修改資料、排程、跨機器、核准或 durable result 時，則應建立 Orchestrator Goal。

目前正式入口由 Personal AI 自有輕量 edge 提供：Tailscale HTTPS `:443` 轉到 NAS loopback `127.0.0.1:9084`，再分流 Identity、Control Web、Orchestrator/SSE、Worker WSS 與 ContextHub Memory。AI Home Platform runtime、其共用 edge 與 `:9443` 入口已退役但保留可回復的資料、Compose 與 immutable image；Portal 不再提供 Infrastructure 頁面或 AI Home Platform API。基礎設施的部署、停止與 rollback 由 owner/operator 透過 root-owned deployment gateway 執行，Orchestrator 不持有 Docker socket、NAS root 或 gateway 權限。

## 2. 第一次使用：最快完成一個 Goal

### 2.1 登入前準備

你需要：

1. 已連上系統使用的私人網路，例如 Tailscale。
2. 系統管理者提供的私有 HTTPS Control Web 網址。實際網址由正式環境的 `PAI_CANONICAL_ORIGIN` 決定，不要使用未確認的範例網址。
3. 已註冊的 Passkey。

如果你是第一位 owner，Identity Gateway 會要求一次性的 bootstrap token 來註冊第一把 Passkey。只在 Identity Gateway 的瀏覽器表單中輸入該 token；不要把 token、recovery code 或其他秘密貼到 Goal、Telegram、文件或聊天中。

完成第一次 Passkey 註冊後，請立即將畫面提供的 recovery codes 離線保存。之後登入只需要 owner login 與 Passkey。

### 2.2 建立第一個 Goal

1. 開啟正式 Portal 網址；未登入時會顯示 Passkey 頁面，成功後自動進入 `/home`。
2. 從上方導覽列選擇 **Goals**。
3. 在「新增 durable goal」欄位輸入想完成的事情。
4. 選擇「提交 Goal」。
5. 系統先保存 Goal，再開始規劃；畫面會出現可持久追蹤的 Goal 記錄。
6. 選擇該 Goal，查看 plan、tasks 與 events。
7. 如果工作停在 `WAITING_APPROVAL`，前往 **Approvals** 檢查並決定是否核准。
8. 完成後確認 Goal 為 `COMPLETED`，並檢查結果與 verification evidence。

建議用「成果 + 限制 + 驗收條件」描述 Goal，例如：

> 整理本週專案進度，產出一份繁體中文 Markdown 週報；只能讀取指定 repository，不要部署或傳送外部訊息；完成前檢查所有引用的 commit 與測試結果。

不要只寫「幫我處理一下」；越清楚的成果與限制，越容易得到可驗證的 plan。

## 3. 功能選單總覽

| 選單 | 主要用途 | 你可以做的事情 |
| --- | --- | --- |
| **首頁** | 單一日常入口 | 一次查看 Goal、服務、Memory 與 Personal AI runtime 摘要 |
| **Goals** | 提出與追蹤工作 | 新增 Goal、查看 plan/tasks/events、取消、重試可恢復工作 |
| **Approvals** | 控制風險與資源邊界 | 檢查風險、plan digest、資源與權限範圍；Passkey 核准或拒絕 |
| **Schedules** | 建立週期性工作 | 建立間隔排程、暫停、立即執行、延後一小時 |
| **Workers** | 管理執行節點與能力 | 查看 worker/capability、Drain、Wake、Passkey grant 或撤銷 |
| **Compute** | 查看 AI 與工具路由 | 查看 provider 狀態、quota observation 與 effective routes |
| **Conversations** | 管理原始對話 | 查看、匯出、Passkey 刪除與 purge |
| **Connectors** | 查看外部整合 | 查看同步狀態、手動同步、重新授權 |
| **Credentials** | 查看 credential handle | 查看用途、scope、健康與到期狀態；不顯示秘密值 |
| **Policies** | 管理系統自治規則 | 查看版本；以 JSON 建立新的 immutable policy revision |
| **Audit** | 查核系統操作 | 查看最近的 actor、action、target、decision 與 hash chain 資訊 |
| **System** | 查看整體狀態 | 查看 health、Goal/Approval/Worker/Provider/DLQ 數量與外部入口 |
| **Systems** | 集中查看獨立服務 | 查看服務健康、版本與 evidence；Hermes 從卡片開啟其獨立 Dashboard |
| **Memory** | 查看語意記憶 authority | 在 Portal 檢索 ContextHub accepted Memory；review 與 policy mutation 仍由 ContextHub 管理 |

## 4. 常見操作

### 4.1 查看 Goal 的執行進度

1. 在 **Goals** 選擇一筆 Goal。
2. 先看 Goal 的 `status` 與 `stateVersion`。
3. 查看 `plans`，確認目前 active plan 與 plan digest。
4. 查看 `tasks`，找出正在執行、等待或失敗的工作。
5. 查看 `events`，了解最近的狀態轉換、原因與 redacted evidence。
6. 使用「重新整理」取得 authority 的最新 projection。

畫面的即時通知或 SSE 只是提醒；重新連線後仍應以 REST 重新整理出的資料為準。

### 4.2 取消或重試 Goal

在 Goal detail 中：

- 選擇「取消 Goal」會要求系統進行 bounded cancellation。它會改變 durable state，因此畫面會再次確認。
- 選擇「重試可恢復工作」只會重試符合恢復條件的工作，不代表忽略原本的失敗或安全邊界。

如果外部副作用的結果不確定，task 會進入 reconciliation，而不是盲目重送。此時先查看 task events、evidence 與 **Audit**。

### 4.3 核准一個工作

1. 開啟 **Approvals**。
2. 選擇狀態為 `OPEN` 的 request。
3. 檢查 Goal、task、plan digest、policy version、risk、到期時間與 `requiredScope`。
4. 在 `Approved bounds` 中保留或縮小允許範圍；不要擴大原始 request。
5. 選擇「Passkey 核准 bounds」，完成 Passkey step-up。
6. 如果不同意，選擇「拒絕」。

金錢移動、credential 或 security setting 修改、權限提升、永久刪除、安全邊界擴張，以及代表 owner 的高風險外部溝通，都應視為 hard stop。不要只看 Goal 名稱，必須閱讀實際 scope 與 risk。

### 4.4 建立與管理排程

1. 開啟 **Schedules**。
2. 輸入排程名稱。
3. 在 `Goal intent` 描述每次執行要達成的成果。
4. 輸入間隔分鐘數。Control Web 會使用瀏覽器所屬時區。
5. 選擇「建立 Schedule」。

建立後可：

- 「暫停」：停止之後的自動觸發。
- 「立即執行」：現在建立一次正常 Goal。
- 「延後 1 小時」：更新下一次執行時間。

Schedule 不會直接執行工具；每次觸發都會建立普通 Goal，並重新套用 policy、approval、quota 與 audit。

### 4.5 查看或管理 Workers

**Workers** 是 worker 的集中管理頁，包含 enrollment、連線狀態、能力、provider 與生命週期操作。

新增 worker：

1. 在 worker 裝置安裝 `pai-worker`，並以使用者身分建立常駐程序：`pai-worker start --repo-id <logical-id> --repo-path <git-repository>`。macOS 使用 LaunchAgent，Windows 使用工作排程器；程序會自行產生 Ed25519 key pair，私鑰留在該裝置。
2. 開啟 **Workers**。常駐 worker 會自動建立 enrollment request；本頁每 5 秒同步一次，不需要複製 public key 或私鑰。
3. 核對 request 卡片上的 fingerprint 與裝置一致後，按「Passkey 核准此 Worker」。
4. Worker 會自動輪詢核准結果、完成 proof、取得短期 credential，接著透過 WSS（無法建立時使用簽名 HTTP fallback）連線並送出 heartbeat。
5. 等待卡片顯示 `ONLINE`；`APPROVED` 只代表 owner 已核准，仍須等待 proof、heartbeat 與 capability evidence 才能派工。
6. 若 fingerprint 不正確或不再需要，可在同一張 request 卡片按「取消 request」。`pai-worker enroll` / `enroll-finalize` 僅作為無法使用常駐流程時的 recovery。

Worker 卡片會顯示：

- 連線：`ONLINE`、`STALE` 或 `NO_HEARTBEAT`。
- 信任與派工狀態：`TRUSTED`、`DRAINING`、`DRAINED` 或 `REVOKED`。
- 已發現的 capability 及其 `GRANTED` / `REVIEW_REQUIRED` 狀態。
- 綁定的 LLM / provider；沒有 provider 只能表示尚未驗證，不能直接宣稱是 LLM worker。

- **Drain**：停止派發新工作，讓現有工作安全收尾。
- **Wake**：要求喚醒 worker；如果尚未接上 accepted wake adapter，系統會明確回報不可用。
- **Passkey grant capability**：核准該 worker 的特定 capability。系統會綁定目前的 descriptor hash，避免能力內容變更後沿用舊核准。
- **Passkey 刪除 Worker**：安全撤銷 worker 與其 capabilities；這是 logical delete，會保留歷史 attempt、audit 與 evidence。仍有執行中工作時，系統會回報 `WORKER_BUSY`，必須先 Drain 並等待工作結束。

「worker 宣告發現某能力」不等於「該能力已授權」。如果沒有實體 worker、OS vault 或 capability adapter 的 live evidence，不要把列表中的 proposal 當成可執行能力。

### 4.6 查看 Compute 與 quota

在 **Compute** 中查看：

- provider class 與 adapter。
- worker 綁定與 provider health。
- 最近一次 probe evidence。
- quota observation、confidence 與 effective routes。

如果列表為空或 provider 顯示 unavailable，代表目前沒有符合證據門檻的執行路由。系統不會自動改用 API-key 付費模式；Codex 路由必須使用 owner 的 ChatGPT login，除非未來有明確、另行核准的 metered provider。

### 4.7 查看、匯出或刪除 Conversations

**Conversations** 管理的是原始對話紀錄，不是 ContextHub 的 semantic Memory。

- 選擇 conversation 可查看內容與 provenance。
- 「建立匯出 Job」會建立 durable export job；成功不等於瀏覽器已下載檔案，仍需查看 job 與 artifact 狀態。
- 「Passkey 刪除與 purge」會建立刪除工作，要求理由並可封鎖之後重新匯入同一內容。

刪除是高風險操作。Tombstone、delete request 與實體 artifact purge 是不同階段；必須以最終 job 與 artifact evidence 判斷是否完成。

### 4.8 使用 Connectors

**Connectors** 顯示 connector、account handle、cursor、state、counters、error 與 next retry time。

- 「同步」要求 connector 執行一次同步。
- 「重新授權」啟動該 connector 支援的 reauthorization 流程。

如果看到 `CONNECTOR_NOT_CONFIGURED`，代表 live adapter 尚未設定；這不是暫時網路錯誤，也不應以重複點擊繞過。

### 4.9 查看 Credentials

**Credentials** 只顯示 opaque handle 的 metadata，例如 alias、用途、scopes、health、到期時間與最近驗證時間。

系統不應顯示或要求你複製 raw token、password、private key 或其他秘密。需要重新授權時，應從對應 connector 或受控的 credential workflow 進行。

### 4.10 修改 Policies

**Policies** 是進階功能。每次修改都會建立新的 immutable revision，不會就地覆寫既有版本。

1. 先閱讀目前最新 policy。
2. 在 JSON 編輯區輸入完整且有效的 policy object。
3. 選擇建立 revision。
4. 完成 Passkey step-up。
5. 到 **Audit** 確認新 revision、digest 與 actor。

如果不確定欄位含義，不要猜測或貼入範例 policy；錯誤 policy 可能讓工作全部等待核准或無法取得可用路由。

### 4.11 使用 Audit 與 System 排查問題

先看 **System**：

- `health`：目前服務與必要 authority 是否 ready。
- `counts.openApprovals`：是否有工作正在等待 owner。
- `counts.workers` / `counts.providers`：是否存在可用執行資源。
- `counts.deadLetters`：是否有無法正常投遞、需要處理的事件。

再看 **Audit**：

- 找出對應 actor、action 與 target。
- 查看 decision、policy version 與 metadata。
- 不要只以 health `200` 判斷一個 Goal、connector、部署或 purge 已完成。

## 5. 狀態怎麼看

Goal 或 task detail 可能出現以下狀態：

| 狀態 | 代表意義 | 使用者通常該做什麼 |
| --- | --- | --- |
| `PENDING` / `ESTIMATING` | 已保存，正在規劃或估算 | 等待並重新整理，不要重複建立相同 Goal |
| `WAITING_APPROVAL` | 需要 owner 核准 | 到 **Approvals** 閱讀 scope 與 risk |
| `READY` / `DISPATCHED` | 已符合條件，正在等待或進行派發 | 通常不需操作 |
| `RUNNING` / `RESUMING` | worker 或 provider 正在執行 | 查看 events 與 checkpoint |
| `WAITING_RESOURCE` | 沒有符合能力或狀態的 worker/provider | 查看 **Workers**、**Compute** 與 **System** |
| `WAITING_QUOTA` | provider quota 尚不可用 | 等待恢復；系統不會自動切到 API-key billing |
| `WAITING_AUTH` | credential 或 workload authorization 不足 | 查看 **Credentials** 或 connector 狀態 |
| `WAITING_RECONCILIATION` | 外部副作用結果不確定 | 查看 evidence；不要手動重做同一外部操作 |
| `CHECKPOINTED` | 已安全保存進度，等待恢復條件 | 確認阻擋條件，不要刪除 checkpoint artifact |
| `VERIFYING` | 執行結束，正在驗證驗收條件 | 等待最終結果 |
| `COMPLETED` | 驗收已通過 | 檢查結果、artifact 與 evidence |
| `FAILED` | 工作失敗且未自動恢復 | 閱讀原因後，使用「重試可恢復工作」或建立修正版 Goal |
| `CANCELLED` | 已取消 | 如仍需要成果，建立新的 Goal |

## 6. 常見錯誤與處理方式

| 畫面或錯誤 | 意義 | 處理方式 |
| --- | --- | --- |
| `AUTH_REQUIRED` | Passkey session 不存在、過期或已撤銷 | 回到 Identity Gateway 重新登入 |
| CSRF 或 Origin 錯誤 | 網址、session 或瀏覽器頁面狀態不一致 | 確認使用正式私有網址，重新登入後再操作 |
| Passkey step-up cancelled/expired | 敏感操作的再次驗證未完成 | 重新整理並再次操作；先確認 scope 沒有變更 |
| `STATE_CONFLICT` | 畫面上的 state version 已過期 | 重新整理 authority projection，不要重複送出 |
| `WAKE_ADAPTER_NOT_CONFIGURED` | 尚未接上可接受的喚醒能力 | 不要繞過；先完成 worker/wake integration evidence |
| `WORKER_BUSY` | Worker 仍有執行中的 attempt | 先按 Drain，等待工作進入終態後再刪除 |
| `AWAITING_WORKER_PROOF` | Owner 已核准 enrollment，但裝置 proof/heartbeat 尚未完成 | 等待正式 worker runtime；不要手動修改 database |
| `CONNECTOR_NOT_CONFIGURED` | connector 只有契約，尚無 live adapter | 等待正式整合，不要反覆重試 |
| `ARCHIVE_NOT_CONNECTED` | Conversation Archive authority 未連接 | 查看 **System** 與部署狀態 |
| `503 not_ready` | 必要的 identity、provider、worker 或外部 authority 尚未就緒 | 先確認 **System** 與 [Implementation Status](implementation-status.md) |

如果同一問題持續發生，請記錄 Goal ID、task ID、發生時間、錯誤 code 與 Audit event；不要複製 session cookie、token 或 credential value。

## 7. 怎麼選擇正確入口

| 你想做的事 | 建議入口 |
| --- | --- |
| 新增、監控、取消或重試一項工作 | **Control Web → Goals** |
| 核准風險、預算或權限 | **Control Web → Approvals** |
| 建立週期性工作 | **Control Web → Schedules** |
| 查看 AI provider、worker 與 quota | **Control Web → Compute / Workers** |
| 管理原始對話 | **Control Web → Conversations** |
| 管理長期語意記憶 | **Portal → Memory**；進階治理仍屬 ContextHub |
| 查看 Personal AI 與獨立外部服務狀態 | **Portal → Systems** |
| 執行部署或 rollback | owner/operator 依各 repository runbook，經 root-owned deployment gateway；Portal 不執行 mutation |
| 日常聊天、通知或快速查狀態 | **Portal → Systems → Hermes Dashboard** 或 Telegram；Hermes 維持獨立發版 |
| 讓另一個受信任系統建立 Goal | **REST API**；必須使用既有 workload auth 與 idempotency contract |

## 8. 使用時的安全原則

- 不要在 Goal、Telegram 或文件中輸入密碼、token、recovery code、private key 或 session cookie。
- 遇到 Passkey step-up 時，重新閱讀目前要核准的 action、resource、budget、scope 與有效期限。
- 刪除、撤銷 worker、grant capability、修改 policy 與高風險 approval 都不是一般瀏覽操作。
- `Health = OK` 只代表服務可回應，不代表 Goal、部署、connector、backup、restore 或 purge 已完成。
- 外部整合 unavailable 時，系統應明確失敗；不要要求用假資料、fake readiness 或繞過權限完成。
- Orchestrator 不直接擁有 NAS root 或 Docker 權限。基礎設施操作由 owner/operator 經 root-owned deployment gateway 做最後驗證；AI Home Platform runtime 已退役。

## 9. 相關文件

- [新手系統架構與使用入口](assets/personal-ai-control-plane-architecture-zh-TW.svg)
- [Implementation Status](implementation-status.md)
- [High-Level Design](personal-ai-control-plane-hld.md)
- [Detailed Design](personal-ai-control-plane-detailed-design.md)
- [Requirement Definition](personal-ai-control-plane-requirements.md)
