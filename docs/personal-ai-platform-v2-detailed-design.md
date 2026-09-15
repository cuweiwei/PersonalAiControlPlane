# Personal AI Platform v2 — Detailed Design

日期：2026-09-15｜版本：1.0｜狀態：**設計提案；本文件不宣告實作、部署或外部驗收完成**。

依據：[需求 v2.1](personal-ai-platform-v2-system-requirements-v2.1.md)、[審查報告](reviews/personal-ai-platform-v2-review.md)、[HLD](personal-ai-platform-v2-hld.md)。HLD 定義責任與取捨；本文定義目標契約、交易、錯誤、恢復與驗收。

## 1. 規範、版本與不變條件

### 1.1 設計標記

- **沿用**：本機有契約或程式基礎，仍須驗證新版需求；不是 live_verified。
- **新增／調整**：本文提出的目標契約、欄位、路由與模組，尚未實作。以下未特別標示的 schema 與 pseudo-code 均屬此類。
- **上線設定提案**：供實測選定，不能當成使用者已確認的容量或 SLO。

所有時間在契約使用 UTC RFC3339，duration 明列單位；排程另保存 IANA timezone。Opaque IDs 不承載權限。`revision` 是 authority 的單調版本，不用 wall clock 判斷先後；producer sequence 只在同 subject 與相同 producer epoch 內排序。

### 1.2 版本相容

沿用 HTTP `/api/v2` 與六個 Task enum；新增 Task contract revision `2`，以 request `schema_version: 2` 選用。缺省視為既有 contract `1`，既有 parser 保持原行為。新欄位不得直接送進會 rejectUnknown 的舊 parser。

CP capabilities metadata 公告 `task_contract_versions`、`worker_protocol_versions`、`features`、`server_version`。MCP adapter 先協商再轉接。Worker protocol 實際版號由既有實作盤點後指定；必須有 `attempt_fencing`、`stop_evidence`、`durable_result_ack` 等 feature 宣告及測試，不以版本名稱代替證據。

V1 client 可讀舊狀態與歷史；V2 任務的 mutation 若缺必要 revision／新語意，回 `CONTRACT_UPGRADE_REQUIRED`。舊頁面若無法顯示 unknown／stop evidence，導向新版 detail 或阻止不安全重試，不能將 CANCELLED 當可重做證據。Legacy active Task 固定 `execution_semantics=legacy`；新版為 `platform_v2`，不在執行中切換。

### 1.3 不變條件

| ID | 必須維持 |
| --- | --- |
| I01 | 每個 Work／operation 只有一個 lifecycle owner；新版 CP 不啟動策略決策 |
| I02 | 接收端 commit Task＋operation receipt 後才回受理；相同 scope/key 只對應一份 canonical request |
| I03 | 結果須符合 current run、attempt、Worker identity、fence；舊結果僅入稽核 |
| I04 | 不可觀測不等於停止；停止不等於外部效果未發生；兩者都必須對帳 |
| I05 | 資源與 workspace 只有取得相符停止／完成證據後才釋放，不因網路 lease 到期釋放 |
| I06 | Task outcome、artifact availability、Hermes validation、delivery 各自有證據與版本 |
| I07 | AI 新共享知識及修正先 candidate；只有 Hub 的使用者裁決可採納 |
| I08 | Approval 綁定 principal、target、內容與有效範圍；同內容有效批准沿用 |
| I09 | inbox/outbox 至少一次、consumer 冪等；不宣稱 provider exactly-once |
| I10 | 各 repo 獨立 schema／release／rollback；projection 不得反寫 authority |

## 2. 模組與資料模型

### 2.1 模組切分

| Repository／owner | 沿用或修改位置 | 目標責任 |
| --- | --- | --- |
| CP | `packages/contracts/src/index.ts`、`tasks/task-service.ts` | contract v2、receipt、狀態、結果與安全重試 |
| CP | `scheduler/scheduler.ts`、`workers/worker-service.ts`、`workers/worker-channel.ts` | 合格集合、原子資源保留、協定、停止／結果對帳 |
| CP | `artifacts/artifact-storage.ts`、`callbacks/outbox.ts`、`server.ts` | artifact integrity、持久事件、共用 HTTP domain services |
| CP | 新增 MCP adapter 與 projection services，實際目錄依 repo 慣例 | 工具包裝、不新增 Task DB；讀取 Hermes／Hub／Radar |
| CP | `missions/*`、`agent-work/*`、`office/scene-projection.ts`、control-web | legacy 分流／退役，新版 Hermes work 投影及 UI |
| AiSecretaryChloe／Hermes | 既有 `pai_control_plane.py`、`services/hermes_office_adapter`，新增 work adapter | 共用 CP client、Hermes 自主 runner、approval、delivery；舊 Office Brain handler 只服務 legacy |
| ContextHub | 既有 canonical commands、MCP／memory federation | candidate、successor、accepted retrieval、ACL 與來源撤回 |
| InformationRadar | 既有 insight／delivery pipeline 加 adapters | publication outbox、event outbox、版本與撤回 |
| Worker 各 backend repo | 既有 daemon、journal、executor | durable assignment、fence、child process stop、artifact upload／result ack |

Hermes 與 Worker 的具體 runtime hooks、原生 Goal 支援、skill versioning、provider receipt 查詢能力仍須在實作盤點；若欠缺，在各 owner repo 補足並回報 feature unavailable，不能以 CP planner 補位。本文不虛構已存在的函式。

### 2.2 Hermes 邏輯資料模型

優先映射既有原生資料，缺少時才增加下列表／等效持久記錄。原生 schedule／skill 不複製成另一套可寫 authority。

| Entity | 主要欄位 | 約束與索引 |
| --- | --- | --- |
| `work_items` | work_id、revision、owner_epoch、source_intent_key、conversation_ref、goal_ref、state、criteria_json/hash、protocol_profile、next_wake_at | unique(authenticated source, source_intent_key)；index(state,next_wake_at) |
| `work_actions` | action_id、work_id、work_revision、kind、lifecycle_owner、operation_key、request_hash、state、task/run refs、native_handle、result_ref | unique(work_id,operation_key)；owner 發出前固定 |
| `work_waits` | wait_id、work_id、action_id、kind、question_revision、expires_at、resume_schema、state、reply_ref | 只能對 OPEN 且版本相符的等待 CAS 回覆 |
| `work_leases` | work_id、runner_id、epoch、expires_at | 一個 active runner；lease epoch 只 fence runner，不證明外部程序停止 |
| `goal_refs`／`skill_refs` | native_id、native_version、content_hash、source_mapping | 指向原生 authority；Task 保存執行時固定版本 |
| `schedule_occurrences` | schedule_id、schedule_version、scheduled_for_utc、timezone、owner_epoch、work_id、state | unique(schedule_id,scheduled_for_utc)；修改版本不得重造同 occurrence |
| `approvals` | approval_id、work/action、owner identity、scope/hash、target、state、reply_ref、expiry、consumed_by | 內容不可變；重送同 operation 可重用消耗結果 |
| `validations` | validation_id、work/action、task/run/attempt、criteria_hash、checks、state、artifact_hashes | append-only；current projection 以 source revision 更新 |
| `deliveries` | delivery_id、operation_key、conversation_ref、payload_hash、state、provider_receipt、attempts、last_error | unique(provider,operation_key)；UNKNOWN 不盲重送 |
| `inbox`／`outbox` | producer/event key、payload_hash、subject/revision、state、attempts、available_at、receipt | inbox unique(producer,event_id)；outbox index(state,available_at) |

