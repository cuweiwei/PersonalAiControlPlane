#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: install-worker.sh [origin] [data-directory] [worker-executable] [log-directory]

Installs the Personal AI Worker for the current macOS user. All arguments are
optional; the defaults target the production Control Plane and a user-local
LaunchAgent. The script bootstraps the source checkout and Node.js when they
are not already available.
EOF
}

die() { echo "install-worker: $*" >&2; exit 1; }

if [[ $# -gt 4 ]]; then usage; exit 2; fi
[[ "$(uname -s)" == "Darwin" ]] || die "this installer only supports macOS"

origin=${1:-https://gnest.taila77e5f.ts.net}
data_directory=${2:-"$HOME/Library/Application Support/PersonalAiWorker"}
worker_executable=${3:-"$data_directory/bin/pai-worker"}
log_directory=${4:-"$HOME/Library/Logs/PersonalAiWorker"}
repository=${PAI_WORKER_REPOSITORY:-https://github.com/cuweiwei/PersonalAiControlPlane}
source_ref=${PAI_WORKER_REF:-main}
node_version=${PAI_NODE_VERSION:-22.19.0}
omlx_enabled=${PAI_OMLX_ENABLED:-true}
omlx_api_key_file=${PAI_OMLX_API_KEY_FILE:-"$HOME/.omlx/settings.json"}
refresh_source=${PAI_WORKER_REFRESH_SOURCE:-true}
label=com.personal-ai.worker

for value in "$origin" "$data_directory" "$worker_executable" "$log_directory" "$repository" "$source_ref" "$node_version" "$omlx_enabled" "$omlx_api_key_file" "$refresh_source"; do
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || die "arguments must not contain newlines"
done
[[ "$omlx_enabled" == "true" || "$omlx_enabled" == "false" ]] || die "PAI_OMLX_ENABLED must be true or false"
[[ "$refresh_source" == "true" || "$refresh_source" == "false" ]] || die "PAI_WORKER_REFRESH_SOURCE must be true or false"
[[ "$data_directory" != "/" && "$data_directory" != "$HOME" ]] || die "data directory must be a dedicated Worker directory"

script_path=${BASH_SOURCE[0]:-}
script_directory=""
local_source_root=""
if [[ -n "$script_path" ]]; then
  script_directory=$(cd -- "$(dirname -- "$script_path")" && pwd)
  local_source_root=$(cd -- "$script_directory/../.." && pwd)
fi
cached_source_root="$data_directory/source"
has_worker_source() {
  [[ -f "$1/package.json" && -f "$1/package-lock.json" && -f "$1/apps/worker/src/cli.ts" && -f "$1/packaging/macos/com.personal-ai.worker.plist" ]]
}

tmp_directory=$(mktemp -d "${TMPDIR:-/tmp}/pai-worker-install.XXXXXX")
cleanup() { rm -rf "$tmp_directory"; }
trap cleanup EXIT

if [[ -n "$local_source_root" ]] && has_worker_source "$local_source_root"; then
  source_root=$local_source_root
elif has_worker_source "$cached_source_root" && [[ "$refresh_source" == "false" ]]; then
  source_root=$cached_source_root
else
  command -v curl >/dev/null 2>&1 || die "curl is required to bootstrap the Worker source"
  command -v tar >/dev/null 2>&1 || die "tar is required to bootstrap the Worker source"
  archive="$tmp_directory/source.tar.gz"
  archive_url="${repository%/}/archive/${source_ref}.tar.gz"
  echo "Downloading Worker source: $archive_url"
  curl --fail --location --silent --show-error --retry 3 "$archive_url" -o "$archive"
  archive_root=$(tar -tzf "$archive" | awk -F/ 'NF { print $1; exit }')
  [[ -n "$archive_root" ]] || die "downloaded Worker source archive is empty"
  [[ "$archive_root" =~ ^[A-Za-z0-9._-]+$ ]] || die "downloaded Worker source archive has an unsafe root"
  tar -xzf "$archive" -C "$tmp_directory"
  has_worker_source "$tmp_directory/$archive_root" || die "downloaded source does not contain a Worker checkout"
  source_root="$cached_source_root"
  mkdir -p "$data_directory"
  if [[ -e "$source_root" ]]; then rm -rf "$source_root"; fi
  mv "$tmp_directory/$archive_root" "$source_root"
fi

node_version_ok() {
  local node_binary=$1
  "$node_binary" -e 'const [major, minor, patch] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && (minor > 19 || (minor === 19 && patch >= 0))) ? 0 : 1)' >/dev/null 2>&1
}

node_binary=${PAI_NODE_BINARY:-}
if [[ -z "$node_binary" ]]; then node_binary=$(command -v node 2>/dev/null || true); fi
install_node=0
if [[ -z "$node_binary" ]] || ! node_version_ok "$node_binary"; then
  install_node=1
else
  export PATH="$(dirname -- "$node_binary"):$PATH"
  command -v npm >/dev/null 2>&1 || install_node=1
fi
if (( install_node )); then
  command -v curl >/dev/null 2>&1 || die "curl is required to install Node.js"
  command -v tar >/dev/null 2>&1 || die "tar is required to install Node.js"
  command -v shasum >/dev/null 2>&1 || die "shasum is required to verify Node.js"
  case "$(uname -m)" in
    arm64) node_arch=arm64 ;;
    x86_64) node_arch=x64 ;;
    *) die "unsupported macOS architecture: $(uname -m)" ;;
  esac
  node_archive="node-v${node_version}-darwin-${node_arch}.tar.gz"
  node_base_url="https://nodejs.org/dist/v${node_version}"
  node_archive_path="$tmp_directory/$node_archive"
  node_checksums="$tmp_directory/SHASUMS256.txt"
  node_root="$data_directory/node-v${node_version}"
  mkdir -p "$data_directory"
  echo "Installing Node.js ${node_version} (${node_arch}) in the Worker data directory"
  curl --fail --location --silent --show-error --retry 3 "$node_base_url/$node_archive" -o "$node_archive_path"
  curl --fail --location --silent --show-error --retry 3 "$node_base_url/SHASUMS256.txt" -o "$node_checksums"
  node_expected_checksum=$(awk -v archive="$node_archive" '$2 == archive { print $1; exit }' "$node_checksums")
  [[ "$node_expected_checksum" =~ ^[0-9a-fA-F]{64}$ ]] || die "Node.js checksum is missing for $node_archive"
  printf '%s  %s\n' "$node_expected_checksum" "$node_archive_path" | shasum -a 256 -c -
  tar -xzf "$node_archive_path" -C "$tmp_directory"
  if [[ -e "$node_root" ]]; then rm -rf "$node_root"; fi
  mv "$tmp_directory/node-v${node_version}-darwin-${node_arch}" "$node_root"
  node_binary="$node_root/bin/node"
fi

node_version_ok "$node_binary" || die "Node.js ${node_binary} is older than the required 22.19.0"
node_bin_directory=$(dirname -- "$node_binary")
export PATH="$node_bin_directory:$PATH"
npm_binary=$(command -v npm 2>/dev/null || true)
[[ -n "$npm_binary" ]] || die "npm was not found beside Node.js"

echo "Installing Worker dependencies"
"$npm_binary" ci --prefix "$source_root"

if [[ $# -ge 3 ]]; then
  [[ -x "$worker_executable" ]] || die "worker executable is not executable: $worker_executable"
else
  mkdir -p "$(dirname -- "$worker_executable")"
  cat > "$worker_executable" <<EOF
#!/bin/sh
exec "$node_binary" --experimental-strip-types "$source_root/apps/worker/src/cli.ts" "\$@"
EOF
  chmod 700 "$worker_executable"
fi

template="$source_root/packaging/macos/com.personal-ai.worker.plist"
launch_agents="$HOME/Library/LaunchAgents"
plist_path="$launch_agents/$label.plist"
mkdir -p "$launch_agents" "$data_directory" "$log_directory"
escape_sed() { printf '%s' "$1" | sed 's/[\\&|]/\\&/g'; }
sed \
  -e "s|REPLACE_WORKER_EXECUTABLE|$(escape_sed "$worker_executable")|g" \
  -e "s|REPLACE_ORIGIN|$(escape_sed "$origin")|g" \
  -e "s|REPLACE_DATA_DIRECTORY|$(escape_sed "$data_directory")|g" \
  -e "s|REPLACE_OMLX_ENABLED|$(escape_sed "$omlx_enabled")|g" \
  -e "s|REPLACE_OMLX_API_KEY_FILE|$(escape_sed "$omlx_api_key_file")|g" \
  -e "s|REPLACE_LOG_PATH|$(escape_sed "$log_directory")|g" \
  "$template" > "$plist_path"
chmod 600 "$plist_path"
/usr/bin/plutil -lint "$plist_path" >/dev/null

uid=$(id -u)
/bin/launchctl bootout "gui/$uid/$label" >/dev/null 2>&1 || true
/bin/launchctl bootstrap "gui/$uid" "$plist_path"
/bin/launchctl kickstart -k "gui/$uid/$label"

echo "Worker installed and started: $label"
echo "Origin: $origin"
echo "Data: $data_directory"
echo "Logs: $log_directory"
echo "Open $origin/workers and approve the pending enrollment request."
