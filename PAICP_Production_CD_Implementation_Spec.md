# PersonalAiControlPlane — Production CD 實作規格（OpenCode 執行版）

> Implementation blueprint based on the `main` branch of `cuweiwei/PersonalAiControlPlane` inspected on 2026-10-26. **Not deployed and not production-ready until the Gateway adapter is completed and tested.** This is a specification, not evidence that its proposed workflow or scripts are present on GitHub; see `docs/production-cd-validation.md` for publication and verification status.


> **用途**：將本檔案放到 `PersonalAiControlPlane` Repository 根目錄，讓 OpenCode 在該工作區直接讀取並實作。此檔是實作需求與驗收標準，不是直接授權正式環境變更。
>
> **範圍**：GitHub Actions CI/CD + GitHub `production` Environment 人工核准 + GHCR 不可變映像 + Tailscale 安全連線 + NAS 既有 Deployment Gateway + Health / Readiness / Acceptance + 安全 Rollback。

## 0. OpenCode 工作指令與交付原則

OpenCode 執行時應以 **目前 checkout 的程式碼** 與本規格為依據，不可假定 2026-10-26 的 GitHub 內容至今完全未變；如有衝突先比對差異，採取最小風險修正並在結案報告說明。

### 必要工作（先分析，再修改，最後驗證）

- [ ] 盤點目前 `.github/workflows/ci.yml`、`compose.prod.yml`、`scripts/release-artifact.mjs`、`scripts/production-acceptance.mjs`、Release schema 與 Deployment Gateway 文件；標記現有能力與缺口。
- [ ] 保留原有 CI 測試及 GHCR publish，確保 PR 僅執行測試；只有 `main` 經 CI/Image 發行成功才可進入 Production Approval。
- [ ] 產生每次發行專屬的 `compose.prod.yml`（使用新發布的 **image digest**，非舊 digest、`latest` 或可變 tag），計算該檔 hash 後產出一致的 Release Manifest。**不可為每次發行改寫並 commit 正式環境 base Compose。**
- [ ] 實作/補齊 `.github/workflows/deploy.yml`：同一次成功 CI run 的 artifact 交接、`production` Environment 人工核准、最新 main SHA 檢查、production concurrency、環境憑證保護、Tailscale、SSH 嚴格驗證、部署證據保存。
- [ ] 提供 Release Bundle 校驗（Repo、Commit SHA、`PersonalAiControlPlane` 專案 ID、Image Digest、Compose SHA256、service allowlist）；驗證失敗必須在任何 NAS mutation 前停止。
- [ ] 僅使用現有 NAS root-owned `/usr/local/bin/deployment` Gateway；`validate → deploy → status` 的實際 CLI 語法與 staging allowlist **需先調查證實**。絕不可直接 `sudo docker`、繞過 Gateway、修改 sudoers、production root-owned Compose 或部署 Gateway。
- [ ] 部署前取得**一致、可還原且驗證過**的資料備份或由既有受允許的備份系統提供證據；如無合法可用的備份能力，CD 必須 fail closed。
- [ ] 部署後核對 Gateway 所觀測的 **running** Image Digest，以及 NAS loopback `http://127.0.0.1:9084` 上的 `/healthz`、`/readyz`、`/api/v2/acceptance`、`/api/v2/offices/office-1`，不可僅以 HTTP 200 或 Docker Running 當作成功。
- [ ] 嘗試部署後的失敗採用 Gateway 已授權的 rollback；需再次證實原 Image Digest 及 Health/Readiness/Acceptance；即使 rollback 成功，原 CD run 仍需為 FAILED。
- [ ] 資料庫 schema 不相容、備份不可用、回滾不可安全執行或 Gateway 回傳不明時，必須停止並回報 `NEEDS_OPERATOR_RECOVERY`，**不得虛報成功或硬切舊 Image**。
- [ ] 完成單元/整合測試及負向案例（錯誤 hash、錯誤 digest、stale SHA、Gateway 拒絕、health 失敗、rollback 失敗、同時部署）；若缺乏 NAS 權限可建立 mock adapter 測試，但不得宣稱 live verified。
- [ ] 產出操作與設定文件，列出 GitHub Environment/Secrets/Vars、Tailscale ACL/OAuth、NAS 最小權限 SSH、Gateway 接點、操作 Runbook、回滾程序及尚待使用者提供的外部設定。

### 執行授權與停止條件