### 2.3 CP 邏輯增量

以下是目標欄位，不是可直接執行的 migration SQL；實作必須先比對既有 tables，避免重造 `task_runs`、`task_attempts`、`operation_receipts` 或 callback outbox。

| Entity | 沿用／補足資料 | 必要約束 |
| --- | --- | --- |
| `tasks` | schema version、execution semantics、source identity/key、work ref、criteria、requirements、execution certainty、wait reason、control state | revision CAS；不能由 caller 設 requested_by；新增欄位不改寫舊歷史語意 |
| `task_runs` | 一次顯式執行週期、trigger、retry policy snapshot、attempt budget、result | unique(task_id,run_number)；手動 retry 新建 Run |
| `task_attempts` | worker／boot ID、fence、resolved runtime/model/workspace、occupancy、deadline、stop evidence、effect state | 每 Task 最多一個有效 attempt；UNKNOWN 仍占用 |
| `operation_receipts` | principal/scope/key、canonical hash、response/task ref | unique(principal,scope,key)；與 domain mutation 同交易 |
| `workspace_locks` | canonical workspace_id、lock mode、attempt_id、fence_epoch、state | 每 workspace 最多一個排他持有者；同實體位置別名必須先合併 |
| `worker_capability_evidence` | manifest hash/version、backend/model/workspace、verification status、verified_at、expiry、test ref | verification 綁定版本與 credential epoch；更新／撤銷使舊證據失效 |
| `task_events`／outbox | event_id、subject_seq、transaction revision、payload、durable delivery status | unique(subject,sequence)；狀態與通知同交易 |
| `artifacts` | task/run/attempt、hash、size、storage state、retention、pin reason | 登記必須綁有效 assignment；不可引用另一 Task 的檔案冒充輸出 |
| `external_projections` | source/type/id、source_revision、payload、observed_at、last_success_at | 只接受 source identity 相符且較新版本 |
| `native_operation_records` | Hermes operation ref、摘要、結果 ref、sync status | 不生成 Worker Task；依 source/op 去重 |
| `usage_records` | provider account scope、provider record ID、unit/value、measurement status、period、attribution | 同來源計量只算一次；重複映射可多筆，金額不得重複累計 |

Worker journal 保存 `assignment_id/task/run/attempt/fence`、input hash、workspace lock、boot ID＋process handle＋process start time、child handles、progress sequence、result hash、upload refs、ack state。不可只靠 PID 判斷是同一程序。

## 3. Hermes 持久流程與恢復

### 3.1 Work 狀態

`READY → DECIDING → WAITING_TASK | WAITING_INPUT | WAITING_APPROVAL | WAITING_RECONCILIATION | VALIDATING | DELIVERING → COMPLETED`；另有 `FAILED`、`CANCELLED`。

這些是 Hermes Work enum，不映射成 CP Task enum。Work 只有 criteria 通過且必要交付有 provider receipt 才 COMPLETED；只存成果未交付時留 DELIVERING。使用者明確取消 Work 不會抹除仍未確認停止的 action，UI 仍顯示 reconciliation pending。

### 3.2 每次喚醒的交易順序

1. 以 CAS 取得 Work lease／epoch，讀持久 state；已 terminal 且無 reconciliation／delivery 待辦者不啟動 LLM。
2. 先處理 inbox：對所關聯 Task 讀 authoritative snapshot；去重、補 sequence 缺口、更新 action projection。
3. 依當前 Work revision 喚起 Hermes。輸出只含可執行 action proposal、scope、criteria 與使用者可理解摘要，不儲存私有思考。
4. 在一個本機交易內驗 expected revision／lease epoch，保存 action intent、operation key、lifecycle owner、相關 wait／outbox；提交後才呼叫外部工具。
5. 外部回應以同 action key 保存。Lease 已變更時不得由舊 runner 開新 action；已發出的外部效果由新 runner 對帳，不把 lease 過期當作失敗。
6. 等待 CP 時保存 task ref/cursor/next_wake_at，釋放 runner；由 inbox 或掃描 timer 喚醒。CP 不呼叫 `mission.decide` 推動新版工作。

LLM proposal 在保存前 crash 可重新推理，因尚無外部 action；action 已保存後 crash 必須先查其 receipt。`delegate_task` 回應遺失時同 key 重送；原生工具無 idempotency／status 能力且 send 後 crash 時進 UNKNOWN，不能自動重做。

### 3.3 持久輸入與排程

補充問題帶 `wait_id`、`work_revision`、`action_id`、`question_revision`、expiry、reply schema。Hermes 校驗原對話與 owner identity，原子消耗等待再恢復 action；過期或目標變更回覆不套用，請使用者針對新問題回答。恢復 Worker 另帶 attempt/fence 與 resume operation key；backend 不支援中途輸入時，先安全停止，交 Hermes 建立修訂 action。

原生 scheduler 是唯一觸發權威。Adapter 在觸發前，以 schedule ID＋scheduled UTC instant 提交 occurrence ledger 與 Work intent；同次 retry 回原 Work。時區和 DST 使用原生 scheduler 語意並在 schedule 保存；ambiguous wall time 必須解析成確定 UTC instant。Missed occurrences 策略每 schedule 記錄 `skip/catch_up/coalesce`，沒有設定前停用自動補跑，不猜測。

Skill 執行固定 native version／content hash；更新不更改活動 Work。Goal／milestone 使用原生模型或 Hermes adapter durable store，restart 能讀回；CP 只保留 refs，不能發出下一里程碑策略。

## 4. Task／Capability 與 MCP 契約

### 4.1 委派輸入範例（新增 contract v2）

以下是設計範例，ID 與 hash 為示意，不是執行證據。

```json
{
  "schema_version": 2,
  "idempotency_key": "work-demo/action-1",
  "source_intent_ref": "intent-demo",
  "conversation_ref": "conversation-demo",
  "work_ref": {"id": "work-demo", "revision": 1, "owner": "hermes"},
  "task_type": "codex",
  "description": "修改指定 API 並提供測試與 diff",
  "input": {"repository_ref": "repo-demo", "base_revision": "commit-demo"},
  "requirements": {
    "capabilities_all": [{"id": "codex", "contract_version": 1}],
    "runtime": {"id": "codex", "version_constraint": "verified-profile"},
    "model": null,
    "workspace_ref": "workspace-demo",
    "data_policy_ref": "workspace-policy-demo",
    "os": null,
    "resources": {"min_ram_mb": 4096, "gpu_required": false},
    "required_worker": null,
    "preferred_worker": null
  },
  "criteria": [{"id": "C1", "kind": "test", "description": "指定回歸案例通過"}],
  "input_artifact_ids": [],
  "priority": "normal",
  "queue_deadline": "2026-09-16T01:00:00Z",
  "execution_timeout_seconds": 1800,
  "retry_policy": {"max_attempts": 1, "effect_class": "WORKSPACE_WRITE"},
  "approval_ref": null
}
```

