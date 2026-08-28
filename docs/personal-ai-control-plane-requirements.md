# Personal AI Control Plane — Requirement Definition

## 1. Vision

建立一套部署於家中 NAS 的 **Personal AI Control Plane**，作為個人所有 AI 工作、運算資源、Agent 能力與記憶的統一入口。

這個系統的核心目標不是單純提供聊天型 AI Assistant，而是提供一個具備高度自主能力的 **Personal AI Orchestrator**：

- 使用者只需要描述目標，而不是拆解工作流程。
- Orchestrator 負責理解目標、規劃、分解、排程、執行與驗證。
- 可以控制家中的多台 Mac、Windows、NAS 等主機完成工作。
- 可以調用 Cloud LLM、Codex、Local LLM 等不同 AI compute resource。
- 可以跨裝置執行長時間工作，並支援 checkpoint / resume。
- 可以集中存取來自不同 AI 系統的個人記憶。
- 可以在缺少能力時，主動提出新增 capability，並委派 Codex 開發。
- 最終目標為高度自主，只保留少數必要的 hard stop。

整體設計原則為：

> **Single Brain, Distributed Execution, Shared Memory, Dynamic Compute**

---

# 2. High-Level Architecture

```text
                        User
                         │
              ┌──────────┴──────────┐
              │                     │
          Telegram               Web UI
              │                     │
              └──────────┬──────────┘
                         ▼
              ┌────────────────────┐
              │ Personal AI       │
              │ Orchestrator      │
              │ on NAS            │
              └─────────┬──────────┘
                        │
        ┌───────────────┼─────────────────┐
        │               │                 │
        ▼               ▼                 ▼
   Task Engine     Memory Fabric    AI Compute Broker
        │               │                 │
        │               │        ┌────────┼─────────┐
        │               │        ▼        ▼         ▼
        │               │      Cloud    Codex    Local LLM
        │               │       LLM               LM Studio
        │               │                         oMLX
        │               │
        ▼               ▼
 Compute Mesh       External Memory
        │             Connectors
 ┌──────┼──────┐          │
 ▼      ▼      ▼          ├─ Personal AI tools
Mac   Win A   Win B        ├─ Work AI
                           ├─ ChatGPT
                           ├─ Codex
                           └─ Other AI systems
```

---

# 3. Core Architecture Principle

系統採：

## Single-Brain Architecture

主要 reasoning、planning 與 decision-making 集中於 NAS Orchestrator。

下轄主機不作為永久 autonomous agent，而主要作為：

> **Remote Execution Nodes**

Orchestrator 負責決定：

- 做什麼
- 怎麼做
- 用哪台主機
- 用哪個模型
- 執行順序
- 何時 retry
- 是否需要 approval

Worker 主要負責：

- 執行 command
- Browser automation
- Computer Use
- 執行 script
- 執行 local LLM inference
- 執行 Codex
- Docker / build / test
- 回傳 artifact / execution result

---

# 4. Orchestrator

NAS 上運行一個 Always-On Personal AI Orchestrator。

主要職責：

```text
Goal Understanding
↓
Planning
↓
Task Decomposition
↓
Resource Estimation
↓
Approval if required
↓
Compute / Worker Selection
↓
Execution
↓
Monitoring
↓
Recovery / Replan
↓
Verification
↓
Result
```

Orchestrator 是整套系統唯一主要決策中心。

---

# 5. Goal-Driven Execution

使用者主要提供 **Goal**，而非 workflow。

例如：

```text
幫我讓 Information Radar 支援新的來源。
```

Orchestrator 自行：

```text
Understand requirements
↓
Inspect current implementation
↓
Design change
↓
Create coding task
↓
Delegate to Codex
↓
Run tests
↓
Merge
↓
Deploy
↓
Verify
```

## Subgoal Policy

### Required Subgoal

完成原始 Goal 所必要的工作。

允許自動建立與執行。

