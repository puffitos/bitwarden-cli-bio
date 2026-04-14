#!/usr/bin/env bash
# bwbio-wsl-bridge — start a socat+npiperelay bridge so bwbio can reach the
# Bitwarden Desktop app (Windows named pipe) from inside WSL2.
#
# Usage:
#   bwbio-wsl-bridge          # start the bridge (idempotent)
#   bwbio-wsl-bridge --stop   # stop a running bridge
#   bwbio-wsl-bridge --status # show whether the bridge is active
#   bwbio-wsl-bridge --pipe   # print the computed pipe name and exit
#
# Add to ~/.bashrc or ~/.profile to auto-start each session:
#   bwbio-wsl-bridge

set -euo pipefail

SOCK="${XDG_RUNTIME_DIR:-$HOME/.cache/bwbio}/bwbio-bridge.sock"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

die() { echo "error: $*" >&2; exit 1; }

check_wsl() {
  grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null \
    || die "This script is only needed inside WSL."
}

require_cmd() {
  command -v "$1" &>/dev/null \
    || die "'$1' not found. ${2:-}"
}

get_windows_home() {
  # 1. USERPROFILE is set in interactive WSL sessions launched from Windows Terminal
  if [[ -n "${USERPROFILE:-}" ]]; then
    printf '%s' "$USERPROFILE"
    return
  fi
  # 2. Scan /mnt/c/Users/ for the first non-system entry
  local win_user
  win_user=$(ls /mnt/c/Users/ 2>/dev/null \
    | grep -vE "^(All Users|Default|Default User|Public|desktop\.ini)$" \
    | head -1)
  [[ -n "$win_user" ]] || die "Could not determine Windows home directory. Set USERPROFILE manually (e.g. export USERPROFILE='C:\\Users\\YourName')."
  printf 'C:\\Users\\%s' "$win_user"
}

compute_pipe_name() {
  local win_home="$1"
  printf '%s' "$win_home" | node -e "
    const c = require('crypto');
    let d = '';
    process.stdin.on('data', b => d += b);
    process.stdin.on('end', () => {
      const h = c.createHash('sha256').update(d).digest()
        .toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      console.log(h + '.s.bw');
    });
  "
}

bridge_running() {
  ss -lx 2>/dev/null | grep -qF "$SOCK"
}

# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

cmd_stop() {
  local pids
  mapfile -t pids < <(pgrep -f "socat.*bwbio-bridge" 2>/dev/null || true)
  if [[ ${#pids[@]} -gt 0 ]]; then
    kill "${pids[@]}" 2>/dev/null
    echo "Bridge stopped (pid ${pids[*]})."
  else
    echo "No bridge running."
  fi
  rm -f "$SOCK"
}

cmd_status() {
  if bridge_running; then
    local pids
    mapfile -t pids < <(pgrep -f "socat.*bwbio-bridge" 2>/dev/null || true)
    echo "Bridge is running (pid ${pids[*]:-?}, socket $SOCK)."
  else
    echo "Bridge is not running."
  fi
}

cmd_pipe() {
  local win_home pipe_name
  win_home=$(get_windows_home)
  pipe_name=$(compute_pipe_name "$win_home")
  echo "$pipe_name"
}

cmd_start() {
  check_wsl
  require_cmd node   "Install Node.js >= 22."
  require_cmd socat  "Install socat: sudo apt install socat"
  require_cmd npiperelay.exe \
    "Install npiperelay on Windows: winget install jstarks.npiperelay (or scoop install npiperelay), then ensure it is on the Windows PATH (accessible from WSL)."

  if bridge_running; then
    echo "Bridge already running."
    return
  fi

  local win_home pipe_name
  win_home=$(get_windows_home)
  pipe_name=$(compute_pipe_name "$win_home")

  mkdir -p "$(dirname "$SOCK")"
  rm -f "$SOCK"

  socat \
    "UNIX-LISTEN:$SOCK,fork" \
    EXEC:"npiperelay.exe -ei -ep -s //./pipe/$pipe_name",nofork \
    &>/dev/null &
  disown

  # Wait briefly and verify the socket appeared
  local i=0
  while [[ $i -lt 10 ]]; do
    bridge_running && break
    sleep 0.1
    (( i++ )) || true
  done

  if bridge_running; then
    echo "Bridge started (pipe: $pipe_name)"
  else
    die "Bridge failed to start. Run with BWBIO_VERBOSE=true for more detail."
  fi
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

case "${1:-}" in
  --stop)   cmd_stop   ;;
  --status) cmd_status ;;
  --pipe)   cmd_pipe   ;;
  "")       cmd_start  ;;
  *)        die "Unknown argument '$1'. Usage: bwbio-wsl-bridge [--stop|--status|--pipe]" ;;
esac