`requested_by`、namespace、有效 grants 由 authenticated principal 推導。Input／criteria／scope 不可在活動 attempt 中修改；策略或範圍變更建立新 action／Task，保留 supersedes reference。`parent_task_ref` 只作關聯，不授權跨 Worker 子派工。

Canonical hash 含所有會影響執行、驗收、範圍的欄位，排除 trace ID、transport timestamp；先規範缺省值與字串／數字型別，再用既有 canonical JSON hash helper。Receipt scope 為 `(principal, delegate_task, idempotency_key)`。Replay 回原 Task identity 並提供目前 snapshot；同 key 不同 hash 回 conflict，不能替 caller 改 key。

Generic 只接受已登錄 `adapter_id + input_schema_version`，轉成既有 typed backend。沒有 adapter 回 unsupported；不能把 generic 轉成任意 shell。Command backend 仍受既有 allowlist 與 workspace 限制。

### 4.2 能力資料與比對

Manifest 每條 capability 包含 id／contract version、backend、runtime version、具體 model ID／revision、OS/arch、workspace refs、constraints、resource requirements、advertised_at。Evidence 另記 `ADVERTISED/VERIFIED/UNAVAILABLE/STALE`、manifest hash、測試 ref、有效期限。Python／GPU／模型名不互相代替。

合格條件為：owner approved AND credential valid AND enabled AND not drained AND fresh connectivity AND compatible protocol AND 所有 hard requirements AND 當版能力驗證 AND workspace/data authority。資源容量與鎖在 assignment 交易重新檢查；任何未知 hard requirement 不視為符合。

先篩 hard requirements，再依 preferred worker／已載模型／剩餘容量／等待時間／stable worker ID 排序。同 Task 的 `capabilities_all` 全部成立，不是任選一個名稱。Required worker 不可降級。跨機資料傳輸只允許 policy 明確許可的 artifact；local-only 資料找不到本地 Worker 就等待／拒絕。

Discovery 回 `snapshot_id`、`observed_at`、`expires_at`、matched candidates、rejection reasons、verification refs、queue/load、cost status。Discovery 不保留資源。已知能力但忙碌可提交 QUEUED；從未有符合 contract 的 adapter 回 `CAPABILITY_UNSUPPORTED`，硬權限錯誤回 forbidden，不放進無限佇列。

### 4.3 MCP 與 HTTP 映射

下列路由為目標契約；只有註明沿用者本輪已見本機基礎。實作時在同一 TaskService 上加 adapter，不讓 MCP 直接寫 SQL。

| MCP tool | HTTP／domain mapping | 回應 |
| --- | --- | --- |
| `find_capabilities` | 新增 `POST /api/v2/capabilities/query` | 快照、候選、不可用原因 |
| `list_workers`／`get_worker` | 沿用 `/api/v2/workers` domain，擴充 evidence | 授權後 registry＋observations |
| `delegate_task` | 沿用 `POST /api/v2/tasks`，versioned parser | 202 accepted＋Task ID、run、revision、deduplicated；持久提交失敗不回 accepted |
| `get_task_status` | 沿用 `GET /api/v2/tasks/{id}`，新增複合 view | Task、current Run/Attempt、control、certainty、validation、delivery |
| `get_task_result` | 沿用 `GET /api/v2/tasks/{id}/results?run_id=...` | result manifest、availability、download refs |
| `wait_task` | 新增 `GET /api/v2/tasks/{id}/wait?after_revision=...&timeout_ms=...` | 最長 30 秒；changed 或 unchanged snapshot；斷線不取消 |
| `cancel_task` | 沿用 cancel domain，V2 傳 expected revision＋operation key | requested、confirmed_stopped、unknown；非立即停止承諾 |
| `resume_task` | 新增 `POST /api/v2/tasks/{id}/input` | attempt/wait fencing，僅 backend 支援時可用 |
| `retry_task` | 沿用 retry domain，補 stop/effect gate | 新 Run，舊 Run 不改寫；僅符合安全重試條件 |

V2 mutation 使用 `If-Match` 等效 expected revision 與 operation key；receipt lookup 先於 CAS，讓成功但回應遺失的重送仍回原結果。不存在 404、無權限 403、不相容／非法輸入 400、key/revision/state conflict 409、未協商新 contract 426、超限 429、依賴不可用 503。Error body：`code/message/retryable/retry_after_ms/correlation_id/details`，details 不含 secret。

標準 reason codes：`CAPABILITY_UNSUPPORTED`、`CAPABILITY_UNVERIFIED`、`MODEL_UNAVAILABLE`、`WORKSPACE_DENIED`、`WORKER_BUSY`、`WORKER_OFFLINE`、`CREDENTIAL_REVOKED`、`QUEUE_DEADLINE_EXCEEDED`、`EXECUTION_TIMEOUT`、`EXECUTION_UNKNOWN`、`STOP_UNCONFIRMED`、`EFFECT_UNRESOLVED`、`REVISION_CONFLICT`、`IDEMPOTENCY_CONFLICT`、`ARTIFACT_MISSING/CORRUPT/EXPIRED`、`DEPENDENCY_UNAVAILABLE`。

## 5. Task 狀態機與安全派工

### 5.1 正交狀態

| 維度 | 值／語意 |
| --- | --- |
| `status`（沿用） | QUEUED / ASSIGNED / RUNNING / SUCCEEDED / FAILED / CANCELLED |
| `execution_certainty` | NOT_STARTED / OBSERVED / UNKNOWN / TERMINAL_CONFIRMED |
| `waiting_reason` | null / CAPACITY / WORKSPACE_LOCK / INPUT / RECONCILIATION / DEPENDENCY |
| `control.cancel` | NONE / REQUESTED / CONFIRMED / UNKNOWN |
| `control.timeout` | NOT_EXCEEDED / EXCEEDED；不是新 Task enum |
| `occupancy` | HELD / RELEASING / UNKNOWN / RELEASED |
| `effect_state` | NONE_CONFIRMED / APPLIED_CONFIRMED / DEDUP_PROTECTED / UNKNOWN |
| `validation`（Hermes） | NOT_REQUESTED / PENDING / PASSED / FAILED / UNKNOWN |
| `delivery`（Hermes） | NOT_REQUESTED / PENDING / SENDING / SENT / FAILED / UNKNOWN |