### Exploratory Subgoal

不是完成 Goal 必要，但 AI 認為可能有額外價值的研究或改善。

預設：

```text
Discover
↓
Add recommendation / backlog
↓
Do NOT automatically consume significant resources
```

避免 scope creep 與無限制 token consumption。

---

# 6. Autonomous Operation

最終目標：

> AI 幾乎完全自主，只保留少數 Hard Stop。

Autonomy level 必須 configurable。

---

# 7. Proactive Behavior

Proactive behavior 必須可以由 Web UI 設定。

預設模式：

```text
Detect Issue
↓
Notify User
↓
Ask Approval to Investigate
↓
Investigate
↓
Report Diagnosis
↓
Ask Approval to Repair
↓
Repair
↓
Verify
```

未來可針對不同 domain 設定：

```text
Notify Only
Auto Investigate
Auto Repair
Fully Autonomous
```

---

# 8. Autonomy Policy Engine

建立統一 Policy Engine 管理：

- Autonomy Level
- Approval Threshold
- Hard Stop
- Capability Permission
- Resource Budget
- Token Budget
- Compute Budget
- Merge Policy
- Deployment Policy

Policy 必須可以透過 Web UI 修改。

---

# 9. Hard Stops

即使設定為最高 Autonomous Level，以下操作仍預設必須人工核准：

- Money movement
- Purchase
- Credential / security settings modification
- Privilege escalation
- Permanent destructive deletion
- Security boundary expansion
- 高風險 external communication pretending to be the user

其中：

> **Privilege Escalation 永遠不能由 AI 自主完成。**

---

# 10. Durable Task Engine

Task 不應依賴單一 LLM conversation context 存活。

系統必須支援 Persistent Task。

Task lifecycle 例如：

```text
PENDING
↓
ESTIMATING
↓
WAITING_APPROVAL
↓
RUNNING
↓
WAITING_RESOURCE
↓
WAITING_QUOTA
↓
CHECKPOINTED
↓
RESUMING
↓
VERIFYING
↓
COMPLETED
```

Task 可以跨：

- 小時
- 天
- Worker offline
- Codex quota reset
- Orchestrator restart

而繼續執行。

---

# 11. Quota-Aware Execution

Codex API 存在：

- 5-hour limit
- Weekly limit

因此 quota 必須成為 Scheduler 的 first-class resource。

當接近 quota 時：

```text
RUNNING
↓
QUOTA_NEAR_LIMIT
↓
CHECKPOINT
↓
WAITING_FOR_QUOTA
↓
Quota available again
↓
RESUME
```

不得因 quota reset 而重新執行整個工作。

---

# 12. Checkpoint / Resume

採用雙層策略。

## Primary

Resume existing Codex session。

## Fallback

Artifact-based checkpoint reconstruction。

Checkpoint 應包含：

```text
Goal
Current plan
Completed work
Current state
Next steps
Changed files
Decisions
Tests
Known issues
Artifacts
```

例如：

```text
TASK_STATE.md
```

因此即使原始 conversation 無法繼續，也能重新建立 execution context。

---

# 13. Lightweight Resource Estimation

可能消耗大量時間或 token 的工作，在開始前必須做 resource estimate。

估算至少包含：

- Estimated duration
- Estimated token usage
- Estimated quota impact
- Required machine
- Expected compute load
- Confidence level

例如：

```text
Task:
Build MCP integration

Estimated time:
2–4 hours

Estimated Codex usage:
80K–180K tokens

Quota impact:
May cross current 5-hour window

Confidence:
Medium
```

之後透過 Telegram：

```text
[Start]
[Cancel]
```

---

# 14. Estimation Must Be Lightweight

不得因為「估算」本身就進行大量 reasoning。

禁止：

```text
Read entire repository
↓
Perform full architecture analysis
↓
Generate full implementation plan
↓
Estimate task
```

應優先使用：

