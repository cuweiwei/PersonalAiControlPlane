#!/usr/bin/env bash
set -euo pipefail
# Deliberate integration barrier: no staging upload or production mutation until
# actual Gateway lock/staging/backup/rollback contracts have been verified.
exec bash scripts/deployment-gateway-adapter.sh
