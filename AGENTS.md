# Agent operating boundaries

- Work on a feature branch and open a pull request; do not push directly to
  `main`, merge a pull request, approve a production Environment deployment, or
  bypass repository protections.
- Do not trigger production deployment or rollback. Do not remove or weaken the
  Gateway integration barrier in `scripts/deploy-via-gateway.sh` or
  `.github/workflows/deploy.yml`.
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