**允許**：修改工作區檔案、執行本機測試、驗證 workflow/shell/script 語法、建立必要的 mock、準備 Git diff/PR。

**未授權**：替使用者啟用正式 CD、寫入 production Secrets、修改 NAS 管理權限、push/merge 到 `main`、實際 Production Deploy、真實 Rollback、刪除 production 資料。這些動作都需另外取得明確授權。

若無法從現有 NAS 資料取得完整 Gateway CLI/staging/backup/rollback 規格，應交付可測試的 **fail-closed scaffold** 與具體 blocking checklist，不可杜撰命令來「完成」功能。

### 最終交付（必須在 OpenCode 回覆中逐項說明）

1. 修改／新增的檔案與其設計理由，以及 `git diff --stat`。
2. 已執行的 check/typecheck/test/build、Workflow、腳本、mock 部署/回滾測試結果。
3. Release Bundle 的 `commitSha`、`imageDigest`、`composeSha256` 如何形成與被校驗。
4. GitHub Environment、Tailscale、NAS 權限等**需人工設定**的具體清單（不得要求把密鑰寫入 Repo）。
5. Gateway 介面是否真正核對、哪些部分仍為 fail-closed、哪些只是 mock verified。
6. 明確區分 `implemented_local` / `ci_verified` / `live_verified`，禁止把本機測試寫成真實 NAS 部署成功。

### Definition of Done

- [ ] PR checks 保持原樣或更嚴格，沒有讓 PR 發布 Production Image/觸發部署。
- [ ] `main` CI publish 一份可驗證的「Manifest + digest-pinned candidate Compose」，兩者 hash 一致。
- [ ] GitHub Production Approval 發生於 Tailscale 連線、部署憑證釋出之前。
- [ ] 未經核准、stale commit、無效 digest、allowlist 不符、備份失敗，一律不得改動 Production。
- [ ] 當 Gateway Adapter 未整合或權限不足時，Workflow 明確失敗且不旁路 Gateway。
- [ ] Health/Acceptance 驗證及 Rollback 路徑均有自動化測試證據。
- [ ] 正式 NAS live deploy/rollback 演練僅在使用者另外核准後實施。

---

## Decision

Use the current `ci.yml` for check/typecheck/test/build and immutable GHCR publication. Add `deploy.yml` as a reusable workflow called within the SAME CI run after its `image` job succeeds. Protect its `production` job with GitHub Environment required reviewers. Connect to NAS over ephemeral, narrowly authorized Tailscale and use only the existing root-owned `/usr/local/bin/deployment` authority for privileged changes. Keep `PersonalAiControlPlane` deployment independent of Hermes, ContextHub, and Radar.

## Files

- `.github/workflows/ci.yml`: proposed replacement of the existing file, preserving its original CI jobs, then adding release bundle and called deployment.
- `.github/workflows/deploy.yml`: reusable human-approved workflow, artifact validation, reject stale main, Tailscale/SSH, and release evidence.
- `scripts/render-release-compose.mjs`: creates digest-pinned `release-artifacts/compose.prod.yml` without modifying the checked-in base file.
- `scripts/verify-release-bundle.mjs`: validates manifest/source commit/target image/Compose hash before promotion.
- `scripts/deploy-via-gateway.sh`: scoped orchestration for staging, pre-change backup, deploy, digest verification, health checks and rollback.
- `scripts/deployment-gateway-adapter.sh`: intentionally failing adapter to fill in after verifying NAS Gateway's actual CLI syntax.

## Important correctness issue fixed in the proposal

The existing `compose.prod.yml` pins a pre-existing GHCR digest, while the existing CI publishes a new image and emits a manifest from the *old* Compose file. Publishing a new image and redeploying that unchanged Compose would not change the running digest. The proposed image job renders a candidate Compose referencing the *new image's returned immutable digest*, runs the existing `release-artifact.mjs` inside `release-artifacts/`, and computes its `composeSha256` on that exact candidate. Both matching files are uploaded as one artifact. The original source-controlled base Compose remains untouched.

## GitHub preparation

