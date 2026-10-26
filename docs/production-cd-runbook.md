# Production CD — integration blocked

## Status and authority

`implemented_local`: immutable candidate bundle generation/verification, reusable
approval workflow, mock transaction controller and strict HTTP acceptance.
`ci_verified`: not yet (no GitHub Actions run). Live read-only Gateway checks are
partially verified; production deployment, application-level restore, project
fencing, and rollback safety are not. No production deployment or rollback was
performed. Do not enable production CD by simply deleting the integration barrier.

The source specification is `PAICP_Production_CD_Implementation_Spec.md`.
Existing CI check/typecheck/test/build and Windows installer parsing are retained.
PRs cannot publish images or invoke CD. Only successful main CI/image jobs call
the reusable workflow in the same run. Package write permission is image-job only.

## Release provenance

Image output digest from build-push-action is the authoritative `imageDigest`.
`commitSha` is the full checkout/main push SHA. Renderer replaces exactly one
image in the checked-in base Compose, leaving that file untouched. Manifest is
generated with the candidate directory as working directory; `composeSha256`
hashes the exact uploaded candidate bytes. One same-run artifact contains both.
Verifier requires the expected repository/SHA/digest from workflow context,
exact project `PersonalAiControlPlane`, one allowlisted service/image, fixed
health paths, hash and exact candidate equivalence to the checked-out base.
Thus even a rehashed candidate cannot change ports, volumes or other services.

Approval occurs at job entry, before Tailscale/SSH credential steps. Stale main
is rejected via GitHub API before network connection. Concurrency serializes
Actions runs without cancellation; it does NOT replace a NAS project fence.

## BLOCKING Gateway evidence

Read-only checks on 2026-10-26 used the dedicated SSH key and independently
pinned host key with `StrictHostKeyChecking=yes`:

- `sudo -n /usr/local/bin/deployment list` succeeded and included the exact
  allowlisted project `PersonalAiControlPlane`.
- `sudo -n /usr/local/bin/deployment PersonalAiControlPlane status` returned a
  healthy container and an image reference pinned to
  `ghcr.io/cuweiwei/personal-ai-control-plane@sha256:6387c05891bdaffd817565a175ef30ab431c4a9d437accecdd6296101af1d794`.
  This reference matches the checked-in base Compose. The Gateway output is a
  `docker compose ps` table, not an independent machine-readable inspection of
  the running container's resolved image digest; treat actual running-digest
  verification as incomplete.
- The configured staging directory contained only `compose.prod.yml` and no
  visible lock-like entry at the inspected depth. This does not establish that
  the Gateway has no external lock, nor prove a lock's lease/fencing behavior.
- A 2026-09-21 data/config archive passed its recorded SHA-256 check. Its data
  tree was extracted to an isolated temporary directory (not over live data);
  SQLite `PRAGMA integrity_check` returned `ok` for `identity.db` and
  `controlplane.db`. The archive contained a `controlplane.db-wal`/SHM pair but
  its `data/artifacts/` directory had zero files. This is a file-level integrity
  check of an older archive, not a complete application restore or proof of
  cross-database/artifact consistency. A 2026-09-17 archive checksum also passed.
- The live data tree included SQLite WAL/SHM files; additional database files
  were present under the orchestrator data directory. The inspected archive did
  not establish a complete backup set for every live database. Later
  `attention-predeploy` backup directories were not readable by the SSH account;
  no privilege escalation was attempted.
- No production deploy, production rollback, or concurrent deploy/lock test was
  performed. `status` and `list` are the only live Gateway operations used.

Still required before integration:

1. Gateway/version documentation and machine-readable status that independently
   reports the observed running digest and health state.
2. Authorized staging ownership, immutable upload/finalize rules, and validation
   arguments (including protection against path/symlink races).
3. Gateway-side project lease/fencing held through backup/deploy/health/rollback;
   behavior on disconnect, lease expiry, external deployments and contention.
4. A current, consistent backup covering all required SQLite databases, WAL state,
   artifacts and configuration, with retention/access rules and a successful
   application-level restore drill in disposable staging.
5. Authorized rollback selector and compatibility policy for migrations, data
   restoration, external side effects, and replay/idempotency reconciliation.
6. A binding between the previous observed running digest and its validated
   restore point; a Compose backup alone is not sufficient rollback evidence.
