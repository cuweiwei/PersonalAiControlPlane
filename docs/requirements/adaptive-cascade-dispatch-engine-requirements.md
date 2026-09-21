# Personal AI Control Plane — Adaptive Cascade Dispatch Engine Requirements

## 1. Purpose

The Personal AI Control Plane currently uses **Hermes Agent as the primary user interaction entry point**.

Users interact with Hermes mainly through:

- Telegram
- Hermes Web UI
- Potential future channels

Hermes is currently capable of handling requests through LLM reasoning, tools, workers, and external systems. However, using an LLM for every incoming request is inefficient because many requests are repetitive, deterministic, low-risk, and do not require advanced reasoning.

The goal of this project is to introduce an **Adaptive Cascade Dispatch Engine** in front of expensive LLM reasoning.

The system should progressively resolve requests using the cheapest and fastest available mechanism first.

The fundamental principle is:

> Use the least expensive mechanism capable of handling the request safely and correctly.

The system should also learn from repeated Hermes behavior and gradually convert frequently repeated LLM workflows into deterministic or semantic dispatch rules.

Over time, the system should become:

- Faster
- Cheaper
- More deterministic
- Less dependent on LLM inference
- Self-optimizing based on actual usage

---

# 2. High-Level Goal

The desired execution model is:

```text
User
 │
 ▼
Hermes
Telegram / Web UI
 │
 ▼
Personal AI Control Plane
 │
 ▼
Cascade Dispatch Engine
 │
 ├─ Tier 0: Deterministic Rules
 │
 ├─ Tier 1: Lightweight Semantic Router
 │
 ├─ Tier 2: Optional Future Router / Small Model
 │
 └─ Tier 3: Hermes LLM
 │
 ▼
Worker / Tool / Service
 │
 ▼
Response
 │
 ▼
Hermes
 │
 ▼
User
```

Hermes remains the main user-facing conversational interface.

However:

> Hermes LLM reasoning MUST NOT be invoked automatically for every request.

The Cascade Dispatch Engine should attempt to resolve requests before Hermes LLM reasoning is used.

---

# 3. Design Principles

The system SHALL follow these principles.

## 3.1 Cheap First

Processing order should generally follow:

```text
Deterministic logic
↓
Lightweight semantic classification
↓
Optional stronger router
↓
Hermes reasoning
↓
Expensive cloud / specialized models
```

A more expensive tier should only be used when cheaper tiers cannot produce a sufficiently reliable decision.

---

## 3.2 Precision Over Coverage

The router does NOT need to handle every request.

The preferred behavior is:

```text
Unsure
→ Abstain
→ Send to Hermes
```

rather than:

```text
Unsure
→ Guess
→ Wrong dispatch
```

The primary optimization goal for automated dispatch is:

```text
Dispatch Precision >> Dispatch Coverage
```

For example, a router that safely dispatches 60% of requests at very high precision is preferable to one that dispatches 90% with a materially higher error rate.

---

## 3.3 Model Independence

The Cascade Dispatch Engine MUST NOT be tied to a specific embedding or classification model.

The router model must be replaceable without redesigning:

- Dispatch rules
- Cascade logic
- Worker registry
- Risk policies
- Hermes integration
- Approval logic

The architecture should support implementations such as:

```text
SemanticRouterProvider

├─ BgeSmallZhProvider
├─ MiniLMProvider
├─ GteProvider
├─ RemoteEmbeddingProvider
├─ FutureLocalModelProvider
└─ ExternalRouterProvider
```

The upper layers should interact through a stable abstraction rather than model-specific APIs.

---

## 3.4 Safe Fallback

Any uncertain condition MUST be allowed to fall back to Hermes.

Fallback is considered expected system behavior, not a failure.

---

## 3.5 Self-Optimization

Hermes may initially solve repeated requests through reasoning.

When the system observes that similar requests repeatedly result in the same deterministic action or workflow, the system should be capable of learning a reusable dispatch rule.

Conceptually:

```text
LLM reasoning
      ↓
Repeated behavior
      ↓
Candidate Rule
      ↓
Shadow Validation
      ↓
Active Rule
      ↓
Future execution without LLM
```

This behavior can be considered a form of:

> Task Compilation

Hermes acts as the interpreter for unknown tasks.

Repeated and stable tasks can eventually be compiled into deterministic or semantic workflows.

---

# 4. Scope

The project includes:

1. Cascade routing
2. Deterministic rule execution
3. Semantic dispatch
4. Router model abstraction
5. Hermes fallback
6. Worker dispatch
7. Rule lifecycle management
8. Rule learning from Hermes execution history
9. Shadow validation
10. Rule promotion
11. Rule degradation and disabling
12. Risk-aware dispatch
13. Telemetry and evaluation
14. Resource-aware local execution
15. Telegram integration
16. Hermes Web integration
17. Future support for additional ingress channels

---

# 5. Non-Goals

The first version does NOT need to:

- Replace Hermes as the primary conversational interface
- Replace Hermes as the advanced reasoning agent
- Fully understand arbitrary natural-language requests
- Automatically dispatch every user request
- Support every language
- Run a large LLM on the NAS
- Require GTE, BGE-M3, Qwen, or another heavyweight router
- Automatically execute destructive operations
- Allow Hermes to directly modify production router source code
- Optimize for multi-user enterprise-scale throughput

The system is primarily designed for a personal AI environment with low concurrent request volume.

---

# 6. Current Environment Constraints

## 6.1 NAS Resource Constraints

The Control Plane runs primarily in a resource-constrained NAS environment.

Memory is currently limited.

Therefore:

- Router memory usage should be minimized.
- Large embedding models should not be required.
- PyTorch-heavy deployments should preferably be avoided for the first version.
- Lightweight inference runtimes should be preferred.
- Router models should not consume hundreds of MB of additional resident memory unless explicitly enabled later.

Initial target:

```text
Tiny local semantic model
approximately 15–30 MB quantized model weights
```

A candidate first implementation may use:

```text
bge-small-zh-v1.5
quantized GGUF
```

However, this is an implementation candidate and MUST NOT become an architectural dependency.

---

## 6.2 CPU-Only Operation

The NAS should be assumed to have:

- CPU inference
- No dedicated GPU requirement
- Low request concurrency
- Mostly short input messages

The first semantic router should therefore be optimized for:

- Short text
- Single-message classification
- Low-QPS operation
- CPU inference

---

# 7. Input Characteristics

User requests are expected to contain:

- Traditional Chinese
- English
- Chinese-English mixed sentences
- Technical product names
- Service names
- Commands
- Informal natural language

Examples:

```text
ContextHub status
```

```text
幫我看 ContextHub
```

```text
ContextHub 還活著嗎
```

```text
幫我 check ContextHub status
```

```text
InformationRadar 今天有什麼重要消息
```

```text
restart InformationRadar
```

```text
幫我看看 ContextHub 最近為什麼一直 restart
```

The first lightweight model does NOT need to fully support English.

English-heavy or semantically complex requests may directly fall back to Hermes.

---

# 8. Cascade Architecture Requirements

The cascade should conceptually contain the following tiers.

## Tier 0 — Deterministic Router

Tier 0 should use very low-cost mechanisms such as:

- Exact match
- Command aliases
- Regex
- Known entities
- Known service names
- Keyword patterns
- Parameter extraction
- Simple language heuristics

Example:

```text
ContextHub status
```

may map directly to:

```text
intent = service.health_check
entity = ContextHub
```

without using an AI model.

---

# 9. Tier 1 — Lightweight Semantic Router

If Tier 0 cannot confidently classify the request, the system may use a lightweight local semantic model.

Initial target:

```text
small Chinese-oriented embedding model
CPU only
very small memory footprint
```

The initial model does not need to support all languages.

For example:

```text
幫我 check ContextHub status
```

