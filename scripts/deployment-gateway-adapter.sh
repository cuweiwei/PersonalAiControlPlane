#!/usr/bin/env bash
set -euo pipefail
# No CLI arguments, staging authority, lock, backup or restore policy have been
# verified. Never replace this refusal with guessed privileged commands.
gateway_allowlisted() { return 78; }
gateway_validate() { return 78; }
gateway_backup() { return 78; }
gateway_deploy() { return 78; }
gateway_status() { return 78; }
gateway_rollback() { return 78; }
echo 'NEEDS_OPERATOR_RECOVERY: Gateway integration, project fence and validated backup/restore authority are unverified' >&2
exit 78