- Task type
- Repository size
- Number of files
- Language
- Historical execution data
- Known task patterns
- Basic metadata

進行 heuristic estimate。

---

# 15. Approval Threshold

Long-running task 的 approval threshold 可於 Web UI 設定。

評估至少四個維度：

```text
Time
Token
Compute Resource
Risk
```

例如：

```yaml
approval_policy:

  duration_over:
    30m

  estimated_tokens_over:
    50000

  quota_consumption_over:
    25%

  resource_occupation_over:
    2h
```

---

# 16. Dynamic Replanning

Orchestrator 可以在執行中自行修改 plan。

若 replan 仍處於原 approval scope / budget：

```text
Auto Replan
```

如果發生重大 scope expansion：

```text
Original:
15K tokens

New:
120K tokens
+ architecture refactor
```

則：

```text
Checkpoint
↓
Re-estimate
↓
Ask Approval
```

---

# 17. Compute Mesh

家中所有可用主機形成 Personal Compute Mesh。

初期包含：

```text
NAS
Mac
Windows Desktop A
Windows Desktop B
```

各 Worker 透過安全網路互通，例如 Tailscale。

Worker 不需要永久 autonomous reasoning。

主要提供 capability。

---

# 18. Dynamic Capability Discovery

Orchestrator 不應只靠 static configuration。

Worker 啟動後應主動 register：

```text
OS
CPU
RAM
GPU
Free Memory
Current Load
Available Software
Available Models
Docker
Browser
Computer Use
Shell
Filesystem
Codex
Build Tools
```

例如：

```text
windows-dev:

  online: true

  gpu:
    RTX-class GPU

  ram:
    64GB

  capabilities:
    - powershell
    - docker
    - browser
    - cua
    - codex
```

---

# 19. Wake-on-Demand

Orchestrator 可以喚醒 offline / sleeping worker。

例如：

```text
Task requires Windows

↓
Windows sleeping

↓
Wake-on-LAN

↓
Worker register

↓
Execute

↓
Idle timeout

↓
Sleep
```

可支援：

```yaml
wake_policy:
  on-demand

idle_sleep:
  30m
```

---

# 20. Computer Use

Computer Use 使用 Hybrid Model。

## Default

Isolated Session。

避免 AI 操作干擾正在工作的使用者。

## Explicit Shared Mode

只有使用者明確要求：

```text
操作我現在的畫面
```

才允許 AI 操作目前 desktop session。

---

# 21. AI Compute Broker

Orchestrator 需要統一管理所有 AI compute resource。

包含：

```text
Cloud LLM
Codex
LM Studio
oMLX
Future Local Models
```

AI Compute Broker 根據：

- Quality requirement
- Cost
- Latency
- Token usage
- Quota
- Available hardware
- Model capability
- Task type

選擇模型。

---

# 22. Local LLM Is a First-Class Compute Resource

Local LLM 不只是 Worker tool。

它是一種正式 AI compute resource。

例如：

```text
Mac
└─ oMLX
   ├─ Model A
   └─ Model B

Windows
└─ LM Studio
   ├─ Model C
   └─ Model D
```

Dynamic discovery 應包含：

```text
model
context_window
tokens_per_second
memory_usage
vision_support
tool_calling_support
coding_quality
current_load
```

---

# 23. Cost-Aware Model Routing

應優先考慮 Local LLM 處理：

- Long-running low-risk task
- Large-volume summarization
- Classification
- Log analysis
- Preliminary research
- Pre-processing

例如：

```text
1000 logs
↓
Local LLM classification
↓
Cloud LLM final reasoning
```

達到：

> Local-first when appropriate, cloud-quality when necessary.

---

# 24. Coding Architecture

Coding 工作原則上不由 Orchestrator 自己直接實作。

Orchestrator 將 Coding Delegation 給使用者已有的 Codex environment。

```text
User ──────────┐
               ▼
             Codex
               ▲
Orchestrator ──┘
```