may still be classified because the sentence structure is primarily Chinese and the English terms are known technical entities.

A longer English request such as:

```text
Figure out whether ContextHub keeps restarting because of memory pressure or a deployment regression.
```

may be skipped by the lightweight router and sent directly to Hermes.

---

# 10. Future Cascade Tiers

The architecture SHALL support inserting additional router tiers later.

For example:

```text
Tier 0
Deterministic Rule
      ↓
Tier 1
Tiny local router
      ↓
Tier 2
Multilingual router
      ↓
Tier 3
Small reasoning model
      ↓
Tier 4
Hermes
```

Possible future models may include:

- multilingual-e5
- GTE multilingual
- BGE-M3
- Local Qwen
- Remote embedding service
- Specialized fine-tuned classifier
- External decision engine

Adding or replacing a tier should not require changes to rule definitions.

---

# 11. Router Provider Interface

The Control Plane should define a generic semantic router interface.

Conceptually:

```text
match(request)
```

Input:

```json
{
  "text": "幫我看 ContextHub status",
  "context": {},
  "candidate_intents": []
}
```

Output should conceptually contain:

```json
{
  "intent": "service.health_check",
  "confidence": 0.997,
  "abstain": false,
  "alternatives": []
}
```

The exact schema can be determined during Detailed Design.

The key requirement is:

> Cascade Engine must consume a normalized routing decision instead of model-specific scores.

---

# 12. Model Score Calibration

Raw model similarity scores MUST NOT be treated as universal confidence values.

For example:

```text
BGE cosine similarity = 0.87
```

and:

```text
GTE cosine similarity = 0.75
```

cannot be directly compared.

Therefore the system should include a calibration layer:

```text
Model
  ↓
Router Provider
  ↓
Calibration
  ↓
Normalized confidence / abstain
  ↓
Dispatch Policy
```

Model-specific thresholds should remain hidden inside the provider/calibration implementation.

Dispatch rules MUST NOT contain fields such as:

```text
bge_threshold = 0.87
```

Instead, rules should express model-independent requirements such as:

```text
required_precision = HIGH
```

or equivalent policy semantics.

The exact confidence representation should be determined during design.

---

# 13. Dispatch Rule Requirements

Dispatch rules MUST support more than exact matching.

Possible match mechanisms include:

```text
exact
regex
keyword
entity
alias
semantic
parameterized semantic rule
```

Example rule:

```yaml
id: service-health-check

intent: service.health_check

examples:
  - "ContextHub status"
  - "ContextHub 還活著嗎"
  - "看一下 ContextHub"
  - "ContextHub 正常嗎"
  - "check ContextHub health"

action:
  worker: devops-worker
  operation: health_check

risk:
  level: read_only
```

The exact persisted schema should be defined during Detailed Design.

---

# 14. Rule Registry

The system should provide a centralized Rule Registry.

Rules should have lifecycle states such as:

```text
Candidate
Shadow
Active
Disabled
Archived
```

Suggested lifecycle:

```text
Unknown task
     ↓
Hermes handles request
     ↓
Repeated pattern detected
     ↓
Candidate
     ↓
Shadow
     ↓
Verified
     ↓
Active
     ↓
Performance degradation
     ↓
Shadow / Disabled
```

---

# 15. Self-Learning Rule Generation

A major system capability is automatically discovering repeatable tasks.

The system should observe Hermes executions and detect patterns such as:

```text
similar user requests
+
same resolved intent
+
same worker/tool
+
same execution workflow
+
successful outcomes
```

Example:

User asks:

```text
InformationRadar 今天有什麼重要消息？
```

Later:

```text
今天 Radar 有什麼？
```

Later:

```text
InformationRadar today
```

If Hermes repeatedly resolves these requests to:

```text
InformationRadar.get_digest(today)
```

the system may identify a repeatable task.

---

# 16. Rule Candidate Generation

When a repeated pattern reaches sufficient evidence, the system may generate a Candidate Rule.

Candidate generation may be performed by:

