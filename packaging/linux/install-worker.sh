#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: install-worker.sh [origin] [data-directory] [worker-executable] [log-directory]

Installs the Personal AI Worker for the current Linux user and configures a
user-level systemd service. CUA Driver requires a supported graphical desktop
session; the installer never enables systemd linger or runs the driver as root.
EOF
}

die() { echo "install-worker: $*" >&2; exit 1; }
systemd_quote() {
  local value=${1//%/%%}
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  printf '"%s"' "$value"
}
as_root() {
  if (( EUID == 0 )); then "$@"; else command -v sudo >/dev/null 2>&1 || die "sudo is required to install CUA Driver system libraries"; sudo "$@"; fi
}

if [[ $# -gt 4 ]]; then usage; exit 2; fi
[[ "$(uname -s)" == "Linux" ]] || die "this installer only supports Linux"

origin=${1:-https://gnest.taila77e5f.ts.net}
data_directory=${2:-"$HOME/.local/share/personal-ai-worker"}
worker_executable=${3:-"$data_directory/bin/pai-worker"}
log_directory=${4:-"$HOME/.local/state/personal-ai-worker"}
repository=${PAI_WORKER_REPOSITORY:-https://github.com/cuweiwei/PersonalAiControlPlane}
source_ref=${PAI_WORKER_REF:-main}
node_version=${PAI_NODE_VERSION:-22.19.0}
omlx_enabled=${PAI_OMLX_ENABLED:-true}
omlx_api_key_file=${PAI_OMLX_API_KEY_FILE:-"$HOME/.omlx/settings.json"}
lmstudio_enabled=${PAI_LMSTUDIO_ENABLED:-true}
ollama_enabled=${PAI_OLLAMA_ENABLED:-true}
cua_enabled=${PAI_CUA_ENABLED:-true}
cua_driver_executable=${PAI_CUA_DRIVER_EXECUTABLE:-"$HOME/.local/bin/cua-driver"}
cua_driver_socket=${PAI_CUA_DRIVER_SOCKET:-"${XDG_RUNTIME_DIR:-$HOME/.cache}/cua-driver.sock"}
cua_driver_mode=${PAI_CUA_DRIVER_MODE:-mcp}
cua_driver_version=${PAI_CUA_DRIVER_VERSION:-}
refresh_source=${PAI_WORKER_REFRESH_SOURCE:-true}
worker_unit=personal-ai-worker.service
driver_unit=cua-driver.service

for value in "$origin" "$data_directory" "$worker_executable" "$log_directory" "$repository" "$source_ref" "$node_version" "$omlx_enabled" "$omlx_api_key_file" "$lmstudio_enabled" "$ollama_enabled" "$cua_enabled" "$cua_driver_executable" "$cua_driver_socket" "$cua_driver_mode" "$cua_driver_version" "$refresh_source"; do
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || die "arguments must not contain newlines"
done
[[ "$omlx_enabled" == "true" || "$omlx_enabled" == "false" ]] || die "PAI_OMLX_ENABLED must be true or false"
[[ "$lmstudio_enabled" == "true" || "$lmstudio_enabled" == "false" ]] || die "PAI_LMSTUDIO_ENABLED must be true or false"
[[ "$ollama_enabled" == "true" || "$ollama_enabled" == "false" ]] || die "PAI_OLLAMA_ENABLED must be true or false"
[[ "$cua_enabled" == "true" || "$cua_enabled" == "false" ]] || die "PAI_CUA_ENABLED must be true or false"
[[ "$cua_driver_mode" == "mcp" || "$cua_driver_mode" == "cli" ]] || die "PAI_CUA_DRIVER_MODE must be mcp or cli"
[[ "$cua_driver_version" == "" || "$cua_driver_version" =~ ^[A-Za-z0-9._-]+$ ]] || die "PAI_CUA_DRIVER_VERSION contains unsupported characters"
[[ "$refresh_source" == "true" || "$refresh_source" == "false" ]] || die "PAI_WORKER_REFRESH_SOURCE must be true or false"
[[ "$data_directory" != "/" && "$data_directory" != "$HOME" ]] || die "data directory must be a dedicated Worker directory"
[[ "$data_directory" == /* && "$worker_executable" == /* && "$log_directory" == /* ]] || die "Worker data, executable, and log paths must be absolute"
[[ "$cua_driver_executable" == /* && "$cua_driver_socket" == /* ]] || die "CUA executable and socket paths must be absolute"

case "$(uname -m)" in
  x86_64|amd64) node_arch=x64 ;;
  aarch64|arm64) node_arch=arm64 ;;
  *) die "unsupported Linux architecture: $(uname -m)" ;;
esac
if [[ "$cua_enabled" == "true" && "$node_arch" != "x64" ]]; then
  cua_enabled=false
  echo "warning: Linux CUA is disabled on $(uname -m); the supported CUA Driver Linux desktop installer currently targets x86_64" >&2
fi

script_path=${BASH_SOURCE[0]:-}
script_directory=""
local_source_root=""
if [[ -n "$script_path" && "$script_path" != /dev/fd/* ]]; then
  script_directory=$(cd -- "$(dirname -- "$script_path")" && pwd)
  local_source_root=$(cd -- "$script_directory/../.." && pwd)
fi
cached_source_root="$data_directory/source"
has_worker_source() {
  [[ -f "$1/package.json" && -f "$1/package-lock.json" && -f "$1/apps/worker/src/cli.ts" && -f "$1/packaging/linux/install-worker.sh" ]]
}

tmp_directory=$(mktemp -d "${TMPDIR:-/tmp}/pai-worker-install.XXXXXX")
cleanup() { rm -rf "$tmp_directory"; }
trap cleanup EXIT

source_candidate=""
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
  [[ -n "$archive_root" && "$archive_root" =~ ^[A-Za-z0-9._-]+$ ]] || die "downloaded Worker source archive has an invalid root"
  tar -xzf "$archive" -C "$tmp_directory"
  source_candidate="$tmp_directory/$archive_root"
  has_worker_source "$source_candidate" || die "downloaded source does not contain a Linux Worker installer"
  source_root=$source_candidate
fi

node_version_ok() {
  local binary=$1
  "$binary" -e 'const [major, minor, patch] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && (minor > 19 || (minor === 19 && patch >= 0))) ? 0 : 1)' >/dev/null 2>&1
}
node_binary=${PAI_NODE_BINARY:-}
if [[ -z "$node_binary" ]]; then node_binary=$(command -v node 2>/dev/null || true); fi
if [[ -z "$node_binary" ]]; then
  managed_node="$data_directory/node-v${node_version}/bin/node"
  [[ -x "$managed_node" ]] && node_binary=$managed_node
fi
install_node=0
if [[ -z "$node_binary" ]] || ! node_version_ok "$node_binary"; then
  install_node=1
else
  export PATH="$(dirname -- "$node_binary"):$PATH"
  command -v npm >/dev/null 2>&1 || install_node=1
fi
if systemctl --user is-active --quiet "$worker_unit" 2>/dev/null; then
  worker_journal="$data_directory/worker.db"
  [[ -f "$worker_journal" ]] || die "Worker service is running but its journal is missing; refusing to replace live Worker files"
  [[ -n "$node_binary" && -x "$node_binary" ]] || die "Worker service is running but no Node.js binary is available to check its local journal"
  probe="$tmp_directory/active-attempts.cjs"
  cat > "$probe" <<'EOF'
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[2], { readOnly: true });
try { console.log(db.prepare("SELECT COUNT(*) AS count FROM assignments WHERE status IN ('ACCEPTED','RUNNING')").get().count); }
finally { db.close(); }
EOF
  active_attempts=$("$node_binary" "$probe" "$worker_journal")
  [[ "$active_attempts" =~ ^[0-9]+$ ]] || die "Worker journal returned an invalid active-attempt count"
  (( active_attempts == 0 )) || die "Worker has $active_attempts active attempt(s); let them finish before reinstalling"
  systemctl --user stop "$worker_unit"
  active_attempts=$("$node_binary" "$probe" "$worker_journal")
  (( active_attempts == 0 )) || die "Worker received new work while stopping; journal still contains $active_attempts active attempt(s)"
fi
if (( install_node )); then
  command -v curl >/dev/null 2>&1 || die "curl is required to install Node.js"
  command -v tar >/dev/null 2>&1 || die "tar is required to install Node.js"
  command -v sha256sum >/dev/null 2>&1 || die "sha256sum is required to verify Node.js"
  node_archive="node-v${node_version}-linux-${node_arch}.tar.xz"
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
  printf '%s  %s\n' "$node_expected_checksum" "$node_archive_path" | sha256sum -c -
  tar -xJf "$node_archive_path" -C "$tmp_directory"
  [[ -x "$tmp_directory/node-v${node_version}-linux-${node_arch}/bin/node" ]] || die "downloaded Node.js archive is incomplete"
  rm -rf "$node_root"
  mv "$tmp_directory/node-v${node_version}-linux-${node_arch}" "$node_root"
  node_binary="$node_root/bin/node"
fi
node_version_ok "$node_binary" || die "Node.js ${node_binary} is older than the required 22.19.0"
node_bin_directory=$(dirname -- "$node_binary")
export PATH="$node_bin_directory:$PATH"
npm_binary=$(command -v npm 2>/dev/null || true)
[[ -n "$npm_binary" ]] || die "npm was not found beside Node.js"

if [[ "$cua_enabled" == "true" ]]; then
  if command -v dpkg-query >/dev/null 2>&1; then
    missing_packages=()
    for package in libxi6 at-spi2-core; do
      package_state=$(dpkg-query -W -f='${db:Status-Status}' "$package" 2>/dev/null || true)
      [[ "$package_state" == installed ]] || missing_packages+=("$package")
    done
    if (( ${#missing_packages[@]} > 0 )); then
      echo "Installing CUA Driver Linux runtime dependencies: ${missing_packages[*]}"
      as_root apt-get update
      as_root apt-get install -y --no-install-recommends "${missing_packages[@]}"
    fi
  else
    echo "note: run cua-driver doctor after installation; install your distribution's libXi and AT-SPI 2 packages if it reports missing dependencies" >&2
  fi
  if [[ ! -x "$cua_driver_executable" ]]; then
    command -v curl >/dev/null 2>&1 || die "curl is required to install CUA Driver"
    cua_installer="$tmp_directory/cua-driver-install.sh"
    echo "Downloading the official CUA Driver installer"
    curl --fail --location --silent --show-error --retry 3 https://cua.ai/driver/install.sh -o "$cua_installer"
    if [[ -n "$cua_driver_version" ]]; then
      CUA_DRIVER_RS_VERSION="$cua_driver_version" /bin/bash "$cua_installer"
    else
      /bin/bash "$cua_installer"
    fi
  fi
  [[ -x "$cua_driver_executable" ]] || die "CUA Driver installer completed but executable was not found: $cua_driver_executable"
  command -v systemctl >/dev/null 2>&1 || die "systemd user services are required to keep CUA Driver available"
  systemctl --user show-environment >/dev/null 2>&1 || die "no systemd user manager is available; run this installer from the signed-in graphical Linux account"
  mkdir -p "$(dirname -- "$cua_driver_socket")" "$HOME/.config/systemd/user"
  chmod 700 "$(dirname -- "$cua_driver_socket")"
  import_environment=()
  for name in DISPLAY WAYLAND_DISPLAY XAUTHORITY XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS XDG_SESSION_TYPE XDG_CURRENT_DESKTOP; do
    [[ -n "${!name-}" ]] && import_environment+=("$name")
  done
  if (( ${#import_environment[@]} > 0 )); then systemctl --user import-environment "${import_environment[@]}"; fi
  cat > "$HOME/.config/systemd/user/$driver_unit" <<EOF
[Unit]
Description=Cua Driver desktop daemon for Personal AI Worker
After=graphical-session.target
PartOf=graphical-session.target

[Service]
Type=simple
ExecStart=$(systemd_quote "$cua_driver_executable") serve --socket $(systemd_quote "$cua_driver_socket")
Restart=on-failure
RestartSec=2

[Install]
WantedBy=graphical-session.target
EOF
  chmod 600 "$HOME/.config/systemd/user/$driver_unit"
  systemctl --user daemon-reload
  systemctl --user enable --now "$driver_unit"
  if systemctl --user is-active --quiet "$driver_unit"; then
    "$cua_driver_executable" doctor || echo "warning: CUA Driver doctor found desktop readiness issues; see the diagnostics above" >&2
    "$cua_driver_executable" status || echo "warning: CUA Driver service is not ready; inspect journalctl --user -u $driver_unit" >&2
  else
    echo "warning: CUA Driver service did not start; inspect journalctl --user -u $driver_unit" >&2
  fi
fi

if [[ -n "$source_candidate" ]]; then
  mkdir -p "$data_directory"
  if [[ -e "$cached_source_root" ]]; then
    source_backup="$data_directory/source.previous.$(date +%s)"
    mv "$cached_source_root" "$source_backup"
  fi
  if mv "$source_candidate" "$cached_source_root"; then
    source_root=$cached_source_root
    [[ -z "${source_backup:-}" ]] || rm -rf "$source_backup"
  else
    [[ -z "${source_backup:-}" ]] || mv "$source_backup" "$cached_source_root"
    die "could not replace the Worker source; the prior source was restored"
  fi
fi

echo "Installing Worker dependencies"
"$npm_binary" ci --prefix "$source_root"
mkdir -p "$(dirname -- "$worker_executable")" "$data_directory" "$log_directory" "$HOME/.config/systemd/user"
printf -v node_shell '%q' "$node_binary"
printf -v cli_shell '%q' "$source_root/apps/worker/src/cli.ts"
cat > "$worker_executable" <<EOF
#!/bin/sh
exec $node_shell --experimental-strip-types $cli_shell "\$@"
EOF
chmod 700 "$worker_executable"

worker_unit_path="$HOME/.config/systemd/user/$worker_unit"
cat > "$worker_unit_path" <<EOF
[Unit]
Description=Personal AI Worker
After=default.target

[Service]
Type=simple
WorkingDirectory=$(systemd_quote "$data_directory")
ExecStart=$(systemd_quote "$worker_executable") start --origin $(systemd_quote "$origin") --data-dir $(systemd_quote "$data_directory")
Environment=$(systemd_quote "PAI_OMLX_ENABLED=$omlx_enabled")
Environment=$(systemd_quote "PAI_OMLX_API_KEY_FILE=$omlx_api_key_file")
Environment=$(systemd_quote "PAI_LMSTUDIO_ENABLED=$lmstudio_enabled")
Environment=$(systemd_quote "PAI_OLLAMA_ENABLED=$ollama_enabled")
Environment=$(systemd_quote "PAI_CUA_ENABLED=$cua_enabled")
Environment=$(systemd_quote "PAI_CUA_DRIVER_EXECUTABLE=$cua_driver_executable")
Environment=$(systemd_quote "PAI_CUA_DRIVER_SOCKET=$cua_driver_socket")
Environment=$(systemd_quote "PAI_CUA_DRIVER_MODE=$cua_driver_mode")
Environment=$(systemd_quote "PAI_WORKER_LOG=$log_directory/worker.log")
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
chmod 600 "$worker_unit_path"
systemctl --user daemon-reload
systemctl --user enable --now "$worker_unit"
systemctl --user is-active --quiet "$worker_unit" || die "Worker systemd service did not start; inspect journalctl --user -u $worker_unit"

echo "Worker installed and started: $worker_unit"
echo "Origin: $origin"
echo "Data: $data_directory"
echo "Logs: journalctl --user -u $worker_unit"
if [[ "$cua_enabled" == "true" ]]; then
  echo "CUA Driver service: $driver_unit"
  echo "CUA socket: $cua_driver_socket"
  echo "Open $origin/workers and Grant computer.use after reviewing the Worker capability."
fi
echo "Open $origin/workers and approve the pending enrollment request if this is a new Worker identity."