失聯時保留原 ASSIGNED/RUNNING status，certainty／occupancy 變 UNKNOWN，等待 RECONCILIATION。取消依相容語意可立即標 CANCELLED，但 control=requested、occupancy=RELEASING；新版 UI 必須呈現「取消已受理，停止未確認」。Worker 後來完成而 Task 已取消，保存實際效果與 late result，不覆蓋 CANCELLED 或自動交付為成功。

### 5.2 轉移與交易

| 觸發 | 原子檢查與變更 | 外部操作 |
| --- | --- | --- |
| 提交 | receipt 去重；建立 Task＋Run＋event/outbox | commit 後回 202 |
| 排隊派工 | status=QUEUED、revision 相符、無未釋放舊 attempt；重檢資格／容量；取 workspace lock；建立 Attempt/fence、ASSIGNED、assignment outbox | commit 後 offer |
| Worker 接受 | identity／attempt/fence／input hash 相符，journal durable ack | 啟動前重檢 scope／本機 lock |
| 程序開始 | current attempt，start evidence；RUNNING | progress sequence 續送 |
| 完成 | current attempt＋terminal evidence＋result manifest；保存 result、Task state、event/outbox；安全釋放 | commit 後 result ack |
| 取消 | receipt＋revision；封鎖新動作，記 request，occupancy RELEASING；無 attempt 可立即 confirmed | durable cancel command 重送 |
| 超時／失聯 | 標 timeout/UNKNOWN，保存 reconciliation event，保留占用 | 查 journal／process／effect；不直接 fail requeue |
| 停止確認 | 綁 attempt/fence 的 stop evidence、children accounted；更新 certainty／occupancy | 再判斷是否可有限重試 |

Assignment 的資格、capacity、lock 與 attempt 建立必須同一 DB transaction，不能只用 scheduler 先讀後 offer 保證 concurrency。每個 workspace 排他＋Worker slot 計入 HELD/RELEASING/UNKNOWN。共享儲存的不同路徑先解析成相同 workspace ID。

### 5.3 Timeout／retry 判斷

```text
if transport response missing:
    resend same operation key or query receipt; do not create attempt
if old attempt occupancy != RELEASED or stop evidence incomplete:
    wait RECONCILIATION
else if effect_state == UNKNOWN:
    wait EFFECT_UNRESOLVED
else if effect_state == APPLIED_CONFIRMED:
    recover existing result; ask Hermes to validate; do not repeat effect
else if effect_state in {NONE_CONFIRMED, DEDUP_PROTECTED}
        and retryable failure is in submitted policy
        and attempts_used < max_attempts:
    create next attempt with new fence, same logical effect key
else:
    finalize known failure; notify Hermes for strategy decision
```

`effect_class` 至少分 READ_ONLY／WORKSPACE_WRITE／EXTERNAL_WRITE；由 typed adapter 校驗，不信任 caller 宣告自己是 read-only。所有自動 retry 都要求舊程序停止；read-only 也不因 heartbeat 遺失釋放 GPU／slot。有 provider idempotency 時仍保存同 effect key 與 receipt。`max_attempts` 含第一次，Run 有固定上限；手動建立新 Run 仍不能繞過 stop/effect gate。Worker 說「cancelled」但無 child process 停止證據不能釋放。

## 6. Worker 協定、事件與 crash recovery

### 6.1 Worker channel

沿用 outbound connection；協商版本後支援 register/heartbeat/assignment/status/progress/log/result/cancel/input/result_ack。每則執行訊息帶 task_id/run_id/attempt_id/fence_epoch/worker_boot_id/message_id/sequence。CP 驗 channel identity 與 active assignment；不能僅相信 payload 的 worker_id。

Worker 收 assignment 先在 journal unique(attempt_id) 保存 input hash；重複相同 offer 回現況，hash 不同拒絕。Result 在本機持久保存直到 CP durable ack；artifact upload 可斷點／同 hash 重送，ack 遺失不得重跑 executor。

重連先上報所有 non-final handles 與 unacked results，再接新工作。CP 對比 active assignments；未知程序保留隔離。Fence 能阻止新命令、回報與受控外部操作，但不能魔法停止隔離機器上的舊 OS process；所以不能憑 fence/lease 過期重派同 workspace。Backend 無 stop/journal 能力不符合新版有副作用工作資格。

### 6.2 共用事件 envelope

```json
{
  "event_id": "event-demo",
  "type": "task.result.recorded",
  "schema_version": 1,
  "source": "personal-ai-control-plane",
  "subject": "task/task-demo",
  "source_epoch": 1,
  "sequence": 8,
  "subject_revision": 12,
  "correlation_id": "work-demo",
  "causation_id": "message-demo",
  "occurred_at": "2026-09-15T08:00:00Z",
  "payload": {"task_id": "task-demo", "run_id": "run-demo", "attempt_id": "attempt-demo"}
}
```

Producer transaction 同時寫 state/event/outbox。Consumer 先驗 authenticated producer，inbox unique(source,event_id)，同 ID 不同 hash 回 conflict，commit 後才 ack。Consumer handling 與本地 state update 同交易；外部副作用用自己的 outbox。持久受理 receipt 不表示 downstream 處理完成。

同 subject 亂序：舊 revision 留稽核不覆蓋；sequence 缺口先讀 authoritative snapshot，再從 cursor 補取。跨 subject 不保證總序。Cursor 超出 retention 回 `CURSOR_EXPIRED`，要求 snapshot＋新 cursor；snapshot 必須帶 high-water cursor，避免掃描與訂閱間漏事件。事件只當喚醒，不把 payload 摘要當最終 Task 真相。

### 6.3 Crash matrix

| Crash／中斷位置 | 恢復動作 |
| --- | --- |
| Hermes intent commit 前 | 沒有外部提交；可重新決策 |
| CP commit 後、Hermes 收回應前 | 同 key 查回 Task；不得新建第二 Task |
| CP assignment commit 後、offer 前 | assignment outbox 重送；Worker 依 attempt 去重 |
| Worker start 後、started 回報前 | journal／boot/process start 對帳；不另起 executor |
| Worker 完成後、result ack 前 | 重送原 result／manifest；CP receipt 去重 |
| CP 收 result 後、Hermes 收通知前 | outbox 重送／Hermes polling 補 snapshot |
| Hermes 驗收後、delivery send 前 | 由 delivery outbox 續送，不再執行 Task |
| provider 接收後、receipt 保存前 | delivery UNKNOWN；可查則查，無查詢能力則保留待處理 |
| DB 還原到舊 checkpoint | 先停新派工、比對 Worker journal／provider effects／outbox，再恢復；不得直接 replay 舊 queue |

## 7. Artifact、驗收與 Delivery

### 7.1 Artifact 契約與存取

Manifest：`artifact_id/task_id/run_id/attempt_id/filename/media_type/size_bytes/sha256/storage_state/access_ref/created_at/expires_at/pin_reason`。State：UPLOADING／AVAILABLE／MISSING／CORRUPT／EXPIRED／PURGING；無權限是 access error，不抹掉存在性權威。

