# Local Production CD verification — 2026-10-26

## Verification scope

- `implemented_local`: yes, release/workflow policy and mock controller.
- `ci_verified`: no; no GitHub Actions run performed.
- `live_read_only`: partial; pinned SSH, Gateway list/status and archive checks ran.
- `application_restore_verified`: no; only an isolated SQLite integrity check ran.
- `production_deploy_or_rollback`: not performed.
- Production integration remains blocked by the exit-78 Gateway adapter.

## Results

| Check | Actual result |
|---|---|
| `npm run check` | PASS: 46 implementation files, 8 sources, 5 schemas |
| `npm run typecheck` | PASS |
| `node --test test/production-cd.test.mjs test/release-artifact.test.ts` | PASS: 19/19 |
| `npm test` | 137 tests: 132 PASS, 4 FAIL, 1 SKIP |
| `npm run build:web` | PASS; existing >500 kB chunk warning |
| actionlint 1.7.7, both workflow files | PASS, exit 0; ShellCheck integration disabled (not installed) |
| Git Bash `bash -n`, each new shell file | PASS, exit 0 |
| Execute deployment barrier locally | PASS: actual exit 78 and `NEEDS_OPERATOR_RECOVERY` |
| `git diff --check` | PASS; only Windows LF/CRLF conversion warnings |
| Pinned SSH + Gateway `list` | PASS: exact project `PersonalAiControlPlane` is allowlisted |
| Gateway `status` | PARTIAL: healthy container and digest-pinned image reference reported; no independent runtime digest readback |
| 2026-09-17 and 2026-09-21 archive checksums | PASS |
| 2026-09-21 isolated archive extraction + SQLite `integrity_check` | PASS for `identity.db` and `controlplane.db`; not an application restore |
| Backup completeness / cross-database and artifact consistency | NOT VERIFIED; archive artifact directory was empty and live data scope is unresolved |
| Project lock/fencing and contention behavior | NOT VERIFIED; no safe disposable Gateway target or documented lock contract |
| Rollback safety | NOT VERIFIED; no production rollback or application-level disposable rollback drill |

Remaining full-suite failures are existing Windows platform assumptions in
`codex-executor.test.ts` and `opencode-executor.test.ts` (`spawn mkdir ENOENT`),
and macOS/Linux installer tests (`URL.pathname` produces `C:\C:\...`). Hermes
boundary test is skipped because `HERMES_SOURCE_ROOT` is not configured.
No tests were removed or skipped to produce the CD result. Windows path handling
in the existing check script and release artifact tests was corrected using
`fileURLToPath`; the two old release tests now pass.

New tests exercise the actual renderer → manifest generator → verifier CLI
pipeline in temporary directories; base Compose remains unchanged. Other
deployment scenarios use in-memory mocks, including project fence contention.
These do not establish actual Gateway command compatibility, NAS backup
consistency, application restoration safety or cross-process locking.

## Live read-only evidence — 2026-10-26

- Strict host-key checking succeeded using the dedicated SSH identity. Gateway
  `list` included `PersonalAiControlPlane`.
- Gateway `status` reported the service healthy (`Up 6 days`) and the immutable
  image reference `ghcr.io/cuweiwei/personal-ai-control-plane@sha256:6387c05891bdaffd817565a175ef30ab431c4a9d437accecdd6296101af1d794`, matching
  the checked-in base Compose. Since the status output is a `docker compose ps`
  table rather than an independent runtime-image inspection, the actual running
  digest remains a blocking verification item.
- The 2026-09-21 archive SHA-256 manifest passed. Its data tree was extracted to
  a private temporary directory on the NAS, without replacing or writing to live
  paths. SQLite `PRAGMA integrity_check` returned `ok` for `identity.db` and
  `controlplane.db`. The archive included the control-plane WAL/SHM files but
  had zero files in `data/artifacts/`; this does not prove the archive is current,
  complete, cross-database consistent, or restorable by the application.
- A 2026-09-17 archive checksum also passed. Later `attention-predeploy` backup
  directories were permission-denied to the deployment account and were not
  inspected via privilege escalation.
- Read-only inspection found no lock-like file in the staging directory at the
  inspected depth. No inference about Gateway-internal locks is valid from that
  observation. No concurrent deploy, production deploy, or rollback was run.
- The operator reports GitHub `production` secrets are configured; their values
  are not readable and no Actions run consumed them. No secret values or database
  contents were written to the repository.

Full local suite log:
`C:\Users\shohe\AppData\Local\Temp\opencode\paicp-cd-tests.log`.
Tool used: actionlint Windows binary downloaded to approved temporary tools
directory; not added to repository. No secrets or raw production responses were
captured. The source-controlled base Compose was not modified.

## Review summary

Changed existing files: CI workflow (least permissions + immutable bundle +
same-run reusable CD), release schema (images required), check script and release
test Windows paths, acceptance script (strict typed gates, no response-body
dump, safe absolute Hermes URL handling).

New files: reusable deploy workflow; release bundle renderer/verifier/shared
policy; fail-closed shell adapter and orchestration barrier; mock-tested
transaction controller and health contracts; CD test suite; operations runbook;
this validation report; supplied root implementation specification.

`git diff --stat` for existing tracked files (new files remain untracked, not
staged, and therefore are not included by this command):

```text
 .github/workflows/ci.yml                        | 28 ++++++++++++++++++++-----
 schemas/release/v1/release-manifest.schema.json |  2 +-
 scripts/check.mjs                               |  3 ++-
 scripts/production-acceptance.mjs               | 12 ++++++-----
 test/release-artifact.test.ts                   |  7 ++++---
 5 files changed, 37 insertions(+), 15 deletions(-)
```

See `production-cd-runbook.md` for the blocking Gateway evidence checklist. The
audit did not change production services or live data. It created and removed an
isolated temporary extraction of an older archive for SQLite integrity checks.
No GitHub Actions run, deploy, production rollback, or repository push/merge was
performed as part of this validation.
