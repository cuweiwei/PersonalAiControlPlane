# Agent operating boundaries

- Work on a feature branch and open a pull request; do not push directly to
  `main`, merge a pull request, approve a production Environment deployment, or
  bypass repository protections.
- Do not trigger production rollback or approve a production GitHub Environment.
  A production deployment may be initiated only after all of the following are
  documented and reviewed for the exact release: required local checks and CI
  pass on the exact commit; the immutable image and digest are bound to that
  commit; real Gateway identity/authentication, project fencing, staging/lock,
  backup and restore, running-digest/readiness, and rollback behavior have
  reviewed live evidence. State-changing rehearsals must use a named disposable
  target, never the production project. The user must explicitly authorize the
  exact commit, allowlisted project, and deployment action. Use only the approved
  GitHub CD and Gateway path; do not bypass or weaken the Gateway integration
  barrier in `scripts/deploy-via-gateway.sh` or `.github/workflows/deploy.yml`.
  The current adapter's exit 78 is evidence of refusal/fail-closed behavior only,
  not evidence that Gateway integration or project fencing works. No production
  workflow run is needed just to reconfirm that the workflow invokes the barrier;
  never bypass or remove the barrier to test it.
- Never read, print, copy into the repository, or commit GitHub Environment
  secret values, SSH private keys, NAS `.env` files, database contents, or raw
  production responses.
- Treat production NAS checks as read-only unless the user explicitly approves a
  named disposable target and the exact state-changing test. Never test deploy,
  restore, lock contention, or rollback against the production project.
- A successful local test or mock is not evidence of live Gateway, backup,
  restore, project-fencing, running-digest, or rollback behavior. Keep deployment
  fail-closed until each required live capability has reviewed evidence.
- Do not grant general root, raw Docker, broad filesystem access, or arbitrary
  privileged scripts to CI or a deployment identity.