7. NAS capability to perform bounded loopback HTTP probes and return sanitized
   JSON. No root Docker, arbitrary privileged scripts or sudoers changes.

Until these exist, all six shell adapter contracts refuse with exit 78 before
any upload/production change. The workflow barrier precedes Tailscale. The
Tailscale/SSH credentials are configured by the operator, but the workflow has
not consumed or verified them. No actual SSH deploy transport is wired; the mock
controller is NOT a NAS implementation.

## Integration contract / recovery

Connect the six Gateway functions to verified CLI only, and implement project
fence acquisition/release and `rollbackSafe` using existing authorized authority.
`scripts/deployment-controller.mjs` describes the tested transaction semantics:
stale check → fence → allowlist → observed previous digest → staged validation →
validated consistent restore-tested backup → stale recheck → attempted deploy →
observed digest → strict health. Backup failures prevent deploy.

Before issuing deploy the controller marks the attempt started, so uncertain
deploy errors still enter rollback policy. Schema/restore incompatibility blocks
rollback and yields `NEEDS_OPERATOR_RECOVERY`. A rollback must verify previous
running digest AND application acceptance; even successful rollback fails the
original promotion. Never switch to an old image against incompatible new data.
Lock release failures also require operator recovery.

Integrate `probeDeployment` with SSH-executed NAS-loopback requests to port 9084,
not runner loopback. All four HTTP responses must be 200 valid JSON: health and
ready `status=ok`, acceptance ready/service/office/recoveryMode=false and all
three unknown counts exactly numeric zero; office schemaReady=true. Missing
fields, redirects, timeouts and non-200 fail. Store bounded, sanitized outcomes
only; do not upload response bodies, database data or raw SSH/Gateway stderr.

After integration, replace the barrier with preflight capability verification,
connect Tailscale, pin SSH identity, then run the fenced transaction. Recheck main
after waiting for the NAS fence. Validate the bundle before staging AND verify
staged bytes through the Gateway. Add transport tests before authorizing rollout.
No arbitrary user-specified adapter executable should be accepted by CI.

## Operator configuration (do not put credentials in repository)

- Create GitHub `production` Environment with required reviewers, main-only
  deployment branch protection. Configure self-review rules suitable for team.
  Protect main/workflow changes with branch protection and review policy.
- Environment secrets: `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`,
  `NAS_SSH_PRIVATE_KEY`, `NAS_SSH_KNOWN_HOSTS` (trusted out-of-band host key).
- Environment variables: `NAS_HOST`, `NAS_USER`, `NAS_STAGING_DIR`; only wire
  these after exact Gateway staging/account contracts are verified.
- Tailscale OAuth auth_keys write scoped to `tag:github-cd`; ACL grants only
  that tag to actual NAS identity TCP 22. Verify both allowed and denied traffic.
- NAS identity may use only authorized staging and existing
  `sudo -n /usr/local/bin/deployment`; no raw Docker/general sudo.
- If GHCR is private, provision existing NAS read-only package authentication
  out of band; CI token is not a production pull credential.
- Establish restore drill evidence, schema compatibility/reconciliation policy,
  project fencing and incident owner before any activation.

## Rollout / incidents

First inspect Gateway read-only and restore a backup in disposable staging.
Review adapter/transport tests, then separately authorize PR/push and observe CI.
Verify Environment approval and stale-SHA rejection, run same-digest staging
rehearsal, and only with separate authorization perform a real deployment.
Exercise bad-health rollback in disposable infrastructure, not production.
On `NEEDS_OPERATOR_RECOVERY`, stop promotion, retain sanitized evidence, alert
the operator, inspect actual state through approved read-only interfaces; never
retry blindly or manually attach an old image to migrated data.

## Local validation

`node --test test/production-cd.test.mjs` covers real release CLI handoff,
hash/digest/repo/project/SHA tampering, stale SHA, allowlist/validate/backup
refusal, uncertain deploy, health failure, rollback success/failure/incompatible
schema/wrong digest, project concurrency and strict health contracts.
Mocks prove controller semantics only, not Gateway backup correctness or live
NAS compatibility. Run `actionlint` for both workflows and `bash -n` for shell
scripts, plus existing check/typecheck/test/build. Existing Windows-only baseline
test failures must not be presented as passing CI.