- Hermes
- A local model
- A dedicated Rule Learner
- A combination of statistics and AI

Candidate rule generation should NOT happen for every request.

Cheap statistical detection should occur first.

For example:

```text
same action signature count >= threshold
```

Only when a pattern is sufficiently repetitive should an AI model be asked to generalize the pattern into a rule.

---

# 17. Hermes Execution Metadata

When Hermes already handles a request through an LLM, the system should capture structured metadata about the execution where feasible.

Example:

```json
{
  "intent": "information_radar.daily_digest",
  "repeatable": true,
  "deterministic": true,
  "safe_to_dispatch": true,
  "action_signature": "information_radar.digest(period)"
}
```

This metadata should preferably be generated as part of the existing Hermes processing flow rather than requiring an additional expensive LLM request solely for learning purposes.

---

# 18. Shadow Mode

Candidate Rules MUST support Shadow Mode.

In Shadow Mode:

```text
Incoming Request
       │
       ├── Candidate Rule predicts action
       │
       └── Hermes continues normal execution
```

The system compares:

```text
Candidate prediction
vs.
Hermes actual decision
```

Example:

```text
Candidate:
InformationRadar.get_digest(today)

Hermes:
InformationRadar.get_digest(today)

Result:
MATCH
```

No user-visible behavior should change during shadow evaluation.

---

# 19. Rule Promotion

Rules should only become Active after sufficient evidence.

Promotion criteria may consider:

- Number of observations
- Prediction accuracy
- Consistency of final action
- User corrections
- Execution success
- Risk level
- Confidence stability

Exact thresholds should be configurable.

Example concept:

```text
observations >= N
AND
shadow_accuracy >= required_accuracy
AND
user_correction_rate <= threshold
AND
risk_policy_allows_auto_promotion
```

---

# 20. Automatic Rule Degradation

Rules MUST NOT remain active forever merely because they once worked.

The system should continuously evaluate active rules.

If an active rule shows:

- Increased fallback rate
- Increased user correction
- Worker failures
- Semantic ambiguity
- Intent drift
- Changed system behavior

the system should support:

```text
Active
 ↓
Shadow
 ↓
Disabled
```

This is analogous to deoptimization in a runtime/JIT system.

---

# 21. Compiled Workflow Support

The system should eventually support more than single-action dispatch rules.

Repeated multi-step Hermes behaviors may become reusable workflows.

Example repeated request:

```text
如果 ContextHub 掛掉就重啟它
```

Hermes may repeatedly perform:

```text
health_check
↓
if unhealthy
↓
restart
↓
health_check
```

This may eventually become:

```yaml
workflow: contexthub-auto-recovery

steps:
  - health_check
  - condition:
      unhealthy:
        - restart
  - health_check
```

The first implementation may focus on single-action rules, but the architecture should not prevent future compiled workflows.

---

# 22. Worker Registry Integration

Dispatch Rules should reference logical workers rather than hard-coded implementation details.

Example:

```text
intent
   ↓
logical worker
   ↓
Worker Registry
   ↓
actual endpoint/runtime
```

Example logical workers:

```text
devops-worker
coding-worker
research-worker
information-radar
memory-worker
calendar-worker
```

The Worker Registry should allow workers to change location or implementation without requiring rule modification.

---

# 23. Risk Classification

Each action should have an associated risk classification.

At minimum, support concepts equivalent to:

### Read-Only

Examples:

- Query status
- Read logs
- Search
- Retrieve digest
- Retrieve memory
- Read calendar

These are the best initial targets for automated semantic dispatch.

---

### Reversible Write

Examples:

- Restart service
- Update noncritical configuration
- Retry failed task

These should use stricter policy.

---

### Destructive / External Side Effect

Examples:

- Delete data
- Force push
- Send external email
- Modify production infrastructure
- Execute irreversible operations

These MUST NOT be automatically executed merely because a semantic router classified the intent.

They should require:

- Hermes reasoning
- Explicit approval
- Existing approval policy
- Or other strong safeguards