Worker 使用有效 assignment 身分上傳暫存區，CP 邊收邊計 size/hash、檢查 quota，atomic finalize 後才 AVAILABLE。相同 artifact key＋hash 可重送，不同 bytes conflict。路徑由 server 產生，拒絕 traversal/symlink 越界；下載重新驗 caller 的 Task/workspace 存取權，不暴露 Worker 本機絕對路徑。提供既有受認證 download endpoint 或短期 access ref，不能把 secret-bearing URL 長期寫 log。

Result 可表達程序成功但成果異常；「可交付」必須 required artifacts 全部 AVAILABLE 且 Hermes 實際下載驗 hash。沒有必需檔案的純文字結果明列 artifact requirement 為空，不以空陣列假通過原有檔案 criteria。Download expired／unauthorized／hash mismatch 時 validation 不能 PASSED，並記錄具體原因。

### 7.2 Hermes 驗收

每個 criteria 保存 id/kind/expected/evidence refs，criteria hash 在 action 建立時固定。Coding 最低證據：base revision、head/diff、變更檔案、test command、exit code、時間與 log artifact；Hermes 讀 diff 與相關輸出，必要時安排獨立驗證，不能僅引用 Worker 摘要「測試通過」。Worker 內部局部規劃可自行測試／修正，但不能擴張 repository 或外部操作權限。

Validation 保存 task/run/attempt、criteria hash、讀取的 artifact hash、逐條 PASS/FAIL/UNKNOWN、validator version/time。結果不足由 Hermes 發新 action，CP 不自動生成修正任務。CP validation projection 僅接受 Hermes service identity 與較新 source revision；Worker validation 是 evidence，不直接覆蓋 Hermes verdict。

Progress：`stage/message/sequence/observed_at/completed_units/total_units/percentage/evidence_refs`。不可量測 percentage=null；可量測才按 units 計算，total 必須有依據。心跳更新 connectivity，不更新 progress timestamp；Portal 顯示「仍連線，進度未更新」。

### 7.3 Delivery 狀態與對帳

Hermes 在 send 前持久寫 `delivery_id/operation_key/conversation_ref/payload_hash/artifact_refs`。Payload 已發送後不可用同 key 換內容。狀態：PENDING → SENDING → SENT；明確可重試失敗 → PENDING（backoff），永久錯誤 → FAILED；送出是否成功不明 → UNKNOWN。

Provider receipt 至少有 provider、message/delivery ID、destination reference、accepted_at、payload relation。SENT 表示 provider 接收，不表示已閱讀。若 adapter 支援查詢／idempotency，以同 key 對帳／補送；若不支援，UNKNOWN 保留並提供 Portal 結果與人工確認後 resend 路徑，明示可能重複。不能假設 Telegram 或任何 provider 提供未驗證的去重功能。

驗收成功但 delivery 失敗，只重試 delivery。Artifact 在待驗收／待交付時 pin；超過保留期須先通知需要保存或延長，不能靜默刪除造成工作永遠無法交付。長內容分塊時保存 chunk ID/hash/receipt，已確認分塊不重送；所有必要 chunks 確認後才標整筆 SENT。

## 8. Approval、身分與原生工具

Hermes 在需確認動作前提供具體 target、變更摘要、artifact/diff hash、影響及範圍；來源 session 中已有明確、適用的批准可引用，不需同內容再次提問。

Approval record：`approval_id/principal/work_id/action_id/action_revision/operation/target_ref/change_hash/scope/issued_at/expires_at/status/provider_reply_ref`。Telegram button／reply correlation 必須由 Hermes 對上原對話和 owner；多個待批准事項的「好」無明確 reply reference 時不猜。批准同 revision 以 CAS 生效，拒絕、撤销、過期不執行。

Delegation 的 `approval_ref` 由可信 Hermes 連線附帶最小 attestation；CP／Worker 驗來源、operation/target/hash 與有效性，保存 ref，不建對話批准引擎。無法核對必要批准時回 `APPROVAL_INVALID/UNAVAILABLE`；Hermes 處理原批准狀態，不新增第二次 CP 問答。

批准不等於無限期授權。執行前檢查撤销與內容版本；授權已被消耗的同 operation transport retry 回原 receipt，不可用來創建另一個 destructive action。內容或目標變更重新確認。撤銷與 effect 同時發生存在競爭，記錄開始前授權檢查與實際效果；已發生操作走補救，不宣稱撤銷回溯生效。

原生工具維持 Hermes lifecycle，相關 approval 也在 Hermes。CP outage 不阻止原生執行；operation 摘要寫本地 outbox 延後同步。原生 Codex 與 CP Codex action 不能共用同一次執行；需切換時按 §3、§5 對帳。任何部署能力仍只能調用既有受允許 gateway，不交給 Worker 任意 root shell。

## 9. ContextHub 與 Memory Provider

### 9.1 語意映射

| Hermes Provider 語意 | ContextHub 路徑 | 約束 |
| --- | --- | --- |
| prefetch/search | 既有 search／compile canonical commands | 自動 relevant retrieval；只允許目前 accepted 且 ACL 可讀資料 |
| store | `save_memory` | AI 寫入 candidate，identity／namespace 由 server 推導 |
| update | `propose_successor` | 基於 item/revision 提候選，不直接覆寫 accepted |
| sync | 既有變更 feed／`get_changes` 與 pointer 更新 | 帶 cursor／revision；撤回與失效須清 cache |

以上為已知 command 家族的目標整合映射；實際參數由 Hub 現有 schema 產生 adapter，不照本文另造 memory enum。Fact/preference/decision 等先對照 canonical memory_kind，research/insight/event/procedure 按 Hub schema 分 information class/tag 等；無映射拒絕並提出 schema migration，不任意新增 enum。

### 9.2 寫入與採納

Hermes/Radar 以 source identity＋operation key＋payload hash 冪等提交。新知識 candidate；更新 accepted item 指定 base revision 建 candidate successor。使用者在 Hub 審核時，Hub transaction 檢查 current revision、candidate 尚有效、reviewer 權限，接受 successor 並 supersede 舊 item。並行 successor 基於舊版本時回 conflict 重新審查，不能自動 last-write-wins。

Agent 自查候選只能用來追蹤提交，不併入一般共享 prefetch/context。Hub source-projection 權限不得給 Radar publisher 用來自動接受 AI insight。跨 namespace search 由既有 ACL 判斷，global 表示授權集合，不是 wildcard bypass。

### 9.3 快取、衝突與撤回

Local_only 存 Hermes 專屬操作設定；cache_pointer 存 item/revision/cursor/expiry；shared_candidate 存待送意圖與 Hub ref，不是另一份正式記憶。每次用共享記憶確認有效版本；無法確認 freshness 時，不把快取當目前 authority。Hub outage 可繼續不依賴記憶的工作；依賴記憶／授權者等待或詢問。

來源撤回或過期使 item 在一般 retrieval 不可用；不是刪除稽核。更正文字仍先 successor＋人工審核。未裁決矛盾不得呈現單一確定結論，可標示衝突並交使用者審核。Embedding／全文索引可以重建；重建時也必須套用 trust/ACL，不能因暫時缺索引走未過濾全表。

