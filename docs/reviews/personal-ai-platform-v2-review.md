# Personal AI Platform v2 — 需求審查

日期：2026-09-15。狀態：技術審查完成；五項產品取捨已確認，修訂版已完成。

原文件：[Personal AI Platform v2 — System Requirements.md](</Users/tim_hong/Downloads/Personal AI Platform v2 — System Requirements.md>)。
修訂版：[System Requirements v2.1](../personal-ai-platform-v2-system-requirements-v2.1.md)。

## 結論

**建議修改後再作為實作依據。** 原文件適合作為責任分工宣言，但還不足以直接指導既有平台改版。主要問題是未區分 AI 決策與持久執行協調、未交代既有功能去留，以及缺少可驗證的跨系統完成與復原契約。

這份審查沒有把附件中的「移除」「部署」「寫入記憶」當成本次執行指令。本次僅讀取本機文件與相關原始碼、產出文件；沒有修改程式、部署或資料。

## 1. 審查方法與證據範圍

- Control Plane 原始碼基準：`79ba642896090e76301616afb4d3517416994874`；本機工作目錄已有 README 修改及 Grok/Muse 研究文件，均未修改。
- 對照 Control Plane 的 Task、Mission、Plan、Scheduler、既有設計，以及 ContextHub、AiHomePlatform、InformationRadar 本機文件。
- 本輪沒有執行 runtime／NAS／Telegram／provider 測試；「本機存在」不代表「正式環境可用」。其他 repository 的 README 宣告亦不當作本輪完成的實測。
- 過往架構紀錄只作查找線索；以下核心判斷已以本機文件或程式重新核對。

## 2. 原文件問題與本版修訂

下表嚴重度描述原文件的缺口；各項已反映至 v2.1，並非仍待使用者回答。

| ID | 原問題嚴重度 | 原章節 | 問題與影響 | 修訂方式 |
| --- | --- | --- | --- | --- |
| R01 | 阻擋架構定稿 | 3.1、4.1、13 | 把 orchestration 一概移出 CP，可能連持久等待、決策保存、復原也刪除。現有設計已把 AI 規劃交給 Hermes，不能直接認定 CP 有第二套 AI 規劃。 | 定義「策略決策」與「確定性執行協調」；依已確認方向移除 CP 對 AI 工作流程的主導；高階功能依 D02 移交 Hermes，CP 保留 Task 追蹤與歷史。 |
| R02 | 阻擋架構定稿 | 3.6、13、14 | Mission、Run、Plan、Goal、Routine、Skill、Virtual Office 未列入新版範圍；單一 Task 與 parent_task_id 無法自動取代所有語意。 | 建立保留／移交／退役矩陣，已確認目標／排程／技能移交 Hermes，CP 保留紀錄與 Virtual Office；補舊模型切換與歷史保留。 |
| R03 | 高 | 3.6、7.8 | 新 `COMPLETED`、`WAITING_INPUT`、`TIMEOUT` 與現有 Task enum 不一致；也漏掉停止未確認與未知執行。 | 保留相容性規則，分開執行結果、控制請求、停止證據與等待原因；未知時禁止盲目重派。 |
| R04 | 高 | 3.5–3.7、8.4、11 | 缺 request 去重、attempt 身分、版本檢查、重啟復原與事件補送。網路中斷可能重複執行或覆寫新結果。 | 增加穩定 operation key、attempt/revision、持久 inbox/outbox、對帳與過期結果隔離。 |
| R05 | 高 | 3.8、4.1、10 | CP 是執行安全邊界，但 Hermes 仍有自身工具與 Codex coordination；哪些操作可直連不明。 | 已確認 Hermes 原生工具照舊，CP 授權從簡、可留紀錄；同一執行只能有一個 lifecycle owner，不能直啟 Codex 又讓 CP 重派。 |
| R06 | 阻擋政策定稿 | 3.8 | `push → REQUIRE_APPROVAL` 沒說既有授權是否有效，可能變成每次重問；批准也未綁定實際內容。 | 已確認需批准，可由 Hermes 透過 Telegram 取得；補批准對象與回覆關聯，不另建 CP 複雜政策層。 |
| R07 | 高 | 3.3、3.4、7.4、8.2 | 將 Python、GPU、Qwen、Docker 混為能力；自報名稱不等於可執行，註冊也不等於獲授權。 | 區分 task capability、runtime/model、資源與 workspace；已核准且驗證可用才能派工。 |
| R08 | 高 | 5.2–5.7、8.3 | 新 memory schema、store/update 可能繞過現有 candidate/successor；global search 易被解讀為跨 namespace 無限制讀取；embedding 不應是第二份真相。 | 沿用 ContextHub canonical schema、server-derived identity/namespace、ACL 與可重建索引；已確認全部先候選、使用者審核後才共享；不新增 AI 自動採納。 |
| R09 | 高 | 5.7 | native memory 的 user identity、core preferences 也可能是跨 AI 的共享事實；以資料量大小劃界無法避免雙重權威。 | 依使用範圍與權威區分 local_only、cache_pointer、shared_candidate，明定衝突與離線行為。 |
| R10 | 高 | 6.4、6.5 | Radar 的 insight 發布與通知沒有獨立回執、版本、撤回、去重；重要事件可能在記憶尚未可讀前抵達 Hermes。 | 分開 insight 持久化、Hub publication、event delivery；通知含授權可讀的必要摘要與 publication 狀態。 |
| R11 | 高 | 7.1、7.6 | 禁止 Worker task decomposition 可能連 Codex 任務內部步驟都禁止；所有長任務都必須百分比也會誘發假進度。 | 允許任務範圍內局部規劃，禁止跨任務全域決策；不可量測百分比用 null 加階段與證據。 |
| R12 | 高 | 7.7、9、14 | Worker 成功未定義如何證明成果可讀、Hermes 驗收與原對話交付。 | 分開 execution、validation、artifact availability、delivery，建立真實檔案與訊息回執驗收。 |
| R13 | 中 | 3.2、3.11、12 | Registry 的設定與觀測值混合，缺資料新鮮度；Portal／infrastructure 與其他平台的 authority 關係未說明。 | 一個欄位指定一個來源，顯示 observed_at/stale/unknown；本需求不推定接管 AiHomePlatform 的部署、secret 或 backup 控制。 |
| R14 | 中 | 3.10 | Local 執行成本寫成 local，token、GPU、Codex 用量也可能拿不到；沒有單位與覆蓋率便會形成假的總成本。 | 區分 measured/estimated/unavailable，標示來源、時間、單位、幣別與重複計帳規則。 |
| R15 | 高 | 11、13、14 | 先移除舊路徑、最後才補 Portal，缺 compatibility、活動任務切換、回滾與負向驗收。 | 先盤點與協定，再建立真實垂直流程；新路徑通過後才切換，補故障與升降版驗收。 |