1. Repository Settings → Environments → New environment `production`.
2. Required reviewers: add the designated operator(s). Restrict deployments to `main`; enable prevention of self-review only if another reviewer can approve (for solo maintenance, enabling this may block all releases).
3. Environment **secrets**: `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`, `NAS_SSH_PRIVATE_KEY`, `NAS_SSH_KNOWN_HOSTS`.
4. Environment **variables**: `NAS_HOST` (Tailscale MagicDNS name resolvable from the action runner, e.g. `gnest`), `NAS_USER` (operator-authorized NAS deploy account, previously documented as `Tim`), `NAS_STAGING_DIR` (operator-confirmed unprivileged Gateway staging base directory; MUST be authorized by existing Gateway).
5. Configure a Tailscale OAuth client with `auth_keys` writable scope and tag `tag:github-cd`. Tailnet policy should allow this tag to reach only NAS SSH TCP port 22. Avoid broad NAS or subnet access. Example *illustrative* policy fragment (integrate with existing tailnet policy, do not replace it):

   ```json
   {
     "tagOwners": { "tag:github-cd": ["autogroup:admin"] },
     "grants": [ { "src": ["tag:github-cd"], "dst": ["tag:nas"], "ip": ["tcp:22"] } ]
   }
   ```

   This assumes the NAS is actually tagged `tag:nas` and your policy supports grants; otherwise use its real Tailscale identity and current policy syntax. Verify ACL results, not only key creation.
6. Provision a narrow SSH identity on NAS, with access to unprivileged staging and `sudo -n /usr/local/bin/deployment` ONLY as already authorized. Do not grant raw Docker, general root, arbitrary scripts, or broad filesystem permissions. Obtain the NAS host public key over an independent trusted channel and pin it as `NAS_SSH_KNOWN_HOSTS`; do not trust the result of one unauthenticated `ssh-keyscan`.
7. If GHCR visibility is private, ensure the NAS already has an appropriate read-only package credential before deployment.

GitHub Environment required reviewers protect job execution and Environment secrets on public repos on supported plans. A reviewer must approve **each job** awaiting deployment; approving an older commit is still blocked by the post-approval SHA check in this proposal.

## NAS Gateway integration checklist — BLOCKING

The public repository documents:

```bash
ssh -o BatchMode=yes Tim@gnest 'sudo -n /usr/local/bin/deployment list'
```

It also describes staged Compose `validate → deploy → status` and a Gateway rollback path, but it does **not** publish the precise CLI arguments, staging directory, status serialization, backup facility or rollback selector. Before replacing `scripts/deployment-gateway-adapter.sh`, inspect these **read-only** capabilities on NAS, as supported:

```bash
ssh -o BatchMode=yes Tim@gnest 'sudo -n /usr/local/bin/deployment list'
ssh -o BatchMode=yes Tim@gnest 'sudo -n /usr/local/bin/deployment --help'
```

Do not assume `--help` is supported; if it is not, consult your actual Gateway documentation/operator. Do not fabricate `validate`, `deploy`, `status`, `rollback` arguments.

Implement exactly six adapter contracts, each using only the Gateway or other already-authorized backup authority:

| Function | Required behavior |
|---|---|
| `gateway_allowlisted PROJECT` | Read `deployment list`, verify exact ID `PersonalAiControlPlane` and authorized staging root. |
| `gateway_validate PROJECT STAGED_COMPOSE` | Validate staged Compose via Gateway, verify it meets image policy; no production changes. |
| `gateway_backup PROJECT` | Return nonempty **validated consistent** backup reference of active state, particularly SQLite. If current Gateway does not back up, use your approved existing backup authority or block CD. |
| `gateway_deploy PROJECT STAGED_COMPOSE` | Use existing Gateway to deploy the verified staged Compose; never call privileged Docker directly. |
| `gateway_status PROJECT` | Return normalized JSON `{ "runningImageDigest": "sha256:<64 hex>", "state": "healthy" }` derived from *observed running* version. Do not report desired version as actual. |
| `gateway_rollback PROJECT PREVIOUS_DIGEST` | Use only authorized Gateway rollback; first enforce schema/data compatibility and verified restoration policy. Return failure if rollback cannot safely restore. |

**Rollback data compatibility:** Even if previous image is available, a schema migration may prevent safe downgrading. The adapter MUST refuse automatic rollback for incompatible migrations, and report `NEEDS_OPERATOR_RECOVERY` rather than attaching an old image to new incompatible data. A SQLite backup must be consistent (online SQLite backup or quiesced/snapshot process), and restoration requires replay/effect/idempotency reconciliation; a basic file copy is not sufficient.

The adapter intentionally returns exit status 78 for all functions until completed. The `deploy.yml` is therefore a verified *scaffold*, not a ready-to-enable production deployer.

## Health and promotion gates