## 10. Radar Publication 與 Actionable Event

### 10.1 三個獨立持久模型

| 模型 | 欄位／唯一性 | 狀態 |
| --- | --- | --- |
| Insight | insight_id、revision、topic/title/summary、sources/url/published_at、detected_at、confidence_basis、importance、entities/tags、evidence、content_hash | ACTIVE / CORRECTED / WITHDRAWN |
| Publication | insight_id/revision、operation_key、payload_hash、hub_item/revision、last_error、receipt | PENDING / CANDIDATE / ACCEPTED / REJECTED / WITHDRAWN / FAILED |
| Event delivery | event_id、insight_id/revision、summary、priority/action_required、expiry、publication snapshot、receipt | PENDING / ACCEPTED_BY_HERMES / FAILED / UNKNOWN |

Insight 同版本 publication unique(source,insight_id,revision)；新增版本用 successor 路徑。Hub accepted 必須來自 Hub 查詢／變更回執，不能因 HTTP accepted 就把 publication 標 ACCEPTED。Publication 與 event delivery 分別有 outbox，任一失敗不回滾已保存的 insight。

### 10.2 Hermes 收件與亂序

Event 採 §6 envelope，payload 包含授權可讀摘要、sources、insight revision、expiry、publication status/ref。Hermes inbox 去重 event ID，再以 insight revision 拒絕舊狀態覆蓋；同 insight 新 revision 可觸發「更新」評估，但先查既有 Work 關聯，不能直接再派相同工作。後續 Work key 為 `(source,event_id,decision_kind)`，action intent 持久後才委派。

過期事件保存 receipt 並標 ignored_expired；notification／高重要性不是操作批准。Hub 尚未可用時可依 event 摘要做即時評估，回覆需區分來源資料與 accepted memory。外部文章與 insight 內含指令不能更改工具／授權政策。

### 10.3 更正與撤回

Radar 保存單調 revision 與 withdraw tombstone。先收到撤回再收到舊 publication 時，不恢復 ACTIVE。Hub adapter 對照來源 revision，拒絕／抑制過時 publication；已有 accepted item 的來源有效性撤回走 Hub 正式授權失效命令，停止一般 recall，保留歷史。若 Hub 現有命令未支援此 scope，必須在 Hub 補 canonical 命令，不能直接改 DB 或當成已完成撤回。

撤回不自動取消已執行 Work：Hermes 檢查是否依賴被撤回資訊，再決定通知、重驗或停止；外部效果不靠撤回事件倒轉。A05 必須包含人工接受後的全新對話 recall，A06 必須測 event 早於 publication 與重送。

## 11. Portal、Registry、Usage 與觀測契約

### 11.1 統一投影 envelope

每個來源區塊回 `source_id/source_revision/observed_at/last_success_at/freshness/data/error`。Freshness=FRESH/STALE/UNKNOWN；health=HEALTHY/DEGRADED/UNREACHABLE/UNKNOWN。STALE 是時間維度，不抹去最後已知 health。Registry config 保存 owner、connection secret ref、contract 與 declared version；observations 保存 reported version、uptime、health、latency/error/count。未知版本不用 declared version 補值。

CP adapter 用既有 service identity 查來源，不接受 UI 任填連線地址。高階 Goal／Schedule／Skill 修改連到 Hermes owner；Memory 審核連到 Hub；CP 只對 Task control／Worker 管理提供自己的操作。Projection source unavailable 時保留最後成功資料並標時間；從未有資料顯示 unknown。

### 11.2 UI acceptance 行為

Task detail 同時顯示 status、execution certainty、stop evidence、occupancy、wait reason、Run/Attempt、artifact、Hermes validation、delivery receipt。取消按鈕先顯示 requested，再依後端確認更新；UNKNOWN 不顯示「已停止」。Retry 不可繞過 backend gate。Worker card 分顯核准／連線／能力驗證／容量，不用一個綠燈代表全部。

Virtual Office 以真實 Worker registry 投影實體人物；role/seat 與 worker binding 分開。Hermes unavailable 顯示過期投影，不能用動畫維持忙碌假象。首頁、Task detail、Worker detail 隨 A02 垂直流程驗收；完整 Systems/Memory/Radar/Usage/Audit 再擴充，仍屬同版範圍。

### 11.3 Usage 與效能指標

計量欄位：`measurement_id/provider/account_scope/provider_record_id/source/period_start/end/value/unit/status/price_version/currency/coverage/attribution_refs`。Status=measured/estimated/unavailable；unavailable 的 value=null。Token、GPU seconds、wall time、貨幣成本分欄。本地執行可標 execution location=local，但未知貨幣成本不是 0。

同 provider record 由 Hermes 和 Worker 回報時按 authoritative record key 合併；沒有可靠 key 者標 overlap_unknown，不合成可信總額。Estimation 與 actual 使用同計量關聯，actual 到達取代估算的總額貢獻、保留估算歷史，不相加。跨幣別未提供價格／匯率版本不直接加總。Coverage 明列已測 action 數／eligible action 數，不能僅用 token 欄位存在推定完整。

Queue time=first assigned−created；每 attempt duration=confirmed finish−start；未開始／未結束為 null 或 ongoing，並標口徑。Failure rate 用指定期間「已確認 terminal 的 runs」為分母，UNKNOWN/cancelled 各自列數，不把未知算成功。Service health/readiness/version/uptime/error/request count/latency，Task resource use 允許 unsupported。

告警與稽核包含 prolonged UNKNOWN、outbox age、delivery UNKNOWN、artifact unavailable、credential revoke、workspace lock age、Hub publication lag、stale projections。Trace 使用 work/task/run/attempt/event/operation refs，不記 secret、完整私人對話或模型私有思考。

## 12. Migration、退役與回滾

### 12.1 版本與 ownership registry

遷移 manifest 每 repo 保存 source commit、image digest/version、schema version、supported contract/features、backup ref、restore procedure、migration ID。Mapping 保存 `source_repo/entity/legacy_id/legacy_revision/target_id/target_revision/content_hash/owner_epoch/migration_state`。

新增 `execution_semantics`／work owner 分流：新版只由 Hermes 接受高階工作；legacy runner 僅處理已登記 legacy IDs。除了 UI 按鈕，API、timer、callback、startup sweep、Routine trigger、Office command dispatcher 都要檢查此分流。切換測試必須證明新版 Task 完成不觸發 CP `mission.decide` 或 plan mutation。

### 12.2 實作與切換依賴