---

# 24. MVP Safety Scope

The first production version of semantic dispatch SHOULD support only low-risk/read-only requests.

Examples:

```text
service.status
service.health_check
service.logs
information_radar.digest
search
memory.query
schedule.query
```

Actions such as:

```text
restart
deploy
delete
send
modify
```

may still be recognized, but should fall back to Hermes or require approval.

---

# 25. Language Handling

The first router may focus only on Chinese-dominant requests.

The architecture should include a low-cost language heuristic before semantic routing.

However, the heuristic should understand that technical English tokens do not necessarily indicate an English request.

Known terms may include:

```text
ContextHub
Hermes
Docker
Worker
API
NAS
GitHub
status
restart
deploy
container
```

Example:

```text
幫我 restart ContextHub container
```

should not necessarily be considered English-heavy.

The exact language detection algorithm is left to Detailed Design.

---

# 26. Model Upgrade Strategy

The first router should prioritize minimal resource usage.

Initial candidate:

```text
BGE-small-zh-v1.5
quantized
CPU inference
```

This is NOT a permanent architectural requirement.

A future replacement may use:

```text
multilingual-e5
GTE
BGE-M3
specialized fine-tuned model
remote inference
desktop inference
cloud inference
```

Changing models must only require replacement/configuration of the Router Provider and calibration profile.

---

# 27. External Router Support

The architecture should support moving inference off the NAS.

Possible future topology:

```text
NAS
 │
 │ routing request
 ▼
Desktop / Mac / Oracle / Worker
 │
 ▼
Stronger Router
```

Therefore Router Provider implementations should support both:

```text
local runtime
```

and:

```text
remote endpoint
```

without changing Cascade Engine logic.

---

# 28. Hermes Integration

Hermes remains the primary user-facing interaction layer.

Integration should support:

```text
Telegram
Web UI
Future channels
```

All ingress paths should ideally use the same Cascade Engine.

Avoid separate routing logic such as:

```text
Telegram Router A
Web Router B
```

Instead:

```text
Telegram Adapter ─┐
Web Adapter ──────┼─→ Cascade Engine
Future Channel ───┘
```

This ensures consistent routing behavior.

---

# 29. Pre-LLM Dispatch

A critical requirement is:

> If a request is successfully handled by the Cascade Engine, Hermes LLM MUST NOT be invoked unnecessarily.

For Gateway-compatible ingress, the system may intercept the message before normal Hermes agent dispatch.

Conceptually:

```text
Hermes Gateway
      ↓
Cascade Engine
      ↓
Handled?
 │
 ├─ Yes → execute + respond
 │
 └─ No  → Hermes Agent
```

The exact integration mechanism should be determined by HLD and Detailed Design based on current Hermes extension capabilities.

---

# 30. Response Path

Even when Hermes LLM is bypassed, the response should still return through the user's original interaction channel.

Example:

```text
Telegram
   ↓
Cascade
   ↓
InformationRadar
   ↓
Result
   ↓
Telegram
```

From the user's perspective, Hermes remains the interface.

The internal execution path should be transparent unless diagnostics are explicitly requested.

---

# 31. Observability

Every routing decision should generate telemetry.

At minimum capture:

```text
timestamp
request ID
source channel
language classification
matched tier
intent
router provider
router model/version
confidence
abstain
selected worker
risk level
dispatch/fallback
execution success
latency
user correction
```

Sensitive raw user content should be handled according to existing privacy and memory policies.

---

# 32. Key Metrics

The system should expose metrics such as:

```text
Tier 0 hit rate
Tier 1 hit rate
Hermes fallback rate

Dispatch precision
Dispatch coverage

False dispatch rate
Abstain rate

Average routing latency

LLM calls avoided
Estimated LLM cost avoided

Rule candidate count
Shadow rule accuracy
Rule promotion count
Rule degradation count

Per-intent accuracy
Per-router-provider accuracy
```

The most important router quality metric is:

```text
Dispatch Precision
```

not simply dispatch volume.

---

# 33. Historical Replay

The architecture should support replaying historical requests against a new router model.

Example:

```text
Existing historical dataset
       ↓
New Router Provider
       ↓
Offline evaluation
       ↓
Calibration
       ↓
Shadow mode
       ↓
Production
```

This is required to safely upgrade:

```text
BGE-small
→ GTE
```

or any future model.

---

# 34. Router Calibration Dataset

The system should gradually accumulate a dataset containing information similar to:

```json
{
  "request": "ContextHub 還活著嗎",
  "expected_intent": "service.health_check",
  "actual_worker": "devops-worker",
  "router_prediction": "service.health_check",
  "confidence": 0.99,
  "correct": true,
  "user_corrected": false
}
```

This dataset may later be used for:

- Calibration
- Benchmarking
- Threshold optimization
- Router comparison
- Fine-tuning
- Specialized tiny classifier training

---

# 35. Future Specialized Router

The architecture should allow the eventual replacement of a general embedding model with a domain-specific tiny classifier.

For example, after enough usage data exists:

```text
30–50 Personal AI intents
+
thousands of labeled requests
```

it may become more efficient to train a very small classifier specifically for this environment.

This specialized router may potentially outperform a larger general-purpose embedding model for the user's specific workload.

The architecture must not prevent this evolution.

---

# 36. Rule Storage

Rules should be stored as data rather than executable source code.

Acceptable implementation options may include:

- YAML
- JSON
- SQLite
- Database
- ContextHub-backed storage

Hermes SHOULD NOT directly modify production Python/router source code in order to create learned rules.

Instead Hermes should use controlled operations such as:

```text
create_rule()
update_rule()
disable_rule()
propose_rule()
```

---

# 37. Rule Auditability

Every learned rule should preserve:

```text
creator
creation timestamp
origin
training examples / evidence
promotion history
version history
risk level
performance statistics
last evaluation time
```

Automatically learned behavior must be explainable and reversible.

---

# 38. Configuration

The system should support configuring the active router independently.

Example conceptual configuration:

```yaml
semantic_router:
  provider: bge-small-zh

providers:

  bge-small-zh:
    runtime: local
    model: bge-small-zh-v1.5-q4

  gte:
    runtime: remote
    endpoint: http://router-worker:8080

  custom:
    runtime: remote
```

The final configuration format should be defined during Detailed Design.

---

# 39. Failure Handling

Failure of any routing layer must not prevent the request from reaching Hermes.

Examples:

```text
Router process unavailable
→ Hermes
```

```text
Model failed to load
→ Hermes
```

```text
Timeout
→ Hermes
```

```text
Unknown intent
→ Hermes
```

```text
Confidence insufficient
→ Hermes
```

The Cascade Engine should fail open toward Hermes, except where doing so would violate a security or approval policy.

---

# 40. Performance Goals

Exact numbers should be validated during implementation, but the system should optimize for:

### Tier 0

Near-zero computational overhead.

### Tier 1

Suitable for CPU-only NAS inference.

Expected workload:

```text
single user
low concurrency
short message
small model
```

The system should avoid keeping heavyweight inference frameworks resident solely for semantic routing if a lighter runtime is available.

---

# 41. Resource-Aware Router Loading

Because NAS memory is constrained, the design should consider:

- Minimal inference runtime
- Quantized model
- Optional lazy loading
- Optional process isolation
- Optional unloading
- Remote inference fallback

The Detailed Design should analyze trade-offs between:

```text
always resident router
vs.
lazy-loaded router
vs.
shared inference process
vs.
remote inference
```

---

# 42. Privacy

Local routing should be preferred when possible.

Simple request classification should not require sending user messages to external services.

When a router is remote or cloud-based, the system should make that routing policy explicit.

The architecture should support different data handling rules for:

```text
local inference
trusted private worker
external API
```

---

# 43. Example Execution Flows

## Example A — Exact Rule

User:

