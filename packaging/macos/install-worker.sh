#!/usr/bin/env bash
set -euo pipefail

if [[ $# -gt 4 ]]; then
  echo "usage: $0 [origin] [data-directory] [worker-executable] [log-directory]" >&2
  exit 2
fi

origin=${1:-https://gnest.taila77e5f.ts.net}
data_directory=${2:-"$HOME/Library/Application Support/PersonalAiWorker"}
worker_executable=${3:-/usr/local/bin/pai-worker}
log_directory=${4:-"$HOME/Library/Logs/PersonalAiWorker"}
label=com.personal-ai.worker
script_directory=$(cd "$(dirname "$0")" && pwd)
template="$script_directory/com.personal-ai.worker.plist"
launch_agents="$HOME/Library/LaunchAgents"
plist_path="$launch_agents/$label.plist"

for value in "$origin" "$data_directory" "$worker_executable" "$log_directory"; do
  if [[ "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
    echo "arguments must not contain newlines" >&2
    exit 2
  fi
done
if [[ ! -x "$worker_executable" ]]; then
  echo "worker executable is not executable: $worker_executable" >&2
  exit 1
fi
escape_sed() { printf '%s' "$1" | sed 's/[\\&|]/\\&/g'; }
mkdir -p "$launch_agents" "$data_directory" "$log_directory"
sed \
  -e "s|REPLACE_WORKER_EXECUTABLE|$(escape_sed "$worker_executable")|g" \
  -e "s|REPLACE_ORIGIN|$(escape_sed "$origin")|g" \
  -e "s|REPLACE_DATA_DIRECTORY|$(escape_sed "$data_directory")|g" \
  -e "s|REPLACE_LOG_PATH|$(escape_sed "$log_directory")|g" \
  "$template" > "$plist_path"
chmod 600 "$plist_path"
/usr/bin/plutil -lint "$plist_path" >/dev/null

uid=$(id -u)
/bin/launchctl bootout "gui/$uid/$label" >/dev/null 2>&1 || true
/bin/launchctl bootstrap "gui/$uid" "$plist_path"
/bin/launchctl kickstart -k "gui/$uid/$label"
echo "worker launch agent installed: $label"
echo "Control Web will show the request after the worker starts; approve it from Workers."