1. 盤點各 repo runtime hooks／DB／protocol，保存相容矩陣；新增 reader-first migration 與完整一致備份。
2. CP 補契約與 safety gates；Worker journal／stop evidence；Hermes ledger、MCP runtime tool loading、memory provider、approval／delivery。
3. A02 真實垂直閉環與最小 Portal；A07–A13 故障注入通過，再完成 Radar／記憶與功能歸屬測試。
4. 遷移 Goal／Skill／Routine 版本與 refs；比對數量、hash、活動 Task、pending waits/approvals、outbox、delivery，保存差異報告。
5. 逐 Work 選 drain 或安全移交；逐 Schedule 切 ownership。新路徑驗收後關閉 legacy intake，歷史仍可查。
6. 已無 legacy pending 工作且回滾窗口條件滿足後，才移除舊控制入口；資料清除另依保留政策，不包含在本設計操作授權。

這是依賴順序，不要求每步重新人工批准或固定分成多次發佈。每次實際部署仍需其已授權 scope 與 gateway 驗證。

### 12.3 活動 Work 移交

可 drain：維持原協定直到已執行效果、驗收及 delivery 完成，禁止 legacy 接新版工作。

安全移交：舊 owner 先 freeze 新 action，保存最後 revision／epoch 與 checkpoints，確認沒有 in-flight 決策或未持久 action；新 owner 以 mapping 匯入 Task refs、criteria、版本與 waits。未停止的既有 Task 可以原協定繼續，但只能被新 owner 觀察，不能新派同工作。舊 owner 先持久標 TRANSFERRED/fenced，再啟用新 owner；中間 crash 留「無 active owner」可恢復狀態，不能兩者同時 active。無法證明舊 owner 已停用時不啟用新 owner。

Pending approval 保存原 scope/hash/reply/expiry；不能自動延長或當新 approval。未知 attempt 保留 CP reconciliation，待交付原 payload/hash/receipt 一同移交，不能重造通知。遷移重跑用 migration key 去重。

### 12.4 Schedule 切換與 rollback

對單一 schedule 暫停舊觸發 → 記錄 timezone、next fire、last occurrence、misfire policy、已提交 occurrence keys → 匯入 Hermes → 驗 ID/version/hash → 舊 owner 持久 fenced → Hermes 啟用新 epoch。掃描切換期間 due instants，用相同 occurrence key 與明確 misfire policy 補齊。排程修改版本不改已發生 instant 的唯一性。未證明舊 scheduler 停止時，新端不觸發。

回滾前先 freeze 新 action，保留 CP 執行與結果對帳；只對相容 schema／已演練映像回退。新 Hermes Work 可由相容 Hermes 舊版續接則回退；不相容則修正前進，或還原備份並對照 Worker journal／provider receipt 重建缺口。不得把新 Work 轉回 CP legacy planner 或用舊 DB replay 副作用。

資料還原先核對 checkpoint 之後的外部效果、operation tombstones、outbox／delivery，不保證僅靠 DB snapshot 就消除重複。每 repo 可獨立 rollback；不要求跨 repo 同時回復一個共享 DB。

### 12.5 部署約束

未來實作部署依使用者全域政策：先 `ssh -o BatchMode=yes Tim@gnest 'sudo -n /usr/local/bin/deployment list'` 核對 exact project ID；不可猜其他 repo 的 allowlist 名稱。只上傳 repository `compose.prod.yml` 到該專案 staging，validate 成功且 required tests／CI immutable image published 後 deploy，再 status＋readiness／實際版本＋適用 E2E。失敗診斷或 gateway rollback 後驗證恢復狀態。

不得修改 root-owned production Compose、`.env`、gateway、`/etc/codex-deploy`、sudoers；不得 NAS build、直接 privileged Docker、任意 host mount 或 Worker 繞行。各 repo backup／還原遵守自己的既有 authority，不藉本版建立通用 root 管理平台。

## 13. 運作設定與容量驗證提案

以下數字是**初始測試 profile 建議**，不是使用者容量需求、既有設定或達標承諾。部署前以機器實測、資料保留需求和可用磁碟決定實際值，保存 versioned operation profile；未填值／未驗證不得宣稱達到可靠性或效能目標。生產 retention cleanup 在明確政策保存前保持停用。

| 設定 | 初始測試建議 | 生產選定／驗證方式 |
| --- | --- | --- |
| Worker heartbeat | 15 秒 | 網路抖動＋sleep/resume 實測；每 Worker profile |
| Offline threshold | 90 秒（6 次 heartbeat） | 只標離線／UNKNOWN，不釋放占用 |
| Observation freshness | resource 45 秒、service 90 秒 | 過期 hard requirement 不使用；時間偏移測試 |
| Capability verification TTL | 24 小時且 manifest/runtime/credential 變更立即失效 | 依 backend probe 成本與穩定性決定 |
| Hermes recovery scan | 15 秒；wait HTTP 最長 30 秒 | 重啟到找回 pending 工作量測；等待時不呼叫 LLM |
| Runner lease | 60 秒、每 20 秒續租 | pause/crash/雙 runner 測試；不能代表外部停止 |
| Queue deadline | 測試 30 分鐘 | 每 Task 必填／使用明示 profile；過期且未派工可確定失敗 |
| Execution timeout | coding/python 測試 30 分鐘；GPU 批次測試 2 小時 | 每 capability 可覆寫；超時走停止對帳 |
| Execution attempts | 有副作用預設 1；已驗 read-only 測試最多 2 | 必須符合 §5 stop/effect gate；非自動策略重試 |
| Transport backoff | 1、2、4…最高 60 秒＋jitter；連續 10 次後 attention | 保留 outbox，再由低頻恢復掃描／操作恢復，不丟訊息 |
| Events／已送 outbox | 測試 30 天 | 未 ack/未完成不能清；cursor 過期 snapshot 恢復 |
| Dedup tombstone | 測試 180 天 | 不得短於允許 producer replay horizon；更舊 replay 拒絕並要求對帳 |
| Artifact | 測試 30 天、總 quota 20 GiB、單檔 100 MiB | 按需求設定；80% 告警、95% 停新大檔工作，pin pending validation/delivery |
| 備份 | 測試每 24 小時一致 snapshot，migration 前另備份 | 包含 DB／必要 artifacts／mapping／receipt；secret 不混入一般 artifact |
| RPO | 測試目標 ≤24 小時 | 由備份週期及最新可還原 checkpoint 證明；外部效果另對帳 |
| RTO | 測試目標 ≤4 小時 | 空白替代環境還原、接回 Worker、恢復待交付後計時 |
| 目標並行負載 | 測試 3 Workers、總 3 active tasks、50 queued、5 Portal sessions | 不聲稱現有 NAS 能承受；記 CPU/RAM/I/O 與 scheduler latency |
| API latency | 上述負載下 metadata API p95 <1 秒（不含模型／下載／long poll） | 固定輸入與至少 15 分鐘量測，附分位數與錯誤率 |

Event storage 粗估：3 個 active Task 每 10 秒一個 progress，另 3 個 Worker 每 15 秒 heartbeat，共約 0.5 event/s；若全部持久化、每筆含索引估 2 KiB，約 84 MiB/day、30 天約 2.5 GiB，尚未含 logs／backup／artifacts。這是測試假設；heartbeat 可僅保留最新 observation，另保存狀態轉移，降低寫入。Artifact/log 通常占主要容量，必須另測。