```text
ContextHub status
```

Execution:

```text
Hermes Gateway
↓
Tier 0 Rule
↓
service.health_check
↓
DevOps Worker
↓
Response
```

LLM usage:

```text
None
```

---

## Example B — Semantic Match

User:

```text
ContextHub 還活著嗎？
```

Execution:

```text
Tier 0
MISS

↓

Tiny Semantic Router

service.health_check
high confidence

↓

DevOps Worker

↓

Response
```

Hermes LLM usage:

```text
None
```

---

## Example C — Mixed Language but Simple

User:

```text
幫我 check ContextHub status
```

Possible execution:

```text
Language heuristic
Chinese-dominant + known technical vocabulary

↓

Tiny Semantic Router

↓

service.health_check
```

---

## Example D — English / Complex

User:

```text
Figure out why ContextHub keeps restarting after the latest deployment.
```

Execution:

```text
Tiny router
ABSTAIN

↓

Hermes
```

---

## Example E — Complex Reasoning

User:

```text
我覺得 Hermes、ContextHub、Bot、Worker 的架構有點亂，
重新分析一下整個 architecture 應該怎麼設計。
```

Execution:

```text
Rule
MISS

Semantic Router
insufficient confidence / complex intent

↓

Hermes
```

---

# 44. Self-Learning Example

Initial requests:

```text
InformationRadar 今天有什麼重要消息？
```

```text
今天 Radar 有什麼？
```

```text
InformationRadar today
```

Hermes repeatedly resolves:

```text
information_radar.digest(today)
```

System detects:

```text
repeated intent
same action signature
successful result
```

Creates:

```text
Candidate Rule
```

Then:

```text
Candidate
↓
Shadow
↓
Compare with Hermes
↓
Sufficient accuracy
↓
Active
```

Future request:

```text
今天 Radar？
```

Execution:

```text
Semantic Rule
↓
InformationRadar
↓
response
```

LLM usage:

```text
None
```

---

# 45. Conceptual Component Model

The HLD should consider at least the following logical components:

```text
Personal AI Control Plane

├── Ingress Adapters
│   ├── Hermes Telegram Adapter
│   ├── Hermes Web Adapter
│   └── Future Adapters
│
├── Cascade Engine
│   ├── Tier Controller
│   ├── Deterministic Router
│   ├── Semantic Router
│   ├── Fallback Controller
│   └── Dispatch Policy
│
├── Router Provider Layer
│   ├── Local Provider
│   ├── Remote Provider
│   └── Future Providers
│
├── Calibration Engine
│
├── Rule Registry
│
├── Rule Learner
│
├── Rule Evaluator
│
├── Shadow Evaluation Engine
│
├── Risk / Approval Engine
│
├── Worker Registry
│
├── Dispatcher
│
├── Telemetry / Metrics
│
├── ContextHub Integration
│
└── Hermes Integration
```

This component model is conceptual and may be refined by Astra during HLD.

---

# 46. Separation of Responsibilities

## Hermes

Responsibilities:

```text
Conversation interface
Complex reasoning
Novel tasks
Ambiguous tasks
High-level planning
Fallback processing
Potential rule candidate generation
```

Hermes should NOT be responsible for every routing decision.

---

## Personal AI Control Plane

Responsibilities:

```text
Routing
Dispatch
Policy
Worker discovery
Rule management
Risk control
Learning
Evaluation
Telemetry
```

---

## ContextHub

Potential responsibilities:

```text
Long-term contextual memory
Task history
Execution history
Potential storage of learning metadata
```

The exact storage responsibility should be determined by HLD.

---

## Worker

Responsibilities:

```text
Perform specialized actions
Expose machine-readable capabilities
Return structured execution results
```

Workers should not independently implement global routing policy.

---

# 47. Acceptance Criteria — MVP

The MVP will be considered successful when:

1. Hermes remains usable through existing Telegram interaction.

2. At least one class of requests can be handled without invoking Hermes LLM.

3. Tier 0 deterministic rules work.

