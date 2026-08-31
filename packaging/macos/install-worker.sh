#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 5 ]]; then
  echo "usage: $0 <repo-id> <repo-path> [origin] [worker-executable] [log-directory]" >&2
  exit 2
fi

repo_id=$1
repo_path=$2
origin=${3:-https://gnest.taila77e5f.ts.net}
worker_executable=${4:-/usr/local/bin/pai-worker}
log_directory=${5:-"$HOME/Library/Logs/PersonalAiWorker"}
label=dev.aihome.personal-ai-worker
script_directory=$(cd "$(dirname "$0")" && pwd)
template="$script_directory/dev.aihome.personal-ai-worker.plist"
launch_agents="$HOME/Library/LaunchAgents"
plist_path="$launch_agents/$label.plist"

for value in "$repo_id" "$repo_path" "$origin" "$worker_executable" "$log_directory"; do
  if [[ "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
    echo "arguments must not contain newlines" >&2
    exit 2
  fi
done
if [[ ! -x "$worker_executable" ]]; then
  echo "worker executable is not executable: $worker_executable" >&2
  exit 1
fi
if [[ ! -d "$repo_path" ]]; then
  echo "repository path does not exist: $repo_path" >&2
  exit 1
fi

escape_sed() { printf '%s' "$1" | sed 's/[\\&|]/\\&/g'; }
mkdir -p "$launch_agents" "$log_directory"
sed \
  -e "s|REPLACE_WORKER_EXECUTABLE|$(escape_sed "$worker_executable")|g" \
  -e "s|REPLACE_ORIGIN|$(escape_sed "$origin")|g" \
  -e "s|REPLACE_REPO_ID|$(escape_sed "$repo_id")|g" \
  -e "s|REPLACE_REPO_PATH|$(escape_sed "$repo_path")|g" \
  -e "s|REPLACE_LOG_PATH|$(escape_sed "$log_directory")|g" \
  "$template" > "$plist_path"
chmod 600 "$plist_path"
/usr/bin/plutil -lint "$plist_path" >/dev/null

uid=$(id -u)
/bin/launchctl bootout "gui/$uid/$label" >/dev/null 2>&1 || true
/bin/launchctl bootstrap "gui/$uid" "$plist_path"
/bin/launchctl kickstart -k "gui/$uid/$label"
echo "worker launch agent installed: $label"
echo "Control Web will show the request after the worker starts; approve its fingerprint with Passkey."