同一台 coding computer 可以同時支援：

- Human vibe coding
- Orchestrator-triggered Codex coding

---

# 25. Isolated Coding Workspace

Orchestrator 不得直接操作使用者正在工作的 git workspace。

採用：

> **Isolated Git Worktree**

例如：

```text
Human:
feature-memory

AI:
agent/task-938
```

避免：

- file conflict
- branch conflict
- accidental overwrite
- human/AI race condition

---

# 26. Merge Policy

預設：

> CI pass → AI 可以自動 merge。

但 policy 必須 configurable。

可以設定：

```text
Manual merge
Low-risk auto merge
CI-pass auto merge
Fully autonomous
```

---

# 27. Self-Extending System

Orchestrator 可以發現自己缺少 capability。

例如：

```text
Need Synology Snapshot API
↓
Capability missing
↓
Generate development estimate
↓
Ask user approval
↓
Delegate to Codex
↓
Develop
↓
Test
↓
Deploy
↓
Register capability
↓
Use capability
```

Self-extension 開發工作永遠需要：

```text
Estimate
↓
User Approval
```

之後才開始 coding。

---

# 28. Universal Memory Fabric

所有 AI 系統共享一個 Logical Memory Layer。

不是單純：

```text
One Vector DB
```

而是：

> **Federated Memory Fabric**

---

# 29. Memory Architecture

```text
                  Memory Fabric
                       │
       ┌───────────────┼────────────────┐
       ▼               ▼                ▼
Conversation       Semantic         External
History            Memory           Memories
                                       │
                              ┌────────┼─────────┐
                              ▼        ▼         ▼
                           Work AI  ChatGPT   Others
```

---

# 30. Raw History + Structured Memory

同時保留：

## Raw Conversation History

作為：

- audit
- reconstruction
- source provenance

## Extracted Semantic Memory

用於 everyday retrieval。

例如：

```text
User preference
Project decision
Architecture decision
Task state
Known constraint
Long-term goal
```

---

# 31. Temporal / Versioned Memory

Memory 不直接覆蓋舊事實。

使用 versioned model。

例如：

```text
Communication:
Telegram

valid:
2026-01 → 2026-09
```

後來：

```text
Communication:
LINE

valid:
2026-09 →
```

保留歷史 truth。

---

# 32. Memory Schema

Memory 至少包含：

```text
fact
scope
source
confidence
valid_from
valid_to
created_at
updated_at
tags
```

---

# 33. Context-Aware Conflict Resolution

不同 memory 可以同時成立。

例如：

```text
Personal communication → Telegram
Work communication → Slack
Baseball communication → LINE
```

因此 memory conflict resolution 採：

> **Context-Aware Resolution**

而不是單純 last-write-wins。

---

# 34. Memory Lifecycle Management

Memory lifecycle：

```text
Active
↓
Cold
↓
Archived
```

系統根據：

- Age
- Frequency of use
- Relevance
- Confidence
- Type

管理 memory。

短期 context 例如：

```text
目前正在找某商品
```

可逐漸降低 relevance。

長期 preference：

```text
使用者偏好某種 interaction pattern
```

則可以長期維持。

---

# 35. Work AI Memory Sync

公司 AI 的 Memory 被視為：

> 使用者本人的 Personal Memory，scope = work。

因此要求：

```text
Work AI
↓
Scheduled Sync
↓
NAS Memory Fabric
```

資料可以直接 copy 回 NAS。

以：

```text
scope: work
source: work-ai
```

標記。

`work` 是 provenance / context tag，不是 Orchestrator access restriction。

Orchestrator 可以完整讀取。

---

# 36. External Memory Sync Priority

同步方式優先順序：

```text
1. Official API / MCP
2. Local exporter on Work PC
3. Browser Automation / Computer Use
```

避免將 GUI scraping 當主要 integration。

---