4. A lightweight semantic router can be enabled or disabled through configuration.

5. The semantic router is abstracted behind a provider interface.

6. Router failure safely falls back to Hermes.

7. Only selected low-risk/read-only intents are automatically dispatched.

8. Every dispatch decision produces telemetry.

9. The system records enough data to evaluate:
   - precision
   - coverage
   - fallback rate

10. Replacing the router model does not require rewriting dispatch rules.

11. At least one Candidate → Shadow → Active rule lifecycle can be demonstrated.

12. A rule can be manually disabled.

13. A degraded rule can return to Shadow or Disabled state.

---

# 48. Future Acceptance Criteria

Future versions should demonstrate:

```text
Automatic pattern detection
Automatic candidate generation
Automatic shadow evaluation
Automatic low-risk promotion
Automatic degradation
Compiled multi-step workflows
Multiple semantic router tiers
Historical model replay
Automatic calibration
Specialized router training
```

---

# 49. Questions Astra Should Resolve in HLD

Astra should explicitly evaluate and propose answers for:

1. Where should Cascade Engine physically run?

2. How should Hermes Telegram traffic be intercepted before LLM execution?

3. How should Hermes Web UI use the same routing path?

4. Should Cascade Engine live inside PersonalAiControlPlane or as a separate service?

5. What protocol should Router Providers use?

6. What inference runtime is most appropriate for a very small local model on the NAS?

7. Should the lightweight router remain resident or load on demand?

8. How should router calibration be implemented?

9. How should semantic examples and embeddings be persisted?

10. How should Rule Registry be stored?

11. Which data belongs in ContextHub versus Control Plane storage?

12. How should Rule Learner identify repeated workflows?

13. How should Hermes expose structured execution metadata to the learner?

14. How should shadow decisions be compared with actual Hermes decisions?

15. How should risk classification integrate with the existing approval mechanism?

16. How should model upgrades be tested using historical replay?

17. How should versioning and rollback work for learned rules?

18. How should routing decisions be traced end-to-end?

19. How should model memory and CPU usage be monitored?

20. How should remote router execution be supported later without changing Cascade Engine?

---

# 50. Detailed Design Expectations

The Detailed Design should include at minimum:

```text
Component interfaces
REST / IPC APIs
Request / response schemas
Rule schema
Worker capability schema
Router Provider interface
Calibration interface
Risk policy model
Rule lifecycle state machine
Rule learning workflow
Shadow evaluation workflow
Dispatch sequence diagrams
Hermes integration sequence
Failure handling
Timeout behavior
Retry behavior
Storage schema
Telemetry schema
Configuration structure
Security boundaries
Deployment topology
Docker/container topology
CPU/RAM estimates
Upgrade / migration strategy
Unit testing strategy
Integration testing strategy
Router benchmarking strategy
Rule replay strategy
Rollback strategy
```

---

# 51. Guiding Architecture Principle

The system should ultimately behave like an adaptive runtime:

```text
Novel / complex request
        ↓
      Hermes
        ↓
successful execution
        ↓
learn pattern
        ↓
compile repeated behavior
        ↓
cheap deterministic execution
```

The expected long-term effect is:

```text
More usage
   ↓
More learned patterns
   ↓
Higher cheap-path coverage
   ↓
Fewer unnecessary LLM calls
   ↓
Lower latency
Lower cost
More deterministic behavior
```

The architecture should optimize toward this behavior without sacrificing correctness, observability, or safety.

---

# 52. Final Product Vision

The Adaptive Cascade Dispatch Engine should transform Personal AI Control Plane from a simple AI orchestrator into a:

> Self-optimizing AI runtime.

Hermes remains the intelligence layer for novel, ambiguous, and complex problems.

The Control Plane gradually learns which tasks no longer require that intelligence and compiles those tasks into cheaper, faster, deterministic execution paths.

The system should therefore become more efficient as it is used, while retaining Hermes as the final fallback for anything that cannot be safely automated.