壓測先固定 operation profile、source commits、DB/artifact 起始量，再測正常負載＋Worker 斷線＋CP restart＋outbox backlog。記錄 p50/p95、queue lag、recovery duration、磁碟增長與正確性；效能通過不能替代不變條件驗收。

## 14. 驗證計畫與需求追溯

所有案例證據分 `design / implemented_local / ci_verified / live_verified / provider_verified`。本文件僅 design。測試記錄有時間、各 repo commit/image/contract/profile、操作範圍、work/task/run/attempt/event IDs、artifact hash、criteria、receipt 與結果。不以 mock receipt 支持 provider_verified。

| ID | Contract／負向測試 | 真實驗收證據與本文章節 |
| --- | --- | --- |
| A01 | 簡單文字路由不強制 discovery | Hermes 直接回覆，無 CP Task；§3 |
| A02 | typed input、workspace、criteria、artifact hash | 真 Codex Worker 修改指定 repo，diff/test log 可讀，Hermes 驗收、原對話 receipt、Portal 一致；§4–§7、§11 |
| A03 | GPU/runtime/model hard match，忙碌回 CAPACITY | 真實 GPU 批次輸入／輸出數、資源觀測、等待無持續推理；§4、§5、§13 |
| A04 | accepted/ACL/revision 過濾；candidate/expired/revoked/conflict 排除 | 新 Hermes 對話自動 recall 與來源版本；§9 |
| A05 | insight version 去重、candidate→review→accepted | Radar 多來源 insight、Hub 人工接受、未來新對話引用；§9–§10 |
| A06 | event 重送/亂序/過期、publication 未完成 | 同 event 無重複 Work、狀態正確、事件不當批准；§6、§10 |
| A07 | key 同內容重送、不同內容 conflict、舊 attempt/fence 回報 | 僅一 logical Task，舊結果入稽核不覆蓋；§4–§6 |
| A08 | 失聯、timeout、cancel ack 無 children evidence | 真程序未停止保持 UNKNOWN/占用，停止及效果對帳後才重派；§5–§6 |
| A09 | 逐一注入 §6.3 crash window | Hermes/CP/Worker 各重啟，Task／result／delivery 不遺失、不重做效果；§3、§6 |
| A10 | provider 已接收但 ack 遺失、明確失敗 | 原 Task 不重跑，delivery 可恢復／UNKNOWN 可見，SENT 有真 receipt；§7 |
| A11 | 假能力、過期驗證、撤銷 credential、缺 workspace | 核准新 Worker 以同 contract 加入不改 Hermes core；不合格者不派工；§4、§6 |
| A12 | approval 內容／目標變更、錯 reply、重播、越權 | Telegram 有效批准沿用、CP 不重問，原生工具不被 CP outage 阻塞；§8 |
| A13 | missing/hash mismatch/expired／假 progress | 真檔可下載、異常阻止成功交付、不可量測顯示 null；§7、§11 |
| A14 | 各 dependency unavailable、projection stale | 實際 browser 操作與 API 對照，Office/Portal 不造健康或進度；§11 |
| A15 | reader-first migration、legacy routing、升降版與 mapping 完整性 | Hermes Goal/Skill/Schedule restart、occurrence 唯一、舊 loop 不接新版、Office 保留、還原演練；§12 |
| A16 | measured/estimated/unavailable、provider record overlap | 原始計量可追、無偽零／重複加總，coverage 正確；§11 |

### 14.1 R01–R15 修訂落點

| 審查 | 設計解法 | 核心驗收 |
| --- | --- | --- |
| R01 | §2–§3 Hermes durable runner；CP 只 Task 協調 | A09、A15 |
| R02 | §2、§12 Goal/Skill/Routine/legacy mapping | A15＋功能歸屬 |
| R03 | §1、§5 保留 enum，增加 certainty/control/occupancy | A08 |
| R04 | §4–§6 receipt、fence、inbox/outbox、crash matrix | A07、A09 |
| R05 | §3、§8 lifecycle owner 固定，原生工具不依賴 CP | A01、A12 |
| R06 | §8 內容綁定批准、原對話 correlation、沿用有效批准 | A12 |
| R07 | §4 capability all-of、verification、資格重檢 | A03、A11 |
| R08 | §9 canonical commands、候選／successor、ACL | A04、A05 |
| R09 | §9 local_only/cache_pointer/shared_candidate | A04、A14 |
| R10 | §10 三個獨立狀態、版本／撤回／重送 | A05、A06 |
| R11 | §5、§7 有界內部規劃、真實 progress | A02、A13 |
| R12 | §7 分離結果、artifact、驗收、delivery | A02、A10、A13 |
| R13 | §11 唯一 source、freshness、Portal authority | A14 |
| R14 | §11 用量單位、來源、coverage 與去重 | A16 |
| R15 | §12–§14 相容遷移、rollback、垂直流程先行 | A09、A15 |

### 14.2 實作完成門檻

- Contracts：versioned parsers、MCP schema、HTTP／Worker 權限、狀態轉移、hash/receipt/CAS、錯誤碼通過自動測試。
- Runtime：Hermes 實際載入 CP MCP 和 Memory Provider；原生 Goal/Skill/Schedule 與 Work 可 restart；各新 backend 必須個別具實測證據。
- Recovery：取消／timeout／斷線／結果補送／provider unknown／DB restore 負向案例通過，不以「服務 healthy」代替。
- Migration：legacy intake fencing、活動工作 mapping、occurrence 唯一、pending approvals／delivery 完整、回滾演練通過。
- UX：真實頁面操作與 authority API 一致；未知／失效／未量測可見。
- Operations：實際 profile 已記錄、備份可還原、各 repo 版本／gateway 狀態及應用驗證齊備，才可按證據層級宣告完成。

## 15. 待實作核對清單

以下是工程驗證工作，不是未決產品方向；不影響本次設計文件交付。

| 項目 | Owner | 關閉條件 |
| --- | --- | --- |
| Hermes 原生 durable hooks、Goal storage、Skill versioning、schedule callback | Hermes | 真 runtime persistence／restart／觸發測試；欠缺由 Hermes adapter 補足 |
| CP MCP server 載入與 capability schema | CP＋Hermes | 工具可被實際 Hermes 發現／調用，走同 Task domain service |
| Worker stop tree／fence／workspace alias／journal | 各 Worker backend | 各 OS/backend 故障注入通過；未通過不宣告該能力 VERIFIED |
| Hub withdrawal／successor/review 的實際 command schema | ContextHub＋Radar | 使用正式命令與版本，撤回／亂序不復活舊記憶 |
| Provider receipt／query／idempotency 能力 | Hermes delivery adapter | 真 provider 行為證據；不支援者用 UNKNOWN 分支 |
| 生產容量、retention、RPO/RTO、運作 profile | 平台 owner＋各服務實作 | 依 §13 實測並記錄實際選值；未設定前不啟用破壞式清理 |