# 37. Memory Sync Direction

Work → Personal：

```text
Automatic scheduled sync
```

Personal → Work：

預設僅同步：

```text
work-shareable
```

namespace / memory。

因此：

```text
Personal Memory
     │
     ├─ private → never sync
     │
     └─ work-shareable → Work AI
```

---

# 38. Unified Identity

使用者不希望管理：

- API token
- Secret
- Refresh token
- SSH key
- Service credential

因此 UX 原則：

> **Authenticate Once to Orchestrator.**

---

# 39. Orchestrator Authentication

Orchestrator 使用：

> Passkey / WebAuthn

可透過：

- Phone Face ID
- Fingerprint
- Device PIN

完成認證。

使用者不需要輸入傳統 password。

---

# 40. Credential Broker

底層外部系統仍可能需要：

- OAuth token
- API key
- device credential

但這些由：

> **Credential Broker**

管理。

使用者平常不直接接觸。

例如：

```text
You
↓
Passkey
↓
Orchestrator
↓
Credential Broker
↓
GitHub / Google / Codex / Workers
```

---

# 41. Credential Storage Strategy

不要求所有 secret 都 physically 集中在 NAS。

可採 Hybrid。

例如：

```text
Server credential
→ NAS Vault

Corporate credential
→ Work PC local vault
```

Orchestrator 只知道：

```text
capability:
query_work_ai
```

而不一定取得真正 token。

---

# 42. Credential Expiry UX

若外部 OAuth 或 SSO 無法自動 refresh：

Telegram 通知：

```text
Google authorization expired.

[Re-authorize]
```

使用者點選後完成 Face ID / SSO。

不得要求使用者自行：

- 找 token
- copy token
- update config file
- restart service

---

# 43. User Interfaces

系統提供兩個主要 interface。

## Web UI

完整 management console。

負責：

- Orchestrator configuration
- Autonomy policy
- Worker management
- Capability registry
- Model routing
- Task history
- Memory management
- Resource usage
- Quota
- Approval policy
- Logs
- Credential status
- System health

---

# 44. Telegram Interface

Telegram 作為日常主要 Interaction Channel。

支援：

```text
Chat
Goal submission
Notification
Task status
Approval
Error notification
Reauthorization
```

例如：

```text
Task may consume:

2–4 hours
80K–180K tokens

[Start]
[Cancel]
```

---

# 45. Prompt Injection Protection

## Architecture Decision

Prompt Injection Protection：

> Accepted as architectural consideration, but implementation deferred.

不列入第一版主要 implementation scope。

---

# 46. Minimum Security Baseline

即使 Prompt Injection Protection 尚未完整實作，第一版仍需：

- Capability allowlist
- Hard-stop enforcement
- Credential isolation
- No direct credential exposure to LLM
- Isolated CUA session by default
- Privilege escalation approval

避免：

```text
LLM == Root
```

---

# 47. Prompt Injection Backlog

以下列入 backlog：

```text
External content trust classification
Data vs Instruction provenance
Prompt injection detection
Cross-source taint tracking
Action provenance verification
Untrusted-content-aware Policy Engine
Browser content sandboxing
Suspicious tool-chain detection
```

架構需預留：

```text
Orchestrator
↓
Policy Engine
↓
Capability Layer
```

未來可加入上述防護，而不需重構 execution architecture。

---

# 48. System Design Principles

整套系統遵循以下原則。

## 1. Goal over Workflow

使用者描述「要什麼」，AI 決定「怎麼做」。

## 2. Single Brain

主要 reasoning 集中在 Orchestrator。

## 3. Distributed Execution

利用多台實體電腦完成工作。

## 4. Durable Tasks

工作不依賴單次 conversation。

## 5. Quota-Aware

AI usage limit 是正式 resource。

## 6. Local-First When Appropriate

低成本長任務優先使用 Local LLM。

## 7. Cloud Quality When Needed