## 3. 使用者已確認的決策

以下決策來自本輪需求澄清，已納入修訂版。

| 決策 | 已確認內容 | 受影響部分 |
| --- | --- | --- |
| D01 已確認 | Hermes 是決策大腦；CP 回到 Dashboard、capability layer，避免重複功能。 | CP 不主導 AI 決策迴圈；Task 追蹤與派工仍屬能力層 |
| D02 已確認 | 目標／排程／技能交給 Hermes；CP 顯示執行紀錄，Virtual Office 保留為視覺化。 | 移交高階功能，舊模型安全結束／轉移後退役控制路徑，保存歷史 |
| D03 已確認 | 全部先存成候選，經使用者審核才供共享使用。 | 既有 candidate／successor 路徑；Radar recall 驗收須包含人工審核 |
| D04 已確認 | Hermes 原本能做的事照舊，CP 授權越簡單越好，可留執行紀錄。 | 不新增全面授權閘門或 policy engine |
| D05 已確認 | 需確認；可由 Hermes 透過 Telegram 取得 approval。 | approval 在 Hermes；CP 記錄，不重複詢問 |

五項決策均根據本輪使用者實際回覆確認，未採用未提交的預選答案。修訂版已移除待決分支。

## 4. 本機核對依據

| 證據 | 支持的判斷 |
| --- | --- |
| [Hermes v2 HLD](../hermes-control-brain-v2-hld.md) §1、§5–§8 | 現有文件已將唯一大腦設在 Hermes；CP 保存執行事實，排程定義在 Hermes |
| [PlanService](../../apps/control-plane/src/missions/plan-service.ts:22) | 接受與驗證 plan proposal、檢查 revision、交易保存；存在 PlanService 不能直接等同 CP 自行 AI 規劃 |
| [Task contracts](../../packages/contracts/src/index.ts:5) | 現有 Task type 與狀態列舉，需處理新版名稱相容性 |
| [Task cancellation](../../apps/control-plane/src/tasks/task-service.ts:222) | task 邏輯取消和 attempt occupancy／stop evidence 已分開，不能只顯示 CANCELLED 就宣稱程序停止 |
| [Task timeout](../../apps/control-plane/src/tasks/task-service.ts:280) | 現有 timeout 路徑會嘗試 requeue，需針對有副作用工作補證據與測試，不能宣稱未知執行已全面處理 |
| [個人代理能力 HLD](../personal-agent-capabilities-hld.md) 與 [實作狀態](../implementation-status.md) | Goal／Skill／Routine／Attention 有既有模型；本地與外部實測須分開 |
| [ContextHub AGENTS](</Users/tim_hong/Documents/code/ContextHub/AGENTS.md>)、[README](</Users/tim_hong/Documents/code/ContextHub/README.md>)、[ADR-006](</Users/tim_hong/Documents/code/ContextHub/docs/ADR-006-agent-memory-federation.md>) | 既有 MCP、候選與 successor、namespace、local memory 邊界；service source projection 有獨立政策，不能直接當 agent 自動採納能力 |
| [AiHomePlatform README](</Users/tim_hong/Documents/code/AiHomePlatform/README.md>) | 本機文件有退役與移交紀錄；不能僅憑名稱認定仍是 Personal AI 的 runtime authority |
| [InformationRadar README](</Users/tim_hong/Documents/ChatGPT/InformationRadar/README.md>) | 已有獨立來源、持久化與投遞流程；本次未驗證 Hub publication 與真實通知整合 |

## 5. 修訂產物的使用方式

v2.1 保留原本五元件分工，補上已確認的功能移交、簡化授權、候選記憶、相容性與真實驗收。本版對責任分工優先於舊 HLD，供下一步設計使用；不宣告功能已實作，也不授權直接刪資料或部署。

後續設計重點是 Hermes 接手目標／排程／技能與工作續接、CP 舊 decision loop 退役、活動任務與排程的安全切換，以及成果／交付驗收。工程參數如 heartbeat、容量與保留期由 Detailed Design 提出；不能以此掩蓋仍未驗證的背景續接。