1. Before mutation: exact allowlist, manifest SHA and Compose hash, current main head, previous running digest, pre-deployment backup proof, staging validation.
2. Deploy: Gateway only; set `DEPLOY_STARTED=1` before issuing the Gateway command.
3. Running state: Gateway must show actual running image digest equals the release manifest image digest.
4. Application: via SSH *on NAS loopback* (the current `compose.prod.yml` binds `127.0.0.1:9084:8080`), require HTTP 200 JSON `/healthz` and `/readyz`, `/api/v2/acceptance` (ready true, no recovery/unknown slots), and `/api/v2/offices/office-1` with schemaReady true.
5. Failure after attempted deployment: try authorized Gateway rollback to the previous observed digest, repeat acceptance, require the observed digest again equals previous; regardless of rollback success, the GitHub job remains FAILED. Failed/unverifiable rollback is an incident needing an operator.
6. Upload non-secret evidence as a GitHub Actions artifact. Never log secrets, database contents, provider credentials, or unredacted private state.

Optional second-stage probes: real Worker/Hermes and cross-service checks when their dependencies are guaranteed available; do not falsely treat simple `/healthz` success as proof of end-to-end AI task execution.

## Risk and failure cases

| Failure | Expected outcome |
|---|---|
| PR test failure | No Image/CD |
| Image publish failure | No CD |
| Approval rejected | No NAS connection/change |
| Stale approval for older SHA | Rejected before Tailscale/SSH |
| Tailscale/SSH/auth failure | No deployment |
| Allowlist/staging/validate/backup failure | No production mutation |
| Deploy/status/health failure | Controlled Gateway rollback attempt; original CD run FAIL |
| Gateway rollback or data incompatibility | Stop and report operator recovery; never fake success |
| Concurrent production approvals | GitHub concurrency plus Gateway-side project lock/fence; no overlapping actual mutations |

## Rollout sequence

- Phase 0: verify Gateway CLI and staging policy, restore a real SQLite backup in a staging test, and complete/test `deployment-gateway-adapter.sh`.
- Phase 1: merge the CI artifact fix and verify the candidate Compose references the correct published digest.
- Phase 2: enable the `production` GitHub Environment and attach Secrets/Variables.
- Phase 3: perform a no-op or same-digest staging validation rehearsal; inspect actual Gateway status and application acceptance evidence.
- Phase 4: deploy one real commit with manual approval and confirm running digest and Worker reconnect behavior.
- Phase 5: intentionally deploy a bad health-check candidate in a disposable environment and verify automatic rollback and recorded incident evidence.

## Verification status

The earlier blueprint underwent local static/synthetic checks; **OpenCode must rerun all checks against the current working tree**, report the actual results, and treat the Gateway as unintegrated until its real interface is verified. No GitHub Environment secret values or NAS `.env` contents are included or inspected. Later read-only Gateway observations and their limits are recorded in `docs/production-cd-validation.md`; this specification itself does not authorize production changes.

## Authoritative references

- Existing CI: https://github.com/cuweiwei/PersonalAiControlPlane/blob/main/.github/workflows/ci.yml
- Existing Compose: https://github.com/cuweiwei/PersonalAiControlPlane/blob/main/compose.prod.yml
- Existing release script: https://github.com/cuweiwei/PersonalAiControlPlane/blob/main/scripts/release-artifact.mjs
- Existing acceptance script: https://github.com/cuweiwei/PersonalAiControlPlane/blob/main/scripts/production-acceptance.mjs
- Gateway restrictions: https://github.com/cuweiwei/PersonalAiControlPlane/blob/main/docs/personal-ai-platform-v2-detailed-design.md
- GitHub deployment approvals: https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments
- Tailscale GitHub Action: https://tailscale.com/docs/integrations/github/github-action

## 7. 補充：與先前 Blueprint 套件的關係

先前提供的 `PersonalAiControlPlane-CD-Blueprint.zip` 是參考 scaffold，包含提議的 `ci.yml`、`deploy.yml`、三個 Release / Deploy scripts 與一個預設拒絕執行的 Gateway adapter。**本 MD 是實作規格的主要依據**；若 OpenCode 的工作區有該 ZIP，可以參考但必須審查所有實作、測試並因應現有 Repo 調整；沒有 ZIP 也應能依本文件完成，不可把 ZIP 當成必要依賴。

為避免將未核准的實驗流程直接接上 Production，建議先提交 PR 以執行 CI / 靜態測試，待 Gateway contract、GitHub Environment、Tailscale ACL 和備份還原演練皆確認後，再另行核准啟用正式部署。