複雜 reasoning 可使用 Cloud LLM。

## 8. Specialized Coding

Coding 優先委派 Codex。

## 9. Human and AI Can Coexist

AI 使用 isolated worktree / desktop session，不影響使用者。

## 10. Shared Memory

不同 AI 系統不應形成 memory islands。

## 11. Single Authentication Experience

使用者不管理 credential。

## 12. Configurable Autonomy

從 notify-only 到 highly autonomous 都可設定。

## 13. Approval Based on Risk and Resource

Approval 不是每一步都問，而是在真正有成本或風險時才問。

## 14. Self-Extending

Orchestrator 可以透過 Codex 開發自己需要的新 capability。

---

# 49. Final Product Definition

最終產品不是：

```text
NAS Chatbot
```

也不是：

```text
Multi-Agent Playground
```

而是一套：

# Personal AI Control Plane

更具體可以定義為：

> 一個運行於個人 NAS 的 Always-On AI Orchestrator，以單一 AI Brain 管理使用者的 Personal Compute Mesh、Cloud AI、Local LLM、Codex、Memory 與 Digital Services。

它能接受高階 Goal，自動規劃、估算、分派、執行、checkpoint、resume、驗證與回報。

它能根據 cost、quota、quality 與 available compute 動態決定工作應該由 Cloud LLM、Local LLM、Codex 或 deterministic tool 完成。

它將 Mac、Windows 與 NAS 視為可動態發現能力的 execution nodes，而非彼此獨立的 AI islands。

它擁有一套跨 Personal AI 與 Work AI 的 Universal Federated Memory，使不同 AI 工具可以共享使用者的長期 context。

使用者只需要登入 Orchestrator 一次，Credential Broker 負責底層身份與 token lifecycle。

當系統缺少能力時，Orchestrator 可以提出 Self-Extension，經過 resource estimate 與使用者 approval 後，委派 Codex 開發、測試與部署新的 capability。

最終目標是建立一套：

> **Always-on、Highly Autonomous、Memory-Aware、Quota-Aware、Self-Extending Personal AI Infrastructure。**

---

# 50. Logical Component Map

```text
Personal AI Control Plane
│
├── Identity
│   ├── Passkey / WebAuthn
│   └── Credential Broker
│
├── Orchestrator
│   ├── Goal Planner
│   ├── Task Decomposer
│   ├── Replanner
│   ├── Autonomy Policy Engine
│   ├── Approval Engine
│   └── Proactive Engine
│
├── Durable Task Engine
│   ├── Persistent State
│   ├── Checkpoint
│   ├── Resume
│   ├── Failure Recovery
│   └── Long-Running Tasks
│
├── AI Compute Broker
│   ├── Cloud LLM
│   ├── Codex
│   ├── LM Studio
│   ├── oMLX
│   ├── Cost Router
│   └── Quota Manager
│
├── Compute Mesh
│   ├── NAS
│   ├── Mac Worker
│   ├── Windows Worker A
│   └── Windows Worker B
│
├── Worker Runtime
│   ├── Dynamic Capability Discovery
│   ├── Shell
│   ├── Filesystem
│   ├── Browser
│   ├── Computer Use
│   ├── Docker
│   ├── Wake-on-LAN
│   └── Local LLM
│
├── Coding Integration
│   ├── Codex Delegation
│   ├── Git Worktree
│   ├── CI
│   ├── Merge Policy
│   └── Self-Extension
│
├── Memory Fabric
│   ├── Conversation Store
│   ├── Semantic Memory
│   ├── Temporal Memory
│   ├── Memory Lifecycle
│   ├── Context Resolution
│   └── External Memory Sync
│
├── Interfaces
│   ├── Web Management UI
│   └── Telegram
│
└── Security
    ├── Hard Stops
    ├── Capability Allowlist
    ├── Credential Isolation
    └── Prompt Injection Protection [BACKLOG]
```
