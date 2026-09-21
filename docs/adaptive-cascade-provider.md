# Adaptive Cascade 私有 HTTP Semantic Provider

本 provider 是 Adaptive Cascade 的可選 transport adapter。它只把已受限的 `RouteInput` 送到明確設定的 private HTTP endpoint，再把回應嚴格正規化成 `NormalizedMatch`；它不載入模型、不下載 BGE，也不改變 rule JSON。BGE-small 仍是尚未完成相容性、品質與 RSS 驗證的 reference implementation。

## 啟用邊界

預設不建立 provider。必須同時滿足下列條件，semantic tier 才可能被考慮：

1. `PAI_DISPATCH_SEMANTIC_PROVIDER=private-http`。
2. Control Plane 的 `dispatch_semantic_enabled` 開關為 true（預設 false）。
3. private endpoint、bundle descriptor、calibration profile 與 expiry 設定完整且通過 parser。
4. active release 的 `provider_bundles` 包含 descriptor 的 `bundleId`，`calibration_profiles` 包含回應的 profile ID。
5. provider 回應的 provenance 與 descriptor 及 active release 的 rule-set hash 完全相符。

設定不完整、profile 過期、endpoint 不是 private host 或回應無法驗證時，factory 回傳 `undefined` 或 provider 回 `ready=false`；DispatchService 因此 abstain/fallback。factory 只記錄不含 endpoint、token 或使用者文字的停用原因，不會把設定錯誤轉成遠端呼叫。

## 設定

下列設定透過環境變數提供。token 只放在目標 runtime 的 secret/environment，不要提交 Git 或貼到聊天。

| 變數 | 必須 | 說明 |
| --- | --- | --- |
| `PAI_DISPATCH_SEMANTIC_PROVIDER` | 是（啟用時） | 僅接受 `private-http`；省略、`off`、`none` 都是關閉 |
| `PAI_DISPATCH_SEMANTIC_PROVIDER_URL` | 是 | `http`/`https` URL；禁止 URL credentials、query、fragment；host 必須是 loopback、RFC1918/link-local、`.local`/`.internal`/`.lan` 或無 dot 的 private service name |
| `PAI_DISPATCH_SEMANTIC_PROVIDER_ID` | 否 | 預設 `private-http-v1` |
| `PAI_DISPATCH_SEMANTIC_MODEL_REVISION` | 否 | 可為 null；若提供，必須是 pinned identifier |
| `PAI_DISPATCH_SEMANTIC_RUNTIME_REVISION` | 是 | provider runtime revision |
| `PAI_DISPATCH_SEMANTIC_BUNDLE_ID` | 是 | immutable bundle identifier |
| `PAI_DISPATCH_SEMANTIC_BUNDLE_HASH` | 是 | `sha256:` 加 64 個 lowercase hex |
| `PAI_DISPATCH_SEMANTIC_CALIBRATION_PROFILE_ID` | 是 | pinned calibration profile identifier |
| `PAI_DISPATCH_SEMANTIC_CALIBRATION_EXPIRES_AT` | 是 | ISO-8601 或 epoch milliseconds；到期後 readiness 為 false |
| `PAI_DISPATCH_SEMANTIC_PRIVACY` | 否 | `LOCAL_ONLY`（預設）或 `TRUSTED_PRIVATE`；目前 DispatchService 只允許 `LOCAL_ONLY` 進入 semantic dispatch |
| `PAI_DISPATCH_SEMANTIC_PROVIDER_TOKEN` | 否 | 只放 secret/environment，使用 Bearer header |
| `PAI_DISPATCH_SEMANTIC_SUPPORTED_LANGUAGES` | 否 | 逗號分隔；預設 `ZH_DOMINANT` |
| `PAI_DISPATCH_SEMANTIC_MAX_BYTES` | 否 | request text bytes，上限 64 KiB，預設 8 KiB |
| `PAI_DISPATCH_SEMANTIC_MAX_TOKENS` | 否 | 傳給 provider 的 token budget，預設 128 |
| `PAI_DISPATCH_SEMANTIC_MAX_RESPONSE_BYTES` | 否 | response body hard limit，預設 32 KiB，上限 256 KiB |
| `PAI_DISPATCH_SEMANTIC_TIMEOUT_MS` | 否 | provider request 上限，預設 150 ms，上限 5 s |

這些設定只建立 adapter；它們不會自動修改 active release，也不會自動把 semantic 開關打開。若 private endpoint 使用 `TRUSTED_PRIVATE`，目前 policy 會保持 fallback，直到整條 CP privacy policy 明確允許該 locality。

## HTTP contract

Control Plane 以 `POST`、`content-type: application/json`、`accept: application/json` 呼叫 endpoint。request 使用 snake_case，並攜帶目前 release 的 rule-set hash，供 endpoint 避免用錯校準資料：

```json
{
  "schema_version": 1,
  "request_id": "opaque-request-id",
  "text": "ContextHub 還活著嗎？",
  "context": {"locale": "zh-TW", "language_class": "ZH_DOMINANT"},
  "candidate_intents": ["service.health_check"],
  "bundle_id": "private-bundle-v1",
  "deadline_at": 1789940000000,
  "max_tokens": 128,
  "rule_set_hash": "sha256:..."
}
```

回應必須是 JSON，不能有未定義欄位。所有字串、數值、候選 intent、alternative、response size 都有 bounded schema 檢查。成功 match 的最低 contract 是：

```json
{
  "schema_version": 1,
  "intent": "service.health_check",
  "abstain": false,
  "reason": "CALIBRATED_MATCH",
  "assurance": "HIGH",
  "calibrated_probability": 0.997,
  "calibration_profile_id": "calibration-v1",
  "alternatives": [],
  "provenance": {
    "provider_id": "private-router-v1",
    "model_revision": "router-model-v1",
    "bundle_id": "private-bundle-v1",
    "runtime_revision": "runtime-v1",
    "rule_set_hash": "sha256:...",
    "dataset_revision": "dataset-v1"
  }
}
```

`abstain=true` 時必須是 `intent=null`、`assurance=UNASSESSED`、probability/profile 為 null。`abstain=false` 時必須有 candidate set 內的 intent、`HIGH`、0 到 1 的 calibrated probability、設定的 profile ID，以及非空 dataset revision。provider ID、model revision、bundle ID、runtime revision 和 rule-set hash 都必須與 CP 目前 pinned facts 相等；raw cosine/logit 或 provider 自報的 `HIGH` 不能繞過這些檢查。

HTTP status 非 2xx、content type 非 JSON、malformed JSON/schema、unknown field、bundle/provenance/calibration mismatch、超過 response limit、timeout 或 abort 都會 fail closed。prepare 會回 Hermes；provider 不重試 semantic request。

## 驗證範圍

`test/dispatch-provider.test.ts` 使用 loopback Node HTTP stub 驗證：預設關閉與缺 profile、public endpoint 拒絕、request pinning、Bearer header、正常 normalization、unknown field、provenance/profile mismatch、response size、bundle mismatch、timeout 與 expiry。這些測試不下載模型，也不證明任何 BGE 精度、calibration precision、CPU/RSS、live private worker availability 或 channel E2E。